import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { watchSessions } from "./cli.ts";

function setup(blueprint = "feature", floor = '"true"') {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: [${floor}]\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setMeta(db, "repo_path", repo);
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
  const ticket = () => db.query("SELECT state, stage, retries, needs_text FROM tickets WHERE id = 7").get() as any;
  const evidence = (name: string, result: "PASS" | "FAIL") =>
    db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (7, ?, ?, '2026-11-21T10:00:00Z')").run(name, result);
  return { db, dir, repo, run, step, ticket, evidence, started };
}

test("a feature ticket walks its agents, passes the evidence check, and waits at pr", () => {
  const { step, ticket, evidence, started, db } = setup();
  expect(step()).toMatchObject({ stage: "plan", terminal: "t2" });
  expect(step()).toMatchObject({ stage: "implement", terminal: "t3" });
  evidence("C1", "PASS");
  expect(step()).toMatchObject({ stage: "review", terminal: "t4" }); // verify ran in between and passed
  expect(step()).toMatchObject({ stage: "pr", waiting: true });
  expect(started).toEqual(["spec", "plan", "implement", "review"]);
  expect(ticket()).toMatchObject({ state: "running", stage: "pr" });
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get() as any).n).toBe(0);
  expect((db.query("SELECT result, detail FROM evidence WHERE check_name = 'evidence'").get() as any)).toEqual({ result: "PASS", detail: "1 checks pass" });
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

test("the tests check runs quality_floor in the worktree and records each command", () => {
  const pass = setup("chore", '"true"');
  expect(pass.step()).toMatchObject({ stage: "pr", waiting: true }); // implement → verify(tests) → pr
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
  const hc: Run = (argv) => argv[1] === "get" ? (gets++, { code: 0, out: '{"exit_code":0}' }) : argv[1] === "run" ? { code: 0, out: '{"address":"t9"}' } : sh(argv);
  watchSessions(db, p, hc, (s) => logs.push(s));
  expect(gets).toBe(1);
  expect(logs[0]).toBe("factory: #7's agent in t1 finished; advanced");
  expect((db.query("SELECT stage FROM tickets").get() as any).stage).toBe("plan");
});
