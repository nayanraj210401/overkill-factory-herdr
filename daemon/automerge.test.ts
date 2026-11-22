import { agentlessPr } from "./test-env.ts";
import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, autoMerge, startTicket, sh, tryPr, type Run } from "./runner.ts";
import { request, proposeAccount, applyMerged } from "./maintainer.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { gateWarnings } from "./validate.ts";

const GOOD_PR = "Tidies the logs; nothing else changes.\n\n**What changed:** logs.\n**Why:** noise.\n**How it was verified:** tests.\n**Risk:** low.\n";
const T0 = "2026-11-21T10:00:00Z";

// A chore ticket at its merge gate, the gate set to `gate` (auto unless told).
function setup(gate = "auto", factoryYaml = 'name: t\nquality_floor: ["true"]\nready: [evidence, quality_floor, template, budget, holdout]\n') {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true }); agentlessPr(join(repo, ".factory"));
  const bp = join(repo, ".factory/blueprints/chore.yaml");
  writeFileSync(bp, readFileSync(bp, "utf8").replace("gate: human", `gate: ${gate}`));
  rmSync(join(repo, ".factory/blueprints/factory.yaml"));
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const gh: string[][] = [];
  const run: Run = (argv, cwd) =>
    argv[0] === "hc" ? { code: 0, out: '{"address":"t1"}' }
    : argv[0] === "gh" ? (gh.push(argv), { code: 0, out: "https://github.com/acme/api/pull/42\n" })
    : sh(argv, cwd);
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Tidy the logs', 'chore', ?)").run(T0);
  startTicket(db, { dir, repo, id: 7, run });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  const toGate = () => {
    writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
    advance(db, { dir, repo, id: 7, run });
    if (ticket().state !== "ready") tryPr(db, { dir, repo, id: 7, run });
  };
  let n = 0;
  const log: string[] = [];
  // Each attempt a minute after the last, so the throttle never gets in the way.
  const auto = () => autoMerge(db, { dir, repo, run, now: new Date(Date.parse(T0) + 3_600_000 + ++n * 61_000).toISOString(), commit: (fn) => db.transaction(fn)(), log: (l) => log.push(l) });
  const merges = () => gh.filter((a) => a[2] === "merge");
  return { db, dir, repo, run, gh, ticket, toGate, auto, log, merges };
}

test("a merge stage on gate: auto merges the ready PR itself, the way m does, and says so", () => {
  const s = setup();
  s.toGate();
  expect(s.ticket()).toMatchObject({ state: "ready", stage: "merge", pr_number: 42, detail: "merges itself (gate: auto)" });
  s.gh.length = 0;
  expect(s.auto()).toEqual([7]);
  expect(s.gh).toEqual([["gh", "pr", "ready", "42"], ["gh", "pr", "merge", "42", "--squash"]]);
  expect(s.ticket()).toMatchObject({ state: "merged", pr_watched: 0 });
  expect(s.log).toContain("factory: #7: merged automatically (gate: auto)");
  expect(s.db.query("SELECT who, what FROM decisions WHERE ticket = 7 AND what LIKE 'merged%' ORDER BY id").all()).toEqual([
    { who: "daemon", what: "merged PR #42" }, { who: "daemon", what: "merged automatically (gate: auto)" }]);
  expect(s.auto()).toEqual([]); // nothing left to merge
});

test("the human gate is unchanged: the daemon never merges it", () => {
  const s = setup("human");
  s.toGate();
  expect(s.ticket()).toMatchObject({ state: "ready", stage: "merge", detail: "waiting on you" });
  expect(s.auto()).toEqual([]);
  expect(s.merges()).toHaveLength(0);
  expect(s.ticket().state).toBe("ready");
});

test("auto never merges while a ready rule fails, a round is open, the ticket is over budget or a comment is escalated", () => {
  const s = setup();
  s.toGate();
  // a ready rule: new evidence that fails
  s.db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (7, 'tests', 'FAIL', ?)").run(new Date(Date.now() + 120_000).toISOString());
  expect(s.auto()).toEqual([]);
  expect(s.ticket().detail).toMatch(/^auto merge waits for you: ready rule evidence fails/);
  s.db.query("DELETE FROM evidence WHERE ticket = 7 AND result = 'FAIL'").run();
  // a review round still open
  s.db.query("INSERT INTO review_rounds (ticket, round, started_at, tokens_in, tokens_out) VALUES (7, 1, ?, 0, 0)").run(T0);
  expect(s.auto()).toEqual([]);
  expect(s.ticket().detail).toBe("auto merge waits for you: a review round is open");
  s.db.query("UPDATE review_rounds SET closed_at = ?").run(T0);
  // an escalated comment
  s.db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, place, body, at, verdict, reason, round) VALUES (7, 1, 42, 'i1', 'i1', 'sam', null, 'hm', ?, 'escalate', 'product call', 1)").run(T0);
  expect(s.auto()).toEqual([]);
  expect(s.ticket().detail).toBe("auto merge waits for you: unresolved review comments: C1 (escalated)");
  s.db.query("DELETE FROM comments").run();
  // over budget, with the budget rule left out of ready: it blocks all the same
  const own = setup("auto", 'name: t\nquality_floor: ["true"]\nready: [evidence]\n');
  own.toGate();
  own.db.query("UPDATE tickets SET tokens_in = 99000000 WHERE id = 7").run();
  expect(own.auto()).toEqual([]);
  expect(own.ticket().detail).toMatch(/^auto merge waits for you: over budget/);
  expect(s.merges().length + own.merges().length).toBe(0);
  // all clear: it merges
  expect(s.auto()).toEqual([7]);
  expect(s.merges()).toHaveLength(1);
});

test("a failing gh merge leaves the ticket ready and is tried again a minute later; m still works", () => {
  const s = setup();
  s.toGate();
  let failing = true;
  const run: Run = (argv, cwd) => (failing && argv[2] === "merge" ? { code: 1, out: "not mergeable" } : s.run(argv, cwd));
  const at = (min: number) => new Date(Date.parse(T0) + 3_600_000 + min * 60_000).toISOString();
  const go = (min: number) => autoMerge(s.db, { dir: s.dir, repo: s.repo, run, now: at(min), commit: (fn) => s.db.transaction(fn)() });
  expect(go(1)).toEqual([]);
  expect(s.ticket()).toMatchObject({ state: "ready", detail: "auto merge failed: gh pr merge failed: not mergeable" });
  failing = false;
  expect(go(1)).toEqual([]); // inside the minute: not asked again
  expect(go(3)).toEqual([7]);
  expect(s.ticket().state).toBe("merged");
});

test("maintainer.gate: auto merges a maintainer request, and the account config applies on that merge", () => {
  const s = setup("human", 'name: t\nquality_floor: ["true"]\nmaintainer: { gate: auto }\n');
  const { id } = request(s.db, { text: "Never push to main", repo: "acme/api", run: s.run, now: T0, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now: new Date(Date.now() + 60_000).toISOString() });
  writeFileSync(proposeAccount(s.dir, id), "profile: { rules: [never push to main] }\n");
  writeFileSync(join(s.dir, "tickets", String(id), "PR.md"), "Adds a rule.\n\n## What changed\n- x\n## Why\nx\n## How it was verified\nx\n## Risk\nLow.\n");
  advance(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now: new Date(Date.now() + 60_000).toISOString() });
  expect(s.db.query("SELECT state, stage, pr_number FROM ticket_lead WHERE id = ?").get(id)).toEqual({ state: "ready", stage: "merge", pr_number: null });
  expect(s.auto()).toEqual([id]);
  applyMerged(s.db, { dir: s.dir, run: s.run, now: T0 });
  expect(readFileSync(join(process.env.FACTORY_HOME!, "config.yaml"), "utf8")).toBe("profile: { rules: [never push to main] }\n");
  expect(s.db.query("SELECT state FROM tickets WHERE id = ?").get(id)).toEqual({ state: "merged" });
});

test("validate warns when a gate is auto, and never refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-"));
  const bp = join(dir, "blueprints/chore.yaml");
  mkdirSync(join(dir, "blueprints"));
  writeFileSync(bp, "name: chore\nstart: a\nstages:\n  a: { agent: builder, next: [approve] }\n  approve: { gate: auto, next: [merge] }\n  merge: { gate: auto, next: [end] }\n");
  const w = gateWarnings("blueprints/chore.yaml", bp);
  expect(w).toHaveLength(2);
  expect(w[0]).toContain("stages.approve.gate is auto: this stage passes without you");
  expect(w[1]).toContain("ready PRs of this blueprint merge themselves");
  expect(w[1]).toContain("revert rate on Home");
  writeFileSync(bp, "name: chore\nstart: a\nstages:\n  a: { agent: builder, next: [merge] }\n  merge: { gate: human, next: [end] }\n");
  expect(gateWarnings("blueprints/chore.yaml", bp)).toEqual([]);
  writeFileSync(join(dir, "factory.yaml"), "name: t\nmaintainer: { gate: auto }\n");
  expect(gateWarnings("factory.yaml", join(dir, "factory.yaml"))[0]).toContain("maintainer.gate is auto");
});

test("status lists a blueprint on auto with its revert rate for Home, and a human gate lists nothing", () => {
  const s = setup();
  const status = buildStatus(s.db);
  expect(status.auto_gates).toEqual([{ blueprint: "chore", merged: 0, reverted: 0, revert_rate: 0 }]);
  const now = new Date();
  const merged = (id: number, reverted: number | null) => {
    s.db.query("INSERT INTO tickets (id, title, blueprint, state, reverted_by, updated_at) VALUES (?, 'x', 'chore', 'merged', ?, ?)").run(id, reverted, now.toISOString());
    s.db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', 'merged PR #1', ?)").run(id, now.toISOString());
  };
  merged(20, null); merged(21, null); merged(22, null); merged(23, 99);
  const after = buildStatus(s.db, now);
  expect(after.auto_gates).toEqual([{ blueprint: "chore", merged: 4, reverted: 1, revert_rate: 0.25 }]);
  expect(validateStatus(after)).toEqual([]);
  expect(buildStatus(setup("human").db).auto_gates).toBeUndefined();
});
