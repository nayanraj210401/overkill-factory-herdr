import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, runCheck, sh, startTicket, type Run } from "./runner.ts";
import { watchSessions } from "./cli.ts";
import { recordVerdict } from "./ready.ts";
import { existsSync, readFileSync } from "node:fs";

function setup(blueprint = "feature", floor = '"true"') {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true, filter: (p) => !p.endsWith("triggers/maintenance.yaml") }); // no daily maintenance ticket in these ticks
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: [${floor}]\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let n = 0;
  const started: string[] = [];
  const run: Run = (argv, cwd) => {
    if (argv[0] !== "hc") return sh(argv, cwd);
    started.push(argv[argv.indexOf("factory.stage=" + argv.find((a) => a.startsWith("factory.stage="))!.split("=")[1])].split("=")[1]);
    return { code: 0, out: `{"address":"t${++n}"}` };
  };
  db.query(`INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', ?, '2026-11-21T10:00:00Z')`).run(blueprint);
  startTicket(db, { dir, repo, id: 7, run });
  const step = (failed?: string) => advance(db, { dir, repo, id: 7, run, failed });
  const ticket = () => db.query("SELECT state, stage, retries, needs_text FROM ticket_lead WHERE id = 7").get() as any;
  const evidence = (name: string, result: "PASS" | "FAIL") =>
    db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (7, ?, ?, '2026-11-21T10:00:00Z')").run(name, result);
  const verdict = (kind: "holdout" | "review", result: "PASS" | "FAIL", detail: string | null = null) =>
    recordVerdict(db, { id: 7, kind, result, detail, now: new Date().toISOString() });
  return { db, dir, repo, run, step, ticket, evidence, verdict, started };
}

test("a feature ticket walks its agents, passes the evidence check, and waits at pr", () => {
  const { step, ticket, evidence, verdict, started, db } = setup();
  expect(step()).toMatchObject({ stage: "plan", terminal: "t2" });
  expect(step()).toMatchObject({ stage: "implement", terminal: "t3" });
  evidence("C1", "PASS");
  expect(step()).toMatchObject({ stage: "holdout", terminal: "t4" }); // verify ran in between and passed
  verdict("holdout", "PASS");
  expect(step()).toMatchObject({ stage: "review", terminal: "t5" });
  verdict("review", "PASS");
  expect(step()).toMatchObject({ stage: "pr", terminal: "t6" }); // the pr-writer agent writes PR.md
  expect(step()).toMatchObject({ stage: "pr", waiting: true });   // then the ready rules decide; no PR.md yet
  expect(started).toEqual(["spec", "plan", "implement", "holdout", "review", "pr"]);
  expect(ticket()).toMatchObject({ state: "running", stage: "pr" });
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get() as any).n).toBe(0);
  expect((db.query("SELECT result, detail FROM evidence WHERE check_name = 'evidence'").get() as any)).toEqual({ result: "PASS", detail: "2 checks pass" }); // its own run of the quality floor, and the one before
});

test("a failing check goes back to on_fail, then parks after max_retries", () => {
  const { step, ticket, evidence } = setup();
  step(); step(); // plan, implement
  evidence("C1", "FAIL");
  expect(step()).toMatchObject({ stage: "implement" });
  expect(ticket().retries).toBe(1);
  step(); step(); // retries 2, 3
  expect(ticket().retries).toBe(3);
  expect(step()).toMatchObject({ parked: true, stage: "verify" });
  expect(ticket()).toMatchObject({ state: "parked", needs_text: "Verify failed 4 times: evidence check failed" });
});

test("a reviewer's blockers go to REVIEW.md and back to implement; a reviewer with no verdict fails too", () => {
  const { step, ticket, evidence, verdict, dir } = setup();
  step(); step(); evidence("C1", "PASS"); step(); // plan, implement, verify → holdout
  verdict("holdout", "PASS");
  expect(step()).toMatchObject({ stage: "review" });
  verdict("review", "FAIL", "the limit key is the raw email");
  expect(step()).toMatchObject({ stage: "implement" });
  expect(ticket().retries).toBe(1);
  const review = readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8");
  expect(review).toContain("Blocked in review");
  expect(review).toContain("- the limit key is the raw email\n");
  step(); verdict("holdout", "PASS"); // implement → verify (passes, resetting the check's counter) → holdout
  expect(step()).toMatchObject({ stage: "review" });
  expect(step()).toMatchObject({ stage: "implement" }); // ended without a verdict
  expect(ticket().retries).toBe(2); // review's own count survives verify's reset
  step(); verdict("holdout", "PASS"); step();
  verdict("review", "FAIL", "still raw");
  expect(step()).toMatchObject({ stage: "implement" });
  step(); verdict("holdout", "PASS"); step();
  verdict("review", "FAIL", "still raw");
  expect(step()).toMatchObject({ parked: true, stage: "review" });
  expect(ticket().needs_text).toBe("Review failed 4 times: review: still raw");
});

test("the tests check runs quality_floor in the worktree and records each command", () => {
  const pass = setup("chore", '"true"');
  expect(pass.step()).toMatchObject({ stage: "pr", terminal: "t2" }); // implement → verify(tests) → pr's writer
  expect(pass.step()).toMatchObject({ stage: "pr", waiting: true });
  const fail = setup("chore", '"echo boom; exit 3"');
  expect(fail.step()).toMatchObject({ stage: "implement" });
  const row = fail.db.query("SELECT result, detail FROM evidence ORDER BY id DESC LIMIT 1").get() as any;
  expect(row).toEqual({ result: "FAIL", detail: "exit 3: boom" });
});

test("the daemon advances a ticket whose agent's terminal exited", () => {
  const { db, dir } = setup();
  const logs: string[] = [];
  const p = { dir, db: join(dir, "factory.db"), status: join(dir, "status.json") };
  let gets = 0;
  const hc: Run = (argv) => argv[1] === "get" ? (gets++, { code: 0, out: '{"exit_code":0}' }) : argv[0] === "hc" && argv[1] === "read" ? { code: 0, out: "" } : argv[1] === "run" ? { code: 0, out: '{"address":"t9"}' } : argv[0] === "gh" ? { code: 0, out: "{\"state\":\"OPEN\",\"body\":\"\",\"assignees\":[]}" } : sh(argv);
  watchSessions(db, p, hc, (s) => logs.push(s));
  expect(gets).toBe(1);
  expect(logs[0]).toBe("factory: #7's agent in t1 finished; advanced");
  expect((db.query("SELECT stage FROM ticket_lead").get() as any).stage).toBe("plan");
});

test("blockers a reviewer gave aren't written twice when the fix stage's agent fails to start", () => {
  const { db, dir, repo, step, evidence, verdict, run } = setup();
  step(); step(); evidence("C1", "PASS"); step(); verdict("holdout", "PASS"); step(); // → review
  verdict("review", "FAIL", "raw email key");
  const down: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 1, out: "down" } : run(argv, cwd));
  expect(() => db.transaction(() => advance(db, { dir, repo, id: 7, run: down }))()).toThrow("hc run failed");
  expect(existsSync(join(dir, "tickets/7/REVIEW.md"))).toBe(false);
  expect(step()).toMatchObject({ stage: "implement" });
  expect(readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8").match(/raw email key/g)).toHaveLength(1);
});

test("the evidence check runs the quality floor itself, and its own earlier failure never keeps it failing", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "factory-")), "factory.db"));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (1, 't', 'feature', '2026-11-21T10:00:00Z')").run();
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true, filter: (p) => !p.endsWith("triggers/maintenance.yaml") }); // no daily maintenance ticket in these ticks
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let pass = false;
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: [bun test]\n");
  const calls: string[][] = [];
  const run: Run = (argv) => (calls.push(argv), argv.includes("bun test") ? { code: pass ? 0 : 1, out: pass ? "3 pass" : "1 fail" } : { code: 0, out: "" });
  const check = (now: string) => runCheck(db, { id: 1, repo, worktree: repo, check: "evidence", run, now });
  expect(check("2026-11-21T10:01:00Z")).toBe(false); // the tests fail
  // The command runs with bun's own folder on its PATH, as a launchd daemon's minimal PATH lacks it.
  expect(calls[0].slice(0, 2)).toEqual(["env", expect.stringContaining(`PATH=${dirname(process.execPath)}:`)]);
  pass = true;
  expect(check("2026-11-21T10:02:00Z")).toBe(true);  // fixed: the floor ran again, and the earlier FAIL of evidence itself doesn't count
  expect(db.query("SELECT check_name, result FROM evidence ORDER BY id").all()).toEqual([
    { check_name: "bun test", result: "FAIL" }, { check_name: "evidence", result: "FAIL" },
    { check_name: "bun test", result: "PASS" }, { check_name: "evidence", result: "PASS" },
  ]);
});
