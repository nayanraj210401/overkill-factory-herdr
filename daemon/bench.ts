// Benchmarks (plan: Benchmarks, monitoring on your own data). A suite in
// .factory/benchmarks/<name>.yaml replays past merged PRs: each task is the commit before
// the PR, its title and body as the ticket, and the tests the PR added, held out. Every
// task runs under every variant in a throwaway worktree, with the variant's `set:` paths
// applied to this run's copy of the settings and never to .factory/. Then the held-out
// tests come back and run. The result is a report; nothing here changes the factory.
import { benchAllow } from "./allow.ts";
export { benchAllow };
import { DEFAULT_MODEL } from "./models.ts";
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { benchmarkMarkdown, validateBenchmarks } from "../lib/benchmarks.js";
import { worktreePath, sessionState } from "./herdr.ts";
import { STOPS, guardSettings } from "./guard.ts";
import { argvFor, loadAgent, loadBlueprint, plannedPath, readFactory, type Run } from "./runner.ts";
import { jsonl, parseTranscript, transcriptDir, usd } from "./usage.ts";
import { parseSchedule, validateFile } from "./validate.ts";

export type Suite = {
  name: string;
  target: { stage?: string; blueprint?: string };
  size: "smoke" | "mini" | "full";
  tasks: { repo?: string; pick?: number };
  variants: { name: string; set: Record<string, unknown> }[];
  limits: { max_usd?: number; max_tokens?: number; parallel?: number };
  schedule?: string;
};
export type Task = { pr: number; title: string; body: string; base: string; merge: string; holdout: string[]; pr_lines: number };

// How many tasks a size picks when the suite's tasks.pick is unset.
export const SIZE_PICK = { smoke: 3, mini: 15, full: Infinity };

export function readSuite(repo: string, name: string): Suite {
  const path = `benchmarks/${name}.yaml`;
  const file = ["yaml", "yml"].map((x) => join(repo, ".factory", `benchmarks/${name}.${x}`)).find(existsSync);
  if (!file) throw new Error(`no benchmark "${name}" in ${repo}/.factory/benchmarks/`);
  const text = readFileSync(file, "utf8");
  const errors = validateFile(path, text);
  if (errors.length) throw new Error(`.factory/${path}: ${errors[0]}`);
  const doc = Bun.YAML.parse(text) as any;
  return {
    name, target: doc.target ?? {}, size: doc.size ?? "mini", tasks: doc.tasks ?? {},
    variants: doc.variants.map((v: any) => ({ name: v.name, set: v.set ?? {} })),
    limits: doc.limits ?? {}, schedule: doc.schedule,
  };
}

// Suites with a `schedule:`, with how often: what the daemon loop runs when due.
export function scheduledSuites(repo: string): { name: string; ms: number }[] {
  const dir = join(repo, ".factory", "benchmarks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().flatMap((f) => {
    const name = f.replace(/\.ya?ml$/, "");
    try {
      const ms = parseSchedule(readSuite(repo, name).schedule);
      return ms === null ? [] : [{ name, ms }];
    } catch { return []; }
  });
}

// ---- tasks ------------------------------------------------------------------------

export const isTestPath = (p: string) =>
  /(^|\/)(tests?|__tests__|specs?)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /_test\.(go|py|rb|rs)$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p);

// Merged PRs, newest first, that added test files, as tasks. A PR whose commits this
// checkout lacks, or that added no tests, is named in `skipped` (nothing to hold out).
export function buildTasks(o: { repo: string; slug: string; pick: number; run: Run }): { tasks: Task[]; skipped: string[] } {
  const limit = Number.isFinite(o.pick) ? Math.max(o.pick * 5, 50) : 1000;
  const r = o.run(["gh", "pr", "list", "--repo", o.slug, "--state", "merged", "--limit", String(limit), "--json", "number,title,body,mergeCommit,files"]);
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.out.split("\n")[0]}`);
  const prs = (JSON.parse(r.out) as any[]).sort((a, b) => b.number - a.number);
  const tasks: Task[] = [];
  const skipped: string[] = [];
  const git = (...a: string[]) => o.run(["git", "-C", o.repo, ...a]);
  for (const pr of prs) {
    if (tasks.length >= o.pick) break;
    const merge = pr.mergeCommit?.oid as string | undefined;
    if (!merge) { skipped.push(`#${pr.number}: no merge commit`); continue; }
    const base = git("rev-parse", "--verify", "--quiet", `${merge}^1`);
    if (base.code !== 0) { skipped.push(`#${pr.number}: its commits aren't in this checkout (git fetch)`); continue; }
    const files = (pr.files ?? []) as { path: string; additions: number; deletions: number }[];
    // Added by the PR: a test file that isn't there at the commit before it.
    const holdout = files.filter((f) => isTestPath(f.path) && git("cat-file", "-e", `${base.out}:${f.path}`).code !== 0).map((f) => f.path);
    if (!holdout.length) { skipped.push(`#${pr.number}: added no test files`); continue; }
    tasks.push({
      pr: pr.number, title: pr.title, body: pr.body ?? "", base: base.out, merge, holdout,
      pr_lines: files.filter((f) => !isTestPath(f.path)).reduce((n, f) => n + f.additions + f.deletions, 0),
    });
  }
  return { tasks, skipped };
}

// ---- variants ---------------------------------------------------------------------

// Sets dotted paths in a document: agents.builder.model → doc.agents.builder.model.
export function applySet(doc: Record<string, any>, set: Record<string, unknown>) {
  for (const [path, value] of Object.entries(set)) {
    const keys = path.split(".");
    const last = keys.pop()!;
    let at = doc;
    for (const k of keys) at = typeof at[k] === "object" && at[k] !== null ? at[k] : (at[k] = {});
    at[last] = value;
  }
  return doc;
}

export type Step = { stage: string; agent: string; harness: string; model: string | undefined; prompt: string };

// This run's own copy of the settings the target stage reads, with the variant applied.
// Reading goes through the runner's loaders; nothing is written back to .factory/.
export function resolveVariant(repo: string, suite: Suite, set: Record<string, unknown>): Step[] {
  const bpName = suite.target.blueprint ?? "feature";
  const bp = loadBlueprint(repo, bpName);
  const doc: Record<string, any> = { factory: readFactory(repo), blueprints: { [bpName]: structuredClone(bp) }, agents: {} };
  for (const s of Object.values(bp.stages)) if (s.agent) doc.agents[s.agent] = loadAgent(repo, s.agent) ?? {};
  for (const k of Object.keys(set)) { const [head, name] = k.split("."); if (head === "agents") doc.agents[name] ??= loadAgent(repo, name) ?? {}; }
  applySet(doc, set);
  const b = doc.blueprints[bpName] as typeof bp;
  const stages = suite.target.stage ? [suite.target.stage] : [b.start, ...plannedPath(b, b.start)];
  const defaults = { harness: doc.factory.defaults?.harness ?? "claude", model: doc.factory.defaults?.model ?? DEFAULT_MODEL };
  const steps: Step[] = [];
  for (const stage of stages) {
    const s = b.stages[stage];
    if (!s) throw new Error(`blueprint ${bpName} has no stage "${stage}"`);
    if (!s.agent) { if (suite.target.stage) throw new Error(`stage ${stage} has no agent to benchmark`); continue; }
    if ((s as { requires?: string }).requires === "ready" && !suite.target.stage) continue; // the pr stage opens PRs; a replay never does
    const a = (doc.agents[s.agent] ??= loadAgent(repo, s.agent) ?? {});
    steps.push({ stage, agent: s.agent, harness: a.harness ?? defaults.harness, model: a.model ?? defaults.model, prompt: a.prompt ?? "" });
  }
  return steps;
}

// ---- agents -----------------------------------------------------------------------

export type Agent = (o: { argv: string[]; cwd: string; name: string }) => Promise<{ code: number; out?: string }>;

// The agent's command, run unattended: Claude prints and exits, Codex execs. Claude runs
// with acceptEdits and an allowlist: file tools, read-only git, and the repo's own test
// commands (quality_floor). Any other command is denied, since -p can't ask. The hard-stop
// guard still watches its tool calls (its notes go to the benchmark's own log). Codex's
// --full-auto is its workspace-write sandbox.
export function benchArgv(step: Step, task: Task, o: { cwd: string; log: string; commands?: string[] }) {
  const text = [
    `Benchmark task: ${task.title}`, task.body, step.prompt,
    `You run the ${step.stage} stage on this task in the current directory, a checkout of the repo before the change was made. Implement it, run the tests that exist (${(o.commands ?? []).join("; ") || "the repo's test command"}), and leave your work in this directory. There are hidden tests you can't see. Don't push, and don't use the factory CLI. Commands other than file edits, read-only git and those tests are denied.`,
  ].filter(Boolean).join("\n\n");
  const guard = guardSettings({ stops: [...STOPS], roots: [o.cwd], log: o.log });
  const settings = JSON.stringify({ ...(guard ? JSON.parse(guard) : {}), permissions: { allow: benchAllow(o.commands ?? []) } });
  const argv = argvFor({ harness: step.harness, model: step.model }, { harness: "claude" }, text, step.harness === "claude" ? settings : null);
  if (step.harness === "claude") return [argv[0], "-p", "--permission-mode", "acceptEdits", ...argv.slice(1)];
  if (step.harness === "codex") return [argv[0], "exec", "--full-auto", ...argv.slice(1)];
  return argv;
}

// Through hc, as the runner starts its agents: a background terminal in the worktree,
// polled until it exits or the time limit passes.
export function hcAgent(run: Run, o: { timeoutMs?: number; pollMs?: number } = {}): Agent {
  return async ({ argv, cwd, name }) => {
    const r = run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name.slice(0, 32), "--cwd", cwd, "--label", "factory.benchmark=1", ...argv]);
    if (r.code !== 0) return { code: r.code, out: `hc run failed: ${r.out}` };
    let address = name;
    try { address = JSON.parse(r.out).address ?? name; } catch {}
    const deadline = Date.now() + (o.timeoutMs ?? 45 * 60_000);
    for (;;) {
      await new Promise((done) => setTimeout(done, o.pollMs ?? 5000));
      const g = run(["hc", "get", address, "--json"]);
      let info: any = null;
      try { if (g.code === 0) info = JSON.parse(g.out); } catch {}
      if (!info || sessionState(info) === "exited") return { code: info?.exit_code ?? 0 };
      if (Date.now() > deadline) { run(["hc", "kill", address]); return { code: 124, out: "timed out" }; }
    }
  };
}

// ---- one run ----------------------------------------------------------------------

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// What an agent's transcripts in a worktree cost: tokens in (input and cache writes), tokens
// out, API-equivalent dollars (the usage code's prices), and the model that wrote the most.
export function usageIn(cwd: string) {
  const dirs = [...new Set([cwd, existsSync(cwd) ? realpathSync(cwd) : cwd].map(transcriptDir))];
  const files = dirs.flatMap(jsonl);
  const uses = new Map(files.flatMap((f) => parseTranscript(readFileSync(f, "utf8")).map((u) => [u.id, u] as const)));
  const byModel = new Map<string, number>();
  let tokens_in = 0, tokens_out = 0, cost = 0;
  for (const u of uses.values()) {
    tokens_in += u.input + u.w5m + u.w1h; tokens_out += u.output; cost += usd(u);
    byModel.set(u.model, (byModel.get(u.model) ?? 0) + u.output);
  }
  return { tokens_in, tokens_out, usd: cost, model: [...byModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, transcript: files.sort()[0] ?? null };
}

// Added plus removed lines of the non-test files in a worktree against `base`, work uncommitted or not.
function diffLines(run: Run, wt: string, base: string) {
  run(["git", "-C", wt, "add", "-A"]);
  const r = run(["git", "-C", wt, "diff", "--cached", "--numstat", base]);
  return r.out.split("\n").filter(Boolean).reduce((n, l) => {
    const [a, d, ...path] = l.split("\t");
    return isTestPath(path.join("\t")) ? n : n + (Number(a) || 0) + (Number(d) || 0);
  }, 0);
}

export type RunRow = { status: "done" | "failed" | "skipped"; detail: string | null; harness: string | null; model: string | null; started_at: string; ended_at: string | null;
  tokens_in: number; tokens_out: number; usd: number; holdout_pass: 0 | 1 | null; diff_lines: number | null; pr_lines: number | null; cwd: string | null; transcript: string | null };

export async function replay(o: { repo: string; suite: Suite; task: Task; variant: Suite["variants"][number]; run: Run; agent: Agent; commands: string[]; dir: string; now: () => string }): Promise<RunRow> {
  const { repo, suite, task, variant, run } = o;
  const row: RunRow = { status: "failed", detail: null, harness: null, model: null, started_at: o.now(), ended_at: null, tokens_in: 0, tokens_out: 0, usd: 0, holdout_pass: null, diff_lines: null, pr_lines: task.pr_lines, cwd: null, transcript: null };
  const wt = worktreePath(repo, `bench-${suite.name}-${task.pr}-${variant.name}`);
  row.cwd = wt;
  try {
    const steps = resolveVariant(repo, suite, variant.set);
    row.harness = steps[0]?.harness ?? null;
    row.model = steps[0]?.model ?? null;
    mkdirSync(dirname(wt), { recursive: true });
    if (existsSync(wt)) run(["git", "-C", repo, "worktree", "remove", "--force", wt]);
    const add = run(["git", "-C", repo, "worktree", "add", "--detach", wt, task.base]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
    // The checkout is the commit before the PR, so the PR's tests aren't in it: held out by construction.
    for (const f of task.holdout) if (existsSync(join(wt, f))) rmSync(join(wt, f));
    const failed: string[] = [];
    for (const step of steps) {
      const log = join(o.dir, "benchmarks", `${suite.name}-${task.pr}-${variant.name}-hard-stops.jsonl`);
      const r = await o.agent({ argv: benchArgv(step, task, { cwd: wt, log, commands: o.commands }), cwd: wt, name: `bench-${task.pr}-${variant.name}-${step.stage}` });
      if (r.code !== 0) failed.push(`${step.stage} agent exited ${r.code}${r.out ? `: ${r.out}` : ""}`);
    }
    row.diff_lines = diffLines(run, wt, task.base);
    Object.assign(row, usageIn(wt));
    // The held-out tests come back from the merged commit, then the quality floor runs.
    for (const f of task.holdout) {
      const src = run(["git", "-C", repo, "show", `${task.merge}:${f}`]);
      if (src.code !== 0) throw new Error(`can't restore ${f}: ${src.out}`);
      mkdirSync(dirname(join(wt, f)), { recursive: true });
      writeFileSync(join(wt, f), src.out + "\n");
    }
    const env = `export FACTORY_HOLDOUT_FILES=${quote(task.holdout.join(" "))}; `;
    const results = o.commands.map((c) => run(["sh", "-c", env + c], wt));
    row.holdout_pass = results.every((r) => r.code === 0) ? 1 : 0;
    row.status = "done";
    row.detail = [...failed, ...results.filter((r) => r.code !== 0).map((r) => `tests: exit ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 160)}`)].join("; ") || null;
  } catch (e) {
    row.detail = (e as Error).message;
  } finally {
    run(["git", "-C", repo, "worktree", "remove", "--force", wt]);
    row.ended_at = o.now();
  }
  return row;
}

// ---- a suite ----------------------------------------------------------------------

export const targetName = (s: Suite) => (s.target.stage ? `${s.target.stage} stage` : `${s.target.blueprint} blueprint`);

export type Plan = { suite: Suite; slug: string; pick: number; tasks: Task[]; skipped: string[]; commands: string[] };

// What a run would do: the tasks and variants, and the commands that score the held-out tests.
export function planSuite(repo: string, slug: string, name: string, run: Run): Plan {
  const suite = readSuite(repo, name);
  const pick = suite.tasks.pick ?? SIZE_PICK[suite.size];
  const target = suite.tasks.repo ?? slug;
  for (const v of suite.variants) resolveVariant(repo, suite, v.set); // a bad path or stage fails before anything runs
  return { suite, slug: target, pick, ...buildTasks({ repo, slug: target, pick, run }), commands: readFactory(repo).quality_floor ?? [] };
}

export function describePlan(p: Plan): string[] {
  const s = p.suite;
  return [
    `${s.name}: ${targetName(s)}, ${s.size}${s.tasks.pick ? ` (pick ${s.tasks.pick})` : ""}, ${p.tasks.length} tasks from ${p.slug} x ${s.variants.length} variants = ${p.tasks.length * s.variants.length} runs`,
    `limits: ${[s.limits.max_usd && `$${s.limits.max_usd}`, s.limits.max_tokens && `${s.limits.max_tokens} tokens`].filter(Boolean).join(", ") || "none"}; ${s.limits.parallel ?? 1} at a time`,
    "tasks:", ...p.tasks.map((t) => `  #${t.pr} ${t.title}  (held out: ${t.holdout.join(", ")})`),
    ...(p.skipped.length ? ["skipped:", ...p.skipped.map((x) => `  ${x}`)] : []),
    "variants:", ...s.variants.map((v) => `  ${v.name}${Object.keys(v.set).length ? `  ${Object.entries(v.set).map(([k, x]) => `${k}=${x}`).join(", ")}` : "  (as .factory/ is)"}`),
    ...(p.commands.length ? [] : ["warning: factory.yaml has no quality_floor commands, which score the held-out tests; a real run refuses"]),
  ];
}

export async function runSuite(db: Database, o: { dir: string; repo: string; slug: string; name: string; run: Run; agent: Agent; now?: () => string; log?: (s: string) => void }) {
  const now = o.now ?? (() => new Date().toISOString());
  const log = o.log ?? (() => {});
  const plan = planSuite(o.repo, o.slug, o.name, o.run);
  const { suite, tasks, commands } = plan;
  if (!commands.length) throw new Error("factory.yaml has no quality_floor commands; they score the held-out tests");
  if (!tasks.length) throw new Error(`no merged PR in ${plan.slug} added tests, so there is nothing to hold out${plan.skipped.length ? ` (${plan.skipped[0]})` : ""}`);
  const batch = Number(db.query(`INSERT INTO bench_batches (suite, target, size, repo, variants, tasks, max_usd, max_tokens, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(suite.name, targetName(suite), suite.size, plan.slug, JSON.stringify(suite.variants), tasks.length, suite.limits.max_usd ?? null, suite.limits.max_tokens ?? null, now()).lastInsertRowid);
  // Task by task, every variant of it, so a stop at the cap leaves whole comparisons.
  const jobs = tasks.flatMap((task) => suite.variants.map((variant) => ({ task, variant })));
  let spent = { usd: 0, tokens: 0 };
  let stopped: string | null = null;
  const insert = db.query(`INSERT INTO bench_runs (batch, task, title, variant, status, detail, harness, model, started_at, ended_at, tokens_in, tokens_out, usd, holdout_pass, diff_lines, pr_lines, cwd, transcript)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const record = (j: (typeof jobs)[number], r: RunRow) => insert.run(batch, j.task.pr, j.task.title, j.variant.name, r.status, r.detail, r.harness, r.model, r.started_at, r.ended_at,
    r.tokens_in, r.tokens_out, r.usd, r.holdout_pass, r.diff_lines, r.pr_lines, r.cwd, r.transcript);
  const capped = () => (suite.limits.max_usd != null && spent.usd >= suite.limits.max_usd) || (suite.limits.max_tokens != null && spent.tokens >= suite.limits.max_tokens);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (stopped || capped()) {
        stopped = "cap";
        const t = now();
        record(j, { status: "skipped", detail: "spending cap reached", harness: null, model: null, started_at: t, ended_at: t, tokens_in: 0, tokens_out: 0, usd: 0, holdout_pass: null, diff_lines: null, pr_lines: null, cwd: null, transcript: null });
        continue;
      }
      const r = await replay({ repo: o.repo, suite, task: j.task, variant: j.variant, run: o.run, agent: o.agent, commands, dir: o.dir, now });
      spent = { usd: spent.usd + r.usd, tokens: spent.tokens + r.tokens_in + r.tokens_out };
      record(j, r);
      log(`benchmark ${suite.name}: #${j.task.pr} under ${j.variant.name}: ${r.status === "done" ? (r.holdout_pass ? "held-out tests pass" : "held-out tests fail") : `${r.status}: ${r.detail}`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, suite.limits.parallel ?? 1) }, worker));
  db.query("UPDATE bench_batches SET ended_at = ?, stopped = ? WHERE id = ?").run(now(), stopped, batch);
  writeBenchmarks(db, o.dir);
  return { batch, runs: jobs.length, spent_usd: spent.usd, stopped };
}

// ---- the report -------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 2) => +n.toFixed(d);

// The latest finished batch of each suite, a row per variant: means over its scored runs.
export function buildBenchmarks(db: Database, now = new Date()) {
  const batches = db.query(`SELECT * FROM bench_batches b WHERE ended_at IS NOT NULL AND id = (SELECT MAX(id) FROM bench_batches WHERE suite = b.suite) ORDER BY suite`).all() as any[];
  const suites = batches.map((b) => {
    const rows = db.query("SELECT * FROM bench_runs WHERE batch = ?").all(b.id) as any[];
    const variants = (JSON.parse(b.variants) as Suite["variants"]).map((v) => {
      const mine = rows.filter((r) => r.variant === v.name);
      const done = mine.filter((r) => r.status === "done");
      const passed = done.filter((r) => r.holdout_pass === 1).length;
      return {
        name: v.name, set: v.set, runs: done.length, passed, errors: mine.filter((r) => r.status === "failed").length, skipped: mine.filter((r) => r.status === "skipped").length,
        pass_rate: done.length ? round(passed / done.length, 3) : 0,
        tokens_in: Math.round(mean(done.map((r) => r.tokens_in))), tokens_out: Math.round(mean(done.map((r) => r.tokens_out))),
        usd: round(mean(done.map((r) => r.usd))),
        minutes: round(mean(done.map((r) => (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000)), 1),
        diff_lines: Math.round(mean(done.map((r) => r.diff_lines ?? 0))), pr_lines: Math.round(mean(done.map((r) => r.pr_lines ?? 0))),
      };
    });
    const { winner, recommendation } = recommend(variants);
    return { name: b.suite, target: b.target, size: b.size, repo: b.repo, started_at: b.started_at, ended_at: b.ended_at, tasks: b.tasks,
      spent_usd: round(rows.reduce((n, r) => n + r.usd, 0)), stopped: b.stopped, variants, winner, recommendation };
  });
  return { generated_at: now.toISOString(), suites };
}

// The best variant: most held-out tests passed, then cheaper, then faster. Only a
// comparison (two variants with scored runs) names one, and it stays a recommendation.
export function recommend(variants: { name: string; set: Record<string, unknown>; runs: number; pass_rate: number; usd: number; minutes: number }[]) {
  const scored = variants.filter((v) => v.runs > 0);
  if (scored.length < 2) return { winner: null, recommendation: null };
  const [best] = [...scored].sort((a, b) => b.pass_rate - a.pass_rate || a.usd - b.usd || a.minutes - b.minutes);
  const base = variants[0];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (best === base) return { winner: best.name, recommendation: `${best.name} did best: ${pct(best.pass_rate)} of held-out tests at $${best.usd.toFixed(2)} a task. No change recommended.` };
  const change = Object.entries(best.set).map(([k, v]) => `${k}: ${v}`).join(", ");
  return { winner: best.name, recommendation: `Recommendation: ${best.name} passed ${pct(best.pass_rate)} of held-out tests at $${best.usd.toFixed(2)} a task, against ${pct(base.pass_rate)} at $${base.usd.toFixed(2)} for ${base.name}${change ? `. To adopt it, change .factory/ to ${change}` : ""}.` };
}

// benchmarks.json (the window) and BENCHMARK.md (a person), both from the same rows.
export function writeBenchmarks(db: Database, dir: string, now = new Date()) {
  const doc = buildBenchmarks(db, now);
  const errors = validateBenchmarks(doc);
  if (errors.length) throw new Error(`benchmarks.json would break the contract:\n${errors.join("\n")}`);
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(dir, "benchmarks.json"), JSON.stringify(doc) + "\n");
  const md = benchmarkMarkdown(doc);
  const file = join(dir, "BENCHMARK.md");
  if (!existsSync(file) || readFileSync(file, "utf8") !== md) writeFileSync(file, md);
  return doc;
}
