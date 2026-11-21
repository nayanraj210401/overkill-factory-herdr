import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { advance, sh, startTicket, tryPr, type Run } from "./runner.ts";
import { readyRules, templateProblems } from "./ready.ts";

const GOOD_PR = "Rate-limits login per user; nothing else changes.\n\n**What changed:** middleware.\n**Why:** brute force.\n**How it was verified:** 14 tests.\n**Risk:** low.\n";

function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [evidence, quality_floor, template, budget, holdout]\n');
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setMeta(db, "repo_path", repo);
  const gh: string[][] = [];
  // Real git (pushing to a local bare repo); hc and gh are faked.
  const run: Run = (argv, cwd) =>
    argv[0] === "hc" ? { code: 0, out: '{"address":"t1"}' }
    : argv[0] === "gh" ? (gh.push(argv), { code: 0, out: "https://github.com/me/demo/pull/42\n" })
    : sh(argv, cwd);
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run });
  const prFile = join(dir, "tickets/7/PR.md");
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  return { db, dir, repo, origin, run, gh, prFile, ticket: () => db.query("SELECT * FROM tickets WHERE id = 7").get() as any };
}

test("the template rule wants one plain sentence, then the reviewer's fields", () => {
  expect(templateProblems(GOOD_PR)).toEqual([]);
  expect(templateProblems(readFileSync(join(import.meta.dir, "../fixtures/acme-api/tickets/409/PR.md"), "utf8"))).toEqual([]);
  expect(templateProblems(null)).toEqual(["PR.md is missing"]);
  expect(templateProblems("# Title\n**What changed:** x\n")).toEqual([
    "PR.md must open with one plain sentence", 'PR.md has no "Why"', 'PR.md has no "How it was verified"', 'PR.md has no "Risk"',
  ]);
});

test("the pr stage waits while a rule fails, then pushes the branch and opens a draft PR", () => {
  const { db, dir, repo, origin, run, gh, prFile, ticket } = setup();
  expect(advance(db, { dir, repo, id: 7, run })).toMatchObject({ stage: "pr", waiting: true }); // implement → verify → pr
  expect(ticket().detail).toBe("4 of 5 ready rules · template: PR.md is missing");
  writeFileSync(prFile, GOOD_PR);
  const r = tryPr(db, { dir, repo, id: 7, run });
  expect(r).toMatchObject({ pr: 42, ready: true, stage: "merge" });
  expect(ticket()).toMatchObject({ state: "ready", pr_number: 42, pr_watched: 1, stage: "merge" });
  expect(sh(["git", "-C", origin, "branch", "--list", "factory/7-rate-limit-login"]).out).toContain("factory/7-rate-limit-login");
  expect(gh[0].slice(0, 5)).toEqual(["gh", "pr", "create", "--draft", "--head"]);
  const body = readFileSync(gh[0][gh[0].indexOf("--body-file") + 1], "utf8");
  expect(body).toStartWith("Rate-limits login per user");
  expect(body).toContain("- ✓ evidence: 1 checks pass after the last commit");
  expect(body).toContain("- – holdout: not built yet");
  expect((db.query("SELECT what FROM decisions").get() as any).what).toBe("opened PR #42");
});

test("evidence older than the last commit doesn't count, and an overrun budget blocks", () => {
  const { db, dir, run, ticket } = setup();
  db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (7, 'C1', 'PASS', '2000-01-01T00:00:00Z')").run();
  const rules = (o = {}) => readyRules(db, { id: 7, dir, worktree: ticket().worktree, rules: ["evidence", "budget"], run, ...o });
  expect(rules()[0]).toMatchObject({ result: "fail", detail: "older than the last commit: C1" });
  db.query("UPDATE tickets SET tokens_in = 9000000 WHERE id = 7").run();
  expect(rules()[1]).toMatchObject({ rule: "budget", result: "fail" });
});
