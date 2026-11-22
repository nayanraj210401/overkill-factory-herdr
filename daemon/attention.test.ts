import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { sh, startTicket, type Run } from "./runner.ts";
import { watchSessions } from "./cli.ts";
import { noteAttention } from "./attention.ts";

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"true\"]\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', 'feature', '2026-11-22T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run: (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: '{"address":"t1"}' } : sh(argv, cwd)) });
  const p = { dir, db: join(dir, "factory.db"), status: join(dir, "status.json") };
  // The agent's terminal as `hc get` reports it: alive, Claude in front, Herdr's agent status.
  const tick = (agent: string) => {
    const hc: Run = (argv) => argv[0] === "hc" && argv[1] === "get" ? { code: 0, out: JSON.stringify({ exit_code: null, pid: 1, foreground: { pid: 2 }, status: { app: "claude-code", state: agent } }) }
      : argv[0] === "gh" ? { code: 0, out: '{"state":"OPEN","body":"","assignees":[]}' } : sh(argv);
    const logs: string[] = [];
    watchSessions(db, p, hc, (s) => logs.push(s));
    return logs;
  };
  const ticket = () => db.query("SELECT state, stage, needs_kind, needs_text FROM ticket_lead WHERE id = 7").get() as any;
  return { db, tick, ticket };
}

test("an agent blocked on you in its terminal puts the ticket in Needs you until it moves on", () => {
  const s = setup();
  s.tick("working");
  expect(s.ticket()).toMatchObject({ state: "running", stage: "spec", needs_kind: null });
  expect(s.tick("blocked")).toContain("factory: #7's agent in t1 is waiting on you");
  expect(s.ticket()).toMatchObject({ state: "running", stage: "spec", needs_kind: "attention", needs_text: "Waiting on you in its terminal (t1): open it to answer" });
  expect(s.tick("blocked")).not.toContain("factory: #7's agent in t1 is waiting on you"); // said once
  s.tick("working"); // answered in the terminal
  expect(s.ticket()).toMatchObject({ state: "running", stage: "spec", needs_kind: null, needs_text: null });
});

test("attention never overwrites another need, and clears only its own", () => {
  const s = setup();
  s.db.query("UPDATE tickets SET needs_kind = 'question', needs_text = 'split?' WHERE id = 7").run();
  expect(noteAttention(s.db, { ticket: 7, terminal: "t1", waiting: true, now: "x" })).toBeNull();
  expect(noteAttention(s.db, { ticket: 7, terminal: "t1", waiting: false, now: "x" })).toBeNull();
  expect(s.ticket()).toMatchObject({ needs_kind: "question", needs_text: "split?" });
});
