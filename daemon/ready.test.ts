import { agentlessPr } from "./test-env.ts";
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, answer, fixStage, loadBlueprint, mergeTicket, pause, restartStage, ticketDiff, resume, sendBack, sh, startTicket, tryPr, type Run } from "./runner.ts";
import { readyRules, recordVerdict, templateProblems } from "./ready.ts";

const GOOD_PR = "Rate-limits login per user; nothing else changes.\n\n**What changed:** middleware.\n**Why:** brute force.\n**How it was verified:** 14 tests.\n**Risk:** low.\n";

function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true }); agentlessPr(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [evidence, quality_floor, template, budget, holdout]\n');
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
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
  return { db, dir, repo, origin, run, gh, prFile, ticket: () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any };
}

test("the template rule wants one plain sentence, then the reviewer's fields", () => {
  expect(templateProblems(GOOD_PR)).toEqual([]);
  expect(templateProblems(readFileSync(join(import.meta.dir, "../fixtures/acme-api/tickets/409/PR.md"), "utf8"))).toEqual([]);
  expect(templateProblems(null)).toEqual(["PR.md is missing"]);
  expect(templateProblems("# Title\n**What changed:** x\n")).toEqual([
    "PR.md must open with one plain sentence", 'PR.md has no "Why"', 'PR.md has no "How it was verified"', 'PR.md has no "Risk"',
  ]);
});

test("the pr stage waits while a rule fails, then pushes the branch and opens the PR ready for review", () => {
  const { db, dir, repo, origin, run, gh, prFile, ticket } = setup();
  expect(advance(db, { dir, repo, id: 7, run })).toMatchObject({ stage: "pr", waiting: true }); // implement → verify → pr
  expect(ticket().detail).toBe("4 of 5 ready rules · template: PR.md is missing");
  writeFileSync(prFile, GOOD_PR);
  const r = tryPr(db, { dir, repo, id: 7, run });
  expect(r).toMatchObject({ pr: 42, ready: true, stage: "merge" });
  expect(ticket()).toMatchObject({ state: "ready", pr_number: 42, pr_watched: 1, stage: "merge" });
  expect(sh(["git", "-C", origin, "branch", "--list", "factory/7-rate-limit-login"]).out).toContain("factory/7-rate-limit-login");
  expect(gh.map((a) => a.slice(0, 3))).toEqual([["gh", "pr", "list"], ["gh", "pr", "create"]]); // no PR on the branch yet, so one opens
  expect(gh[1].slice(0, 4)).toEqual(["gh", "pr", "create", "--head"]); // ready for review, not a draft
  const body = readFileSync(gh[1][gh[1].indexOf("--body-file") + 1], "utf8");
  expect(body).toStartWith("Rate-limits login per user");
  expect(body).toContain("- ✓ evidence: 1 checks pass after the last commit");
  expect(body).toContain("- – holdout: the blueprint has no checker stage");
  expect(body).toContain("\n\nCloses #7\n\n**Ready rules**"); // merging it closes the ticket's issue
  expect((db.query("SELECT what FROM decisions").get() as any).what).toBe("opened PR #42");
});

test("a goal's PR closes no issue", () => {
  const { db, dir, repo, run, gh } = setup();
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (10000, 'Tidy the logs', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 10000, run });
  advance(db, { dir, repo, id: 10000, run });
  mkdirSync(join(dir, "tickets/10000"), { recursive: true });
  writeFileSync(join(dir, "tickets/10000/PR.md"), GOOD_PR);
  expect(tryPr(db, { dir, repo, id: 10000, run })).toMatchObject({ pr: 42 });
  const create = gh.find((a) => a[2] === "create")!;
  const body = readFileSync(create[create.indexOf("--body-file") + 1], "utf8");
  expect(body).toContain("**Ready rules**");
  expect(body).not.toContain("Closes");
});

test("evidence older than the last commit doesn't count, and an overrun budget blocks", () => {
  const { db, dir, run, ticket } = setup();
  db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (7, 'C1', 'PASS', '2000-01-01T00:00:00Z')").run();
  const rules = (o = {}) => readyRules(db, { id: 7, dir, worktrees: [ticket().worktree], rules: ["evidence", "budget"], run, ...o });
  expect(rules()[0]).toMatchObject({ result: "fail", detail: "older than the last commit: C1" });
  db.query("UPDATE tickets SET tokens_in = 9000000 WHERE id = 7").run();
  expect(rules()[1]).toMatchObject({ rule: "budget", result: "fail" });
});

test("holdout and review count each voter's latest verdict after the last commit", () => {
  const { db, dir, run, ticket } = setup();
  const now = new Date(Date.now() + 1000).toISOString(); // after the worktree's commit
  const rules = (expects: ("holdout" | "review")[] = ["holdout", "review"]) =>
    readyRules(db, { id: 7, dir, worktrees: [ticket().worktree], rules: ["holdout", "review"], run, expects });
  expect(rules([])).toMatchObject([{ result: "skipped", detail: "the blueprint has no checker stage" }, { result: "skipped", detail: "the blueprint has no reviewer stage" }]);
  expect(rules()).toMatchObject([{ result: "fail", detail: "no checker verdict recorded" }, { result: "fail", detail: "no reviewer verdict recorded" }]);
  const vote = (kind: "holdout" | "review", result: "PASS" | "FAIL", by: string, at = now, detail: string | null = null) =>
    recordVerdict(db, { id: 7, kind, result, detail, by, now: at });
  vote("holdout", "PASS", "checker", "2000-01-01T00:00:00Z");
  expect(rules()[0]).toMatchObject({ result: "fail", detail: "the checker's verdict is older than the last commit" });
  vote("holdout", "FAIL", "checker", now, "a 6th try in a minute isn't refused");
  expect(rules()[0]).toMatchObject({ result: "fail", detail: "hidden checks fail: a 6th try in a minute isn't refused" });
  vote("holdout", "PASS", "checker");
  expect(rules()[0]).toMatchObject({ result: "pass" });
  vote("review", "PASS", "reviewer");
  vote("review", "FAIL", "security", now, "the limit key is the raw email");
  expect(rules()[1]).toMatchObject({ result: "fail", detail: "1 of 2 reviewers block: the limit key is the raw email" }); // a tie blocks
  vote("review", "PASS", "style");
  expect(rules()[1]).toMatchObject({ result: "pass", detail: "2 of 3 reviewers report no blockers" });
});

test("a verdict is the open session's agent's unless --by names the voter", () => {
  const { db } = setup();
  expect(recordVerdict(db, { id: 7, kind: "review", result: "PASS", detail: null, now: "2026-11-21T10:00:00Z" })).toBe("builder");
  expect(recordVerdict(db, { id: 7, kind: "review", result: "PASS", detail: null, by: "security", now: "2026-11-21T10:00:00Z" })).toBe("security");
  expect(() => recordVerdict(db, { id: 9, kind: "review", result: "PASS", detail: null, now: "2026-11-21T10:00:00Z" })).toThrow("no ticket 9");
});

test("m merges only a ready ticket's PR: marks the draft ready, squash-merges, ends the gate", () => {
  const { db, dir, repo, run, gh, prFile, ticket } = setup();
  expect(() => mergeTicket(db, { repo, id: 7, run })).toThrow("#7 is running with no PR");
  advance(db, { dir, repo, id: 7, run });
  writeFileSync(prFile, GOOD_PR);
  tryPr(db, { dir, repo, id: 7, run });
  gh.length = 0;
  expect(mergeTicket(db, { repo, id: 7, run })).toEqual({ pr: 42, merged: ["acme/api#42"] });
  expect(gh).toEqual([["gh", "pr", "ready", "42"], ["gh", "pr", "merge", "42", "--squash"]]);
  expect(ticket()).toMatchObject({ state: "merged", pr_number: 42, pr_watched: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM stages WHERE ticket = 7 AND ended_at IS NULL").get()).toEqual({ n: 0 });
  expect(() => mergeTicket(db, { repo, id: 7, run })).toThrow("#7 is merged");
});

test("a failed gh merge leaves the ticket ready, with gh's reason", () => {
  const { db, dir, repo, run, prFile, ticket } = setup();
  advance(db, { dir, repo, id: 7, run });
  writeFileSync(prFile, GOOD_PR);
  tryPr(db, { dir, repo, id: 7, run });
  const failing: Run = (argv, cwd) => argv[2] === "merge" ? { code: 1, out: "Pull request is not mergeable: checks failing" }
    : argv[2] === "ready" ? { code: 1, out: "! Pull request #42 is already \"ready for review\"" } : run(argv, cwd);
  expect(() => mergeTicket(db, { repo, id: 7, run: failing })).toThrow("gh pr merge failed: Pull request is not mergeable");
  expect(ticket().state).toBe("ready");
});

test("a note restarts an agent stage: review's fixes go to implement, a check hands over to its on_fail", () => {
  const fixtures = join(import.meta.dir, "../fixtures/acme-api");
  const feature = loadBlueprint(fixtures, "feature");
  expect(fixStage(feature)).toBe("implement");
  expect(fixStage(loadBlueprint(fixtures, "chore"))).toBe("implement");
  expect(restartStage(feature, "review")).toBe("review");
  expect(restartStage(feature, "verify")).toBe("implement");
  expect(restartStage(feature, "merge")).toBe("spec");
  expect(restartStage(feature, null)).toBe("spec");
});

test("x sends a ready PR back with a note, and the fixed work updates that PR instead of opening another", () => {
  const { db, dir, repo, run, gh, prFile, ticket } = setup();
  advance(db, { dir, repo, id: 7, run });
  writeFileSync(prFile, GOOD_PR);
  tryPr(db, { dir, repo, id: 7, run });
  expect(() => sendBack(db, { dir, repo, id: 7, note: "  ", run })).toThrow("say what to change");
  expect(sendBack(db, { dir, repo, id: 7, note: "Return 429 with Retry-After, not 403.", run })).toEqual({ stage: "implement", terminal: "t1" });
  expect(ticket()).toMatchObject({ state: "running", stage: "implement", pr_number: 42 });
  const review = readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8");
  expect(review).toStartWith("# REVIEW\n\n## Sent back by you");
  expect(review).toContain("PR #42\n\nReturn 429 with Retry-After, not 403.\n");
  gh.length = 0;
  expect(advance(db, { dir, repo, id: 7, run })).toMatchObject({ pr: 42, ready: true, stage: "merge" }); // implement → verify → pr
  expect(gh.map((a) => a.slice(0, 4))).toEqual([["gh", "pr", "edit", "42"]]);
  expect((db.query("SELECT what FROM decisions ORDER BY id DESC").get() as any).what).toBe("updated PR #42");
  expect(() => sendBack(db, { dir, repo, id: 8, note: "x", run })).toThrow("no ticket 8");
});

test("u answers a parked ticket into GATES.md and reruns where it stopped", () => {
  const { db, dir, repo, run, ticket } = setup();
  expect(() => answer(db, { dir, repo, id: 7, text: "yes", run })).toThrow("#7 is running; only a parked ticket");
  db.query("UPDATE tickets SET state = 'parked', stage = 'verify', retries = 3, needs_kind = 'parked', needs_text = 'Verify failed 3 times: tests check failed' WHERE id = 7").run();
  expect(answer(db, { dir, repo, id: 7, text: "The flaky test is known; skip it with .skip.", run })).toEqual({ stage: "implement", terminal: "t1" });
  expect(ticket()).toMatchObject({ state: "running", stage: "implement", retries: 0, needs_kind: null, needs_text: null });
  expect(readFileSync(join(dir, "tickets/7/GATES.md"), "utf8")).toContain("Verify failed 3 times: tests check failed\n\n**Your answer:** The flaky test is known; skip it with .skip.\n");
});

test("p pauses a running ticket (its agent killed, its stage kept) and resumes it with a fresh session", () => {
  const { db, dir, repo, run, ticket } = setup();
  const killed: string[][] = [];
  const spy: Run = (argv, cwd) => (argv[1] === "kill" ? (killed.push(argv), { code: 1, out: "no terminal t1" }) : run(argv, cwd));
  expect(pause(db, { id: 7, run: spy })).toEqual({ stage: "implement", killed: ["t1"] });
  expect(killed).toEqual([["hc", "kill", "t1"]]);
  expect(ticket()).toMatchObject({ state: "paused", stage: "implement" });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get()).toEqual({ n: 0 });
  expect(db.query("SELECT detail FROM stages ORDER BY id DESC").get()).toEqual({ detail: "paused" });
  expect(() => pause(db, { id: 7, run })).toThrow("#7 is paused; only a running ticket pauses");
  expect(resume(db, { dir, repo, id: 7, run })).toEqual({ stage: "implement", terminal: "t1" });
  expect(ticket()).toMatchObject({ state: "running", stage: "implement" });
  expect(() => resume(db, { dir, repo, id: 7, run })).toThrow("#7 is running; only a paused ticket resumes");
});

test("a ticket paused while waiting at pr resumes waiting there, with no agent", () => {
  const { db, dir, repo, run, ticket } = setup();
  advance(db, { dir, repo, id: 7, run }); // implement → verify → pr, waiting on PR.md
  expect(pause(db, { id: 7, run })).toEqual({ stage: "pr", killed: [] });
  expect(resume(db, { dir, repo, id: 7, run })).toEqual({ stage: "pr", terminal: null });
  expect(ticket()).toMatchObject({ state: "running", stage: "pr" });
});

test("d shows what the ticket changed, committed or not, against the repo's branch", () => {
  const { db, repo, run, ticket } = setup();
  const wt = ticket().worktree;
  expect(ticketDiff(db, { repo, id: 7, run })).toBe("");
  writeFileSync(join(wt, "limit.ts"), "export const MAX = 5;\n");
  sh(["git", "-C", wt, "add", "."]);
  sh(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "limit"]);
  writeFileSync(join(wt, "limit.ts"), "export const MAX = 6;\n"); // not committed yet
  const d = ticketDiff(db, { repo, id: 7, run });
  expect(d).toContain("diff --git a/limit.ts b/limit.ts");
  expect(d).toContain("+export const MAX = 6;");
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (8, 'Later', '2026-11-21T10:00:00Z')").run();
  expect(() => ticketDiff(db, { repo, id: 8, run })).toThrow("#8 has no worktree");
});

test("a send-back whose agent can't start leaves no note behind, so a retry writes it once", () => {
  const { db, dir, repo, run, prFile } = setup();
  advance(db, { dir, repo, id: 7, run });
  writeFileSync(prFile, GOOD_PR);
  tryPr(db, { dir, repo, id: 7, run });
  const down: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 1, out: "herdr-core isn't running" } : run(argv, cwd));
  const review = join(dir, "tickets/7/REVIEW.md");
  expect(() => db.transaction(() => sendBack(db, { dir, repo, id: 7, note: "429, not 403.", run: down }))()).toThrow("hc run failed");
  expect(existsSync(review)).toBe(false);
  sendBack(db, { dir, repo, id: 7, note: "429, not 403.", run });
  expect(readFileSync(review, "utf8").match(/429, not 403/g)).toHaveLength(1);
});

test("merge_method in factory.yaml picks how the PR merges", () => {
  const { db, dir, repo, run, gh, prFile } = setup();
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [template]\nmerge_method: rebase\n');
  advance(db, { dir, repo, id: 7, run });
  writeFileSync(prFile, GOOD_PR);
  tryPr(db, { dir, repo, id: 7, run });
  gh.length = 0;
  mergeTicket(db, { repo, id: 7, run });
  expect(gh[1]).toEqual(["gh", "pr", "merge", "42", "--rebase"]);
  expect((db.query("SELECT why FROM decisions ORDER BY id DESC").get() as any).why).toBe("rebase");
});
