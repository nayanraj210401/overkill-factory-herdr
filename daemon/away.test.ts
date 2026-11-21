import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, checkReady, sh, startTicket, type Run } from "./runner.ts";
import { startGroomed } from "./groom.ts";
import { setAway } from "./away.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";

function setup(away: string) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\nready: [budget]\naway: ${away}\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const run: Run = (a, c) => (a[0] === "hc" ? { code: 0, out: '{"address":"t1"}' } : sh(a, c));
  const add = (id: number, blueprint: string) =>
    db.query("INSERT INTO tickets (id, title, blueprint, state, groomed_at, updated_at) VALUES (?, 'x', ?, 'queued', ?, ?)").run(id, blueprint, `2026-11-21T10:0${id % 10}:00Z`, "2026-11-21T10:00:00Z");
  return { db, dir, repo, run, add, ticket: (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any };
}

test("away: only away.blueprints start, and the away budget caps the ready rule", () => {
  const { db, dir, repo, run, add, ticket } = setup("{ blueprints: [chore], budget: 1M/50k }");
  add(1, "feature"); add(2, "chore");
  setAway(db, true, "2026-11-21T10:10:00Z");
  expect(startGroomed(db, { dir, repo, run, now: "2026-11-21T10:11:00Z" })).toEqual([2]);
  db.query("UPDATE tickets SET tokens_in = 2000000 WHERE id = 2").run();
  expect(checkReady(db, { dir, repo, id: 2, run })[0]).toMatchObject({ rule: "budget", result: "fail", detail: "2000000/1000000 in, 0/50000 out (away cap)" });
  setAway(db, false, "2026-11-21T12:00:00Z");
  expect(checkReady(db, { dir, repo, id: 2, run })[0]).toMatchObject({ result: "pass" });
  expect(startGroomed(db, { dir, repo, run, now: "2026-11-21T12:01:00Z" })).toEqual([1]);
  expect(ticket(1).state).toBe("running");
});

test("away: a ticket that touches an away.never path parks at the end of its stage", () => {
  const { db, dir, repo, run, add, ticket } = setup('{ never: ["src/auth/**"] }');
  add(3, "chore");
  startTicket(db, { dir, repo, id: 3, run });
  setAway(db, true, "2026-11-21T10:10:00Z");
  const wt = ticket(3).worktree;
  mkdirSync(join(wt, "src/auth"), { recursive: true });
  writeFileSync(join(wt, "src/auth/session.ts"), "export {};\n"); // untracked counts too
  expect(advance(db, { dir, repo, id: 3, run })).toMatchObject({ parked: true, stage: "implement" });
  expect(ticket(3)).toMatchObject({ state: "parked", needs_text: "Touched src/auth/session.ts, which never runs while you're away" });
});

test("the digest lists what others decided while you were away, in status.json", () => {
  const { db } = setup("{}");
  expect(buildStatus(db).away).toBeNull();
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (5, 'daemon', 'opened PR #9', '2026-11-20T09:00:00Z')").run(); // before
  setAway(db, true, "2026-11-20T18:00:00Z");
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (5, 'daemon', 'updated PR #9', '2026-11-20T21:00:00Z')").run();
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (5, 'builder', 'C1 fix', '2026-11-20T22:00:00Z')").run();
  setAway(db, false, "2026-11-21T08:00:00Z");
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (5, 'daemon', 'merged PR #9', '2026-11-21T09:00:00Z')").run(); // after
  const s = buildStatus(db, new Date("2026-11-21T10:00:00Z"));
  expect(s.away).toEqual({ on: false, since: "2026-11-20T18:00:00Z", until: "2026-11-21T08:00:00Z", events: [
    { ticket: 5, who: "daemon", what: "updated PR #9", at: "2026-11-20T21:00:00Z" },
    { ticket: 5, who: "builder", what: "C1 fix", at: "2026-11-20T22:00:00Z" },
  ] });
  expect(validateStatus(s)).toEqual([]);
  expect(() => setAway(db, false, "x")).toThrow("you aren't away");
});
