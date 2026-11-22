import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { sh, type Run } from "./runner.ts";
import { runScheduledBenchmarks } from "./cli.ts";
import { applySet, buildTasks, describePlan, planSuite, readSuite, resolveVariant, runSuite, scheduledSuites, usageIn, benchArgv, type Agent } from "./bench.ts";
import { learningUsage, tokensToday } from "./budget.ts";
import { learningHold } from "./learner.ts";
import { buildMetrics } from "./metrics.ts";
import { transcriptDir } from "./usage.ts";
import { validateFile, parseSchedule } from "./validate.ts";
import { buildRuns } from "./runs.ts";
import { validateRuns } from "../lib/runs.js";
import { validateBenchmarks } from "../lib/benchmarks.js";

const SUITE = `target: { stage: implement }
size: smoke
tasks: { from: merged-prs, repo: acme/api, pick: 5, holdout: tests-added-by-pr }
variants:
  - name: baseline
  - name: opus-builder
    set: { agents.builder.model: opus }
limits: { parallel: 1 }
schedule: weekly
`;

// A repo with history: commit A (the base), then B, the merged PR: it fixes src/a.ts and
// adds tests/a.test.ts. The quality floor passes only with the fix and the test file there.
function setup(suite = SUITE) {
  const repo = mkdtempSync(join(tmpdir(), "bench-repo-"));
  const git = (...a: string[]) => sh(["git", "-C", repo, ...a]).out;
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(...c);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ['test -f tests/a.test.ts && grep -q fixed src/a.ts && test "$FACTORY_HOLDOUT_FILES" = tests/a.test.ts']\n`);
  writeFileSync(join(repo, ".factory/benchmarks/impl.yaml"), suite);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 'broken';\n");
  writeFileSync(join(repo, "tests/old.test.ts"), "// old\n");
  git("add", "."); git("commit", "-q", "-m", "A");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 'fixed';\n");
  writeFileSync(join(repo, "tests/a.test.ts"), "// new test\n");
  writeFileSync(join(repo, "tests/old.test.ts"), "// old, edited\n");
  git("add", "."); git("commit", "-q", "-m", "B");
  const merge = git("rev-parse", "HEAD");
  git("checkout", "-q", base); // the checkout sits where it was before the PR; B is still in the repo
  const prs = [
    { number: 7, title: "Fix a", body: "a is broken", mergeCommit: { oid: merge }, files: [
      { path: "src/a.ts", additions: 1, deletions: 1 }, { path: "tests/a.test.ts", additions: 1, deletions: 0 }, { path: "tests/old.test.ts", additions: 1, deletions: 1 }] },
    { number: 6, title: "Only edits an old test", body: null, mergeCommit: { oid: merge }, files: [{ path: "tests/old.test.ts", additions: 1, deletions: 0 }] },
    { number: 5, title: "Never merged here", body: "", mergeCommit: null, files: [] },
    { number: 4, title: "Commits we lack", body: "", mergeCommit: { oid: "0".repeat(40) }, files: [{ path: "tests/x.test.ts", additions: 1, deletions: 0 }] },
  ];
  const ghCalls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "gh" ? (ghCalls.push(argv), { code: 0, out: JSON.stringify(prs) }) : sh(argv, cwd));
  const dir = mkdtempSync(join(tmpdir(), "bench-factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  return { repo, base, merge, run, ghCalls, dir, db, git };
}

// An agent stub: what each variant's agent does, and what it saw.
function stubAgent(behaviour: Record<string, { fix: boolean; model: string; input: number; output: number }>) {
  const seen: { name: string; argv: string[]; cwd: string; holdoutVisible: boolean }[] = [];
  const agent: Agent = async ({ argv, cwd, name }) => {
    const variant = Object.keys(behaviour).find((v) => name.includes(`-${v}-`))!;
    const b = behaviour[variant];
    seen.push({ name, argv, cwd, holdoutVisible: existsSync(join(cwd, "tests/a.test.ts")) });
    if (b.fix) writeFileSync(join(cwd, "src/a.ts"), "export const a = 'fixed';\n");
    mkdirSync(transcriptDir(cwd), { recursive: true });
    writeFileSync(join(transcriptDir(cwd), "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-11-21T10:00:00Z",
      message: { id: `m-${name}`, model: b.model, usage: { input_tokens: b.input, output_tokens: b.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n");
    return { code: 0 };
  };
  return { agent, seen };
}

test("tasks come from merged PRs that added tests: the commit before, the ticket text, the added test files held out", () => {
  const { repo, base, merge, run, ghCalls } = setup();
  const { tasks, skipped } = buildTasks({ repo, slug: "acme/api", pick: 5, run });
  expect(ghCalls[0].slice(0, 6)).toEqual(["gh", "pr", "list", "--repo", "acme/api", "--state"]);
  expect(tasks).toEqual([{ pr: 7, title: "Fix a", body: "a is broken", base, merge, holdout: ["tests/a.test.ts"], pr_lines: 2 }]);
  expect(skipped).toEqual(["#6: added no test files", "#5: no merge commit", expect.stringContaining("#4: its commits aren't in this checkout")]);
  // pick stops the walk: asking for none builds none
  expect(buildTasks({ repo, slug: "acme/api", pick: 0, run }).tasks).toEqual([]);
});

test("size picks 3, 15 or all when tasks.pick is unset", () => {
  const { repo, run } = setup(SUITE.replace("size: smoke", "size: mini").replace(", pick: 5", ""));
  expect(planSuite(repo, "acme/api", "impl", run).pick).toBe(15);
  const full = setup(SUITE.replace("size: smoke", "size: full").replace(", pick: 5", ""));
  expect(planSuite(full.repo, "acme/api", "impl", full.run).pick).toBe(Infinity);
  expect(planSuite(repo, "acme/api", "impl", run).tasks).toHaveLength(1);
  const smoke = setup(SUITE.replace(", pick: 5", ""));
  expect(planSuite(smoke.repo, "acme/api", "impl", smoke.run).pick).toBe(3);
});

test("a variant's dotted paths change this run's settings and never .factory/", () => {
  const { repo, run } = setup();
  const before = sh(["git", "-C", repo, "status", "--porcelain"]).out;
  const suite = readSuite(repo, "impl");
  expect(resolveVariant(repo, suite, {})).toMatchObject([{ stage: "implement", agent: "builder", harness: "claude", model: "claude-sonnet-5-5" }]);
  expect(resolveVariant(repo, suite, { "agents.builder.model": "opus", "agents.builder.harness": "codex" })).toMatchObject([{ harness: "codex", model: "opus" }]);
  // factory.defaults.model reaches an agent that names no model; an agent's own model wins over it.
  expect(resolveVariant(repo, suite, { "factory.defaults.model": "haiku" })[0].model).toBe("claude-sonnet-5-5");
  expect(resolveVariant(repo, suite, { "factory.defaults.model": "haiku", "agents.builder.model": null as any })[0].model).toBe("haiku");
  // a variant can swap the stage's agent through the blueprint
  expect(resolveVariant(repo, suite, { "blueprints.feature.stages.implement.agent": "reviewer" })[0]).toMatchObject({ agent: "reviewer" });
  // a whole-blueprint target runs every agent stage in order, skipping checks and gates
  const whole = { ...suite, target: { blueprint: "feature" } };
  expect(resolveVariant(repo, whole, {}).map((s) => s.stage)).toEqual(["spec", "plan", "implement", "holdout", "review"]);
  expect(sh(["git", "-C", repo, "status", "--porcelain"]).out).toBe(before);
  expect(applySet({ a: { b: 1 } }, { "a.c.d": 2, "e": 3 })).toEqual({ a: { b: 1, c: { d: 2 } }, e: 3 });
  expect(run).toBeTruthy();
});

test("a replay holds the tests out, applies the variant, restores the tests and scores: held-out pass, tokens, cost, diff", async () => {
  const { repo, run, dir, db, base } = setup();
  const { agent, seen } = stubAgent({
    baseline: { fix: false, model: "claude-sonnet-5-5", input: 1000, output: 500 }, // $0.007, doesn't fix it
    "opus-builder": { fix: true, model: "claude-opus-5-5", input: 10_000, output: 2000 }, // $0.08
  });
  const r = await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent, now: (() => { let n = 0; return () => new Date(Date.UTC(2026, 10, 21, 10, 0, n += 30)).toISOString(); })() });
  expect(r).toMatchObject({ runs: 2, stopped: null });
  // The agents saw the checkout at the commit before the PR, with no held-out test, in a throwaway worktree.
  expect(seen.map((s) => s.holdoutVisible)).toEqual([false, false]);
  expect(seen[0].cwd.startsWith(process.env.FACTORY_WORKTREES!)).toBe(true);
  expect(seen[1].argv).toContain("claude-opus-5-5");
  expect(seen[1].argv[seen[1].argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  expect(seen[0].argv[seen[0].argv.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  expect(seen[0].argv).toContain("-p"); // unattended
  expect(sh(["git", "-C", repo, "worktree", "list"]).out.split("\n")).toHaveLength(1); // every throwaway worktree is gone
  expect(sh(["git", "-C", repo, "status", "--porcelain"]).out).toBe(""); // and .factory/ was never touched
  expect(sh(["git", "-C", repo, "rev-parse", "HEAD"]).out).toBe(base);

  const rows = db.query("SELECT variant, status, holdout_pass, tokens_in, tokens_out, usd, diff_lines, pr_lines, model FROM bench_runs ORDER BY id").all();
  expect(rows).toEqual([
    { variant: "baseline", status: "done", holdout_pass: 0, tokens_in: 1000, tokens_out: 500, usd: 0.007, diff_lines: 0, pr_lines: 2, model: "claude-sonnet-5-5" },
    { variant: "opus-builder", status: "done", holdout_pass: 1, tokens_in: 10_000, tokens_out: 2000, usd: 0.08, diff_lines: 2, pr_lines: 2, model: "claude-opus-5-5" },
  ]);

  // The report: benchmarks.json for the window, BENCHMARK.md for a person, the opus variant recommended.
  const doc = JSON.parse(readFileSync(join(dir, "benchmarks.json"), "utf8"));
  expect(validateBenchmarks(doc)).toEqual([]);
  const [suite] = doc.suites;
  expect(suite).toMatchObject({ name: "impl", target: "implement stage", tasks: 1, winner: "opus-builder", stopped: null });
  expect(suite.variants.map((v: any) => [v.name, v.pass_rate, v.minutes])).toEqual([["baseline", 0, 0.5], ["opus-builder", 1, 0.5]]);
  expect(suite.recommendation).toContain("agents.builder.model: opus");
  const md = readFileSync(join(dir, "BENCHMARK.md"), "utf8");
  expect(md).toContain("**opus-builder** (recommended)");
  expect(md).toContain("| baseline | 0% (0/1) |");

  // And the Runs view lists both as kind benchmark, with no ticket.
  const runs = buildRuns(db).runs;
  expect(validateRuns({ runs })).toEqual([]);
  expect(runs.map((x) => [x.kind, x.ticket, x.title])).toEqual([["benchmark", null, "impl · #7 · opus-builder"], ["benchmark", null, "impl · #7 · baseline"]]);
});

test("usage from a worktree's transcripts is priced by the usage code, once per message", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
  mkdirSync(transcriptDir(cwd), { recursive: true });
  const line = (id: string) => JSON.stringify({ type: "assistant", timestamp: "2026-11-21T10:00:00Z", message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } });
  writeFileSync(join(transcriptDir(cwd), "a.jsonl"), [line("m1"), line("m1"), line("m2")].join("\n") + "\n");
  expect(usageIn(cwd)).toMatchObject({ tokens_in: 2_000_000, tokens_out: 200_000, usd: 12, model: "claude-opus-5-5" });
});

test("the spending cap stops new runs; the rest are skipped and the report says so", async () => {
  const { repo, run, dir, db } = setup(SUITE.replace("limits: { parallel: 1 }", "limits: { max_usd: 1, parallel: 1 }"));
  const { agent, seen } = stubAgent({
    baseline: { fix: true, model: "claude-opus-5-5", input: 1_000_000, output: 100_000 }, // $6: over the cap at once
    "opus-builder": { fix: true, model: "claude-opus-5-5", input: 1000, output: 100 },
  });
  const r = await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent });
  expect(r.stopped).toBe("cap");
  expect(seen).toHaveLength(1);
  expect(db.query("SELECT variant, status, detail FROM bench_runs ORDER BY id").all()).toEqual([
    { variant: "baseline", status: "done", detail: null },
    { variant: "opus-builder", status: "skipped", detail: "spending cap reached" },
  ]);
  const doc = JSON.parse(readFileSync(join(dir, "benchmarks.json"), "utf8"));
  expect(doc.suites[0]).toMatchObject({ stopped: "cap", winner: null });
  expect(readFileSync(join(dir, "BENCHMARK.md"), "utf8")).toContain("stopped at its spending cap");
  expect(buildRuns(db).runs).toHaveLength(1); // a skipped run isn't a run
});

test("a run that can't set up is recorded as failed and left out of the rates", async () => {
  const { repo, run, dir, db } = setup();
  const agent: Agent = async () => ({ code: 0 });
  const broken: Run = (argv, cwd) => (argv[3] === "worktree" && argv[4] === "add" ? { code: 128, out: "fatal: no" } : run(argv, cwd));
  await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run: broken, agent });
  const doc = JSON.parse(readFileSync(join(dir, "benchmarks.json"), "utf8"));
  expect(doc.suites[0].variants.map((v: any) => [v.runs, v.errors])).toEqual([[0, 1], [0, 1]]);
  expect(doc.suites[0].winner).toBeNull();
});

test("--dry-run's plan lists tasks and variants, and starts nothing", () => {
  const { repo, run } = setup();
  const lines = describePlan(planSuite(repo, "acme/api", "impl", run));
  expect(lines.join("\n")).toContain("impl: implement stage, smoke (pick 5), 1 tasks from acme/api x 2 variants = 2 runs");
  expect(lines).toContain("  #7 Fix a  (held out: tests/a.test.ts)");
  expect(lines).toContain("  opus-builder  agents.builder.model=opus");
  expect(lines.some((l) => l.includes("#6: added no test files"))).toBe(true);
  expect(sh(["git", "-C", repo, "worktree", "list"]).out.split("\n")).toHaveLength(1);
});

test("a real run needs quality_floor commands, and tests to hold out", async () => {
  const { repo, run, dir, db } = setup();
  const agent: Agent = async () => ({ code: 0 });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\n");
  await expect(runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent })).rejects.toThrow("no quality_floor");
  expect(db.query("SELECT COUNT(*) AS n FROM bench_batches").get()).toEqual({ n: 0 });
  const none: Run = (argv, cwd) => (argv[0] === "gh" ? { code: 0, out: "[]" } : run(argv, cwd));
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: ['true']\n");
  await expect(runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run: none, agent })).rejects.toThrow("nothing to hold out");
});

test("a suite's schedule runs on the loop's clock: stamped when first seen, run when its interval has passed", () => {
  const { repo, db } = setup();
  const launched: string[][] = [];
  const tick = (now: string) => runScheduledBenchmarks(db, { repo, name: "acme-api", now, log: () => {}, launch: (a) => launched.push(a) });
  tick("2026-11-21T10:00:00Z"); // first sight: it costs money, so it waits one interval
  expect(launched).toEqual([]);
  tick("2026-11-25T10:00:00Z"); // four days
  expect(launched).toEqual([]);
  tick("2026-11-28T10:00:01Z"); // a week
  // impl and the sample's implement-model, both weekly
  expect(launched.map((a) => a.slice(2))).toEqual([["bench", "impl", "--name", "acme-api"], ["bench", "implement-model", "--name", "acme-api"]]);
  tick("2026-11-28T10:05:00Z");
  expect(launched).toHaveLength(2);
  expect(scheduledSuites(repo).map((s) => s.name)).toEqual(["impl", "implement-model"]);
});

test("benchmark files are validated: a target names one of stage or blueprint, variants are unique, set paths are dotted into a file", () => {
  expect(validateFile("benchmarks/b.yaml", SUITE)).toEqual([]);
  const bad = (yaml: string) => validateFile("benchmarks/b.yaml", yaml);
  expect(bad(SUITE.replace("target: { stage: implement }", "target: { stage: implement, blueprint: feature }"))).toContain("target: name exactly one of stage or blueprint");
  expect(bad(SUITE.replace("name: opus-builder", "name: baseline"))).toContain('variants[1].name: "baseline" is used twice');
  expect(bad(SUITE.replace("agents.builder.model", "builder"))[0]).toContain("use a dotted path");
  expect(bad(SUITE.replace("agents.builder.model", "agents.builder.modle"))[0]).toContain("agents have no modle");
  expect(bad(SUITE.replace("schedule: weekly", "schedule: someday"))).toContain("schedule: hourly, daily, weekly, or 30m, 6h, 1d");
  expect(bad(SUITE.replace("holdout: tests-added-by-pr", "holdout: all"))[0]).toContain("is not one of tests-added-by-pr");
  expect(bad(SUITE + "limits2: 1\n")[0]).toContain("unknown key");
  expect([parseSchedule("weekly"), parseSchedule("daily"), parseSchedule("hourly"), parseSchedule("6h"), parseSchedule("never")]).toEqual([604_800_000, 86_400_000, 3_600_000, 21_600_000, null]);
});

test("a Claude replay runs with acceptEdits and an allowlist of file tools, read-only git and the repo's tests", () => {
  const step = { stage: "implement", agent: "builder", harness: "claude", model: "sonnet", prompt: "" } as any;
  const task = { title: "t", body: "b" } as any;
  const argv = benchArgv(step, task, { cwd: "/w", log: "/l", commands: ["bun test", "npm run typecheck && echo ok"] });
  expect(argv.slice(0, 4)).toEqual(["claude", "-p", "--permission-mode", "acceptEdits"]);
  expect(argv).not.toContain("bypassPermissions");
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git diff:*)", "Bash(bun test)", "Bash(bun test:*)", "Bash(npm run typecheck && echo ok)", "Bash(npm run:*)"]));
  expect(settings.permissions.allow.some((a: string) => /Bash\((git push|rm|curl)/.test(a))).toBe(false);
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard.ts");
  expect(benchArgv({ ...step, harness: "codex" }, task, { cwd: "/w", log: "/l" }).slice(0, 3)).toEqual(["codex", "exec", "--full-auto"]);
});

// budget.learning, shared with the learner (budget.ts learningUsage, learner.ts learningHold).
const DAY = "2026-11-21T10:00:00.000Z";
const withLearning = (learning: string) => {
  const s = setup(SUITE.replace("schedule: weekly", "schedule: daily"));
  writeFileSync(join(s.repo, ".factory/factory.yaml"), `${readFileSync(join(s.repo, ".factory/factory.yaml"), "utf8")}budget: { learning: "${learning}" }\n`);
  return s;
};
const spendLearner = (db: any, tokens_in: number, at = DAY) =>
  db.query("INSERT INTO learner_runs (started_at, model, status, merged, tokens_in, tokens_out, usd) VALUES (?, 'm', 'done', 0, ?, 0, 1.5)").run(at, tokens_in);
const quiet = { b: { fix: true, model: "claude-sonnet-5-5", input: 1000, output: 100 } };

test("a benchmark's tokens are the day's learning spend, and count toward the day's total", async () => {
  const { repo, run, dir, db } = withLearning("1M/100k");
  const { agent } = stubAgent({ baseline: quiet.b, "opus-builder": quiet.b });
  await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent, now: () => DAY });
  const now = new Date(DAY);
  expect(learningUsage(db, now)).toEqual({ input: 2000, output: 200 });
  expect(tokensToday(db, now).input).toBe(2000); // no work usage here: all of it is learning
  expect(learningUsage(db, new Date("2026-11-22T10:00:00Z"))).toEqual({ input: 0, output: 0 }); // the next day starts clean
  const r = (buildMetrics(db, new Date("2026-11-21T12:00:00Z")).ranges as any)["7"];
  expect(r.learning_tokens_in_per_day.at(-1)).toBe(2000);
  expect(r.tokens_in_per_day.at(-1)).toBe(0); // and it isn't work
});

test("learner runs and benchmarks share one total: together they never pass budget.learning", () => {
  const { repo, db } = withLearning("1000/10k");
  const now = new Date(DAY);
  expect(learningHold(db, repo, now)).toBeNull();
  spendLearner(db, 600);
  expect(learningHold(db, repo, now)).toBeNull();
  db.query("INSERT INTO bench_batches (id, suite, target, size, repo, variants, tasks, started_at) VALUES (1, 's', 't', 'smoke', 'r', '[]', 1, ?)").run(DAY);
  db.query("INSERT INTO bench_runs (batch, task, title, variant, status, started_at, tokens_in, tokens_out, usd) VALUES (1, 1, 't', 'v', 'done', ?, 400, 0, 1)").run(DAY);
  expect(learningHold(db, repo, now)).toContain("budget.learning is spent for today (1000/1000 in");
  expect(learningHold(db, repo, new Date("2026-11-22T00:00:00Z"))).toBeNull();
});

test("a running suite stops starting tasks once the day's learning budget is used, and says why", async () => {
  const { repo, run, dir, db } = withLearning("1500/10k");
  spendLearner(db, 600); // the learner already spent some of it today
  const { agent, seen } = stubAgent({ baseline: quiet.b, "opus-builder": quiet.b });
  const r = await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent, now: () => DAY });
  expect(r.stopped).toBe("learning");
  expect(seen).toHaveLength(1); // 600 + 1000 passes 1500: the second variant never starts
  expect(db.query("SELECT variant, status, detail FROM bench_runs ORDER BY id").all()).toEqual([
    { variant: "baseline", status: "done", detail: null },
    { variant: "opus-builder", status: "skipped", detail: "budget.learning spent for today" },
  ]);
  expect(db.query("SELECT who, what, why FROM decisions").all()).toEqual([
    { who: "daemon", what: "benchmark impl stopped starting tasks", why: expect.stringContaining("budget.learning is spent for today") }]);
  expect(readFileSync(join(dir, "BENCHMARK.md"), "utf8")).toContain("budget.learning was spent for the day");
  // Spent already: a manual run of it today doesn't start at all, and keeps the last report.
  await expect(runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent, now: () => DAY })).rejects.toThrow("not started: budget.learning is spent");
  expect(db.query("SELECT COUNT(*) AS n FROM bench_batches").get()).toEqual({ n: 1 });
  // The next day it runs again.
  const next = await runSuite(db, { dir, repo, slug: "acme/api", name: "impl", run, agent, now: () => "2026-11-22T10:00:00.000Z" });
  expect(next.stopped).toBeNull();
});

test("a scheduled suite is held while the learning budget is spent, noted in the log and BENCHMARK.md, and runs the next day", () => {
  const { repo, db, dir } = withLearning("1000/10k");
  const launched: string[][] = [];
  const tick = (now: string) => runScheduledBenchmarks(db, { dir, repo, name: "acme-api", now, log: () => {}, launch: (a) => launched.push(a) });
  tick("2026-11-20T10:00:00Z"); // first sight: stamped
  spendLearner(db, 1000, "2026-11-21T09:00:00Z");
  tick("2026-11-21T10:00:00Z");
  tick("2026-11-21T10:05:00Z");
  expect(launched).toEqual([]);
  expect(db.query("SELECT what FROM decisions").all()).toEqual([{ what: "benchmark impl held" }]); // once a day; implement-model is weekly, not due
  expect(readFileSync(join(dir, "BENCHMARK.md"), "utf8")).toMatch(/## Held[\s\S]*- impl: held since 2026-11-21 10:05, budget\.learning is spent/);
  tick("2026-11-22T00:00:01Z"); // a new day: nothing spent yet
  expect(launched.map((a) => a[3])).toEqual(["impl"]);
});
