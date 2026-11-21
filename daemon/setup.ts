// `factory setup`: the first-run checklist as data (docs/plan.md § First run), and
// `factory setup write`, which puts .factory/ on its own branch without touching the
// checkout you're working in.
import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, setMeta } from "./db.ts";
import { readFactory, sh } from "./runner.ts";
import { service } from "./service.ts";
import { validateDir } from "./validate.ts";

export type Step = { id: string; label: string; status: "ok" | "missing" | "skipped"; fix: string | null; detail: string | null };
export type Probe = { has: (bin: string) => boolean; ghLoggedIn: () => boolean; service: () => string };

export const BRANCH = "factory/setup";
export const STEP_IDS = ["herdr-core", "gh", "harness", "service", "queue", "basics", "factory-dir"];

// What this machine has. Cached for 30 s: the daemon asks on every tick while setup shows.
let cached: { at: number; probe: Probe } | null = null;
export function realProbe(): Probe {
  if (cached && Date.now() - cached.at < 30_000) return cached.probe;
  const sandbox = !!process.env.FACTORY_TEST_SANDBOX; // tests never run gh or launchctl
  const once = <T>(fn: () => T) => { let v: T | undefined; return () => (v ??= fn()); };
  const probe: Probe = {
    has: (bin) => Bun.which(bin) !== null,
    ghLoggedIn: once(() => !sandbox && Bun.which("gh") !== null && Bun.spawnSync(["gh", "auth", "status"]).exitCode === 0),
    service: once(() => (sandbox ? "absent" : service("status", { factoryHome: process.env.FACTORY_HOME ?? join(homedir(), ".factory"), log: () => {} }) ?? "absent")),
  };
  cached = { at: Date.now(), probe };
  return probe;
}

export const skippedSteps = (db: Database) => (getMeta(db, "setup_skipped") ?? "").split(",").filter(Boolean);

export function skipStep(db: Database, id: string, skip: boolean) {
  if (!STEP_IDS.includes(id)) throw new Error(`no setup step "${id}"; steps: ${STEP_IDS.join(", ")}`);
  const rest = skippedSteps(db).filter((s) => s !== id);
  setMeta(db, "setup_skipped", (skip ? [...rest, id] : rest).join(","));
}

export function setupSteps(o: { repo: string; skipped?: string[]; probe?: Probe }): Step[] {
  const probe = o.probe ?? realProbe();
  const written = existsSync(join(o.repo, ".factory", "factory.yaml"));
  const f = written ? readFactory(o.repo) : {};
  const budget = (f.budget ?? {}) as Record<string, unknown>;
  const lacks = ["per_ticket", "per_day"].filter((k) => !budget[k]).map((k) => `budget.${k}`)
    .concat((["merge", "max_running"] as const).filter((k) => (f as Record<string, unknown>)[k] == null));
  const harness = ["claude", "codex"].filter((b) => probe.has(b));
  const gh = probe.has("gh");
  const skipped = o.skipped ?? [];
  const steps: Step[] = [];
  const add = (id: string, label: string, ok: boolean, fix: string, detail: string | null = null) =>
    steps.push({ id, label, status: ok ? "ok" : skipped.includes(id) ? "skipped" : "missing", fix: ok ? null : fix, detail });
  add("herdr-core", "herdr-core (hc) is installed", probe.has("hc"), "install herdr-core, then check `hc --version`");
  add("gh", "GitHub CLI installed and logged in", gh && probe.ghLoggedIn(), gh ? "gh auth login" : "brew install gh && gh auth login");
  add("harness", "An agent harness (claude or codex) is on PATH", harness.length > 0, "npm install -g @anthropic-ai/claude-code", harness.join(", ") || null);
  add("service", "The daemon runs at login", probe.service() !== "absent", "factory service install");
  add("queue", "The queue is set in factory.yaml", !!f.queue?.github_project, "set queue: { github_project: owner/<n or title>, column: Ready, assignee: me } in .factory/factory.yaml");
  add("basics", "Budgets, merge gate and max_running are set", written && lacks.length === 0, "factory setup write --budget 3M/150k --merge human --max-running 3", written ? lacks.join(", ") || null : null);
  const onBranch = !written && sh(["git", "-C", o.repo, "show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`]).code === 0;
  add("factory-dir", ".factory/ is written", written, onBranch ? `review and merge the ${BRANCH} branch (git merge ${BRANCH})` : "factory setup write");
  return steps;
}

// status.json's `setup` field: only while the lead repo has no .factory/ in its checkout.
export function setupField(db: Database, repo: string, probe?: Probe) {
  return existsSync(join(repo, ".factory")) ? null : { steps: setupSteps({ repo, skipped: skippedSteps(db), probe }) };
}

export const showSteps = (steps: Step[]) => steps.map((s) =>
  `${s.status === "ok" ? "✓" : s.status === "skipped" ? "–" : "✗"} ${s.label}${s.detail ? ` (${s.detail})` : ""}${s.fix ? `\n    fix: ${s.fix}` : ""}${s.status === "skipped" ? `\n    skipped; factory setup unskip ${s.id}` : ""}`).join("\n");

export type Basics = { budget?: string; budgetDay?: string; merge?: string; maxRunning?: number; queue?: string };

const DEFAULTS = join(import.meta.dir, "../fixtures/acme-api/.factory");

const tokens = (text: string, what: string) => {
  if (!/^\d+(\.\d+)?[kKmM]?(\/\d+(\.\d+)?[kKmM]?)?$/.test(text)) throw new Error(`${what} "${text}" isn't tokens: 3M or 3M/150k`);
  const [input, output] = text.split("/");
  return output ? `{ input: ${input}, output: ${output} }` : `{ input: ${input} }`;
};

export function factoryYaml(o: { name: string; slug: string; blueprints: string[]; basics: Basics }) {
  const b = o.basics;
  if (b.merge && b.merge !== "human" && b.merge !== "auto") throw new Error(`--merge is human or auto, not "${b.merge}"`);
  if (b.maxRunning !== undefined && !(Number.isInteger(b.maxRunning) && b.maxRunning >= 1)) throw new Error("--max-running needs a whole number, 1 or more");
  return [
    "# .factory/factory.yaml, written by `factory setup write`. Edit it freely; `factory validate` checks it.",
    `name: ${o.name}`,
    ...(o.slug !== "unknown" ? [`repos: [${o.slug}]`] : []),
    ...(b.queue ? [`queue: { github_project: ${b.queue}, column: Ready, assignee: me }`] : []),
    "grooming:", "  agent: triager", `  blueprints: [${o.blueprints.join(", ")}]`, "  questions: [herdr, issue]",
    `max_running: ${b.maxRunning ?? 3}`,
    "defaults: { harness: claude, model: sonnet, effort: medium }",
    "budget:", `  per_ticket: ${tokens(b.budget ?? "3M/150k", "--budget")}`, "  headroom: 1.5", `  per_day: ${tokens(b.budgetDay ?? "40M/2M", "--budget-day")}`,
    "hard_stops: [push-to-main, outside-worktree, destructive-commands, secrets-in-output]",
    `merge: ${b.merge ?? "human"}`, "",
  ].join("\n");
}

// factory.yaml plus the default blueprints and agents, committed on factory/setup from a
// temporary worktree. Run again, it adds one more commit if anything changed.
export function writeSetup(o: { repo: string; name: string; slug: string; basics: Basics }) {
  const git = (...a: string[]) => sh(["git", "-C", o.repo, ...a]);
  const head = git("rev-parse", "--abbrev-ref", "HEAD");
  if (head.code !== 0) throw new Error(`${o.repo} isn't a git checkout with a commit yet: ${head.out}`);
  if (head.out === BRANCH) throw new Error(`${o.repo} is on ${BRANCH}; switch to your own branch first, setup writes there from the side`);
  // Check the values before a worktree exists.
  factoryYaml({ name: o.name, slug: o.slug, blueprints: [], basics: o.basics });
  const tmp = mkdtempSync(join(tmpdir(), "factory-setup-"));
  const wt = join(tmp, "wt");
  const known = git("show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`).code === 0;
  const add = git("worktree", "add", ...(known ? [wt, BRANCH] : ["-b", BRANCH, wt, "HEAD"]));
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
  try {
    const dir = join(wt, ".factory");
    mkdirSync(dir, { recursive: true });
    for (const sub of ["blueprints", "agents"]) if (existsSync(join(DEFAULTS, sub))) cpSync(join(DEFAULTS, sub), join(dir, sub), { recursive: true });
    const blueprints = readdirSync(join(dir, "blueprints")).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
    writeFileSync(join(dir, "factory.yaml"), factoryYaml({ name: o.name, slug: o.slug, blueprints, basics: o.basics }));
    const results = validateDir(dir);
    const bad = results.filter((r) => r.errors.length);
    if (bad.length) throw new Error(`the files fail the schema check:\n${bad.map((r) => `${r.path}: ${r.errors.join("; ")}`).join("\n")}`);
    const g = (...a: string[]) => sh(["git", "-C", wt, ...a]);
    g("add", "-A", ".factory");
    const changed = g("diff", "--cached", "--quiet").code !== 0;
    if (changed) {
      const c = g("commit", "-q", "-m", "factory: set up .factory/ (factory setup write)");
      if (c.code !== 0) throw new Error(`git commit failed: ${c.out}`);
    }
    return { branch: BRANCH, committed: changed, sha: g("rev-parse", "--short", "HEAD").out, files: results.map((r) => r.path), from: head.out };
  } finally {
    git("worktree", "remove", "--force", wt);
    rmSync(tmp, { recursive: true, force: true });
  }
}
