// `factory setup`: the first-run checklist as data (docs/plan.md § First run), and
// `factory setup write`, which writes .factory/ into the checkout, where it stays local.
import { DEFAULT_MODEL } from "./models.ts";
import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { worktreeRoot } from "./herdr.ts";
import { getMeta, setMeta } from "./db.ts";
import { readFactory, sh } from "./runner.ts";
import { service } from "./service.ts";
import { validateDir } from "./validate.ts";
import { MAINTENANCE, NEVER_GROOMED } from "./groom.ts";
import { exampleFile, neededAgents } from "./agents.ts";
import { keepLocal } from "./local.ts";

export type Step = { id: string; label: string; status: "ok" | "missing" | "skipped"; fix: string | null; detail: string | null };
export type Probe = { has: (bin: string) => boolean; ghLoggedIn: () => boolean; service: () => string; trusted?: (dir: string) => boolean; flowStack?: (repo: string) => string[] };

export const STEP_IDS = ["herdr-core", "gh", "harness", "trust", "service", "queue", "basics", "factory-dir", "flow-stack"];

// flow-stack v1 on this machine or in this repo: what setup offers to migrate.
export function findFlowStack(o: { home: string | null; repo: string; plugins: string | null }) {
  const found: string[] = [];
  if (o.home && existsSync(join(o.home, ".flow-stack", "profile.md"))) found.push("~/.flow-stack/profile.md");
  if (existsSync(join(o.repo, ".flow"))) found.push(".flow/");
  const installed = o.plugins ? join(o.plugins, "installed_plugins.json") : null;
  if (o.plugins && (existsSync(join(o.plugins, "cache", "flow-stack")) || (installed && existsSync(installed) && readFileSync(installed, "utf8").includes("flow-stack")))) found.push("the flow-stack plugin");
  return found;
}
const pluginsDir = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "plugins") : join(homedir(), ".claude", "plugins"));

// Accepting the offer: one maintainer request, which runs the migration and turns its
// proposals into changes in the same PR. Asking again while one is open returns it.
export const MIGRATION_META = "flow_migration_request";
export const MIGRATION_REQUEST = "Migrate flow-stack into this factory: import its past tasks, decisions and lessons, and turn its profile, calibration and feature map into configuration";
export function migrationRequest(db: Database) {
  const id = Number(getMeta(db, MIGRATION_META));
  return id ? (db.query("SELECT id, state FROM tickets WHERE id = ?").get(id) as { id: number; state: string } | null) : null;
}

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
    // Tests never look in the real home: only the repo and the test's own Claude folder.
    flowStack: (repo) => findFlowStack({ home: sandbox ? null : process.env.HOME ?? homedir(), repo, plugins: sandbox && !process.env.CLAUDE_CONFIG_DIR ? null : pluginsDir() }),
  };
  cached = { at: Date.now(), probe };
  return probe;
}

// Claude Code asks "do you trust this folder?" the first time it opens one, and an
// unattended agent can't answer. Setup marks the folders the factory's agents work in
// (its data folder, with each ticket's folder, and the worktrees folder) as trusted in
// Claude Code's own config, the way accepting the prompt there does.
export const claudeConfig = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
export const trustFolders = () => [process.env.FACTORY_HOME ?? join(homedir(), ".factory"), worktreeRoot()];

const readConfig = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

// Trusted when the folder, or a folder above it, has accepted the prompt.
export function isTrusted(dir: string, file = claudeConfig()) {
  const projects = readConfig(file).projects ?? {};
  for (let d = dir; ; d = dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted) return true;
    if (dirname(d) === d) return false;
  }
}

export function trust(dirs = trustFolders(), file = claudeConfig()) {
  const config = readConfig(file);
  config.projects ??= {};
  const added = dirs.filter((d) => !isTrusted(d, file));
  for (const d of added) config.projects[d] = { ...config.projects[d], hasTrustDialogAccepted: true };
  if (!added.length) return added;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.factory-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, file); // whole or not at all: Claude Code reads this file too
  return added;
}

export const skippedSteps = (db: Database) => (getMeta(db, "setup_skipped") ?? "").split(",").filter(Boolean);

export function skipStep(db: Database, id: string, skip: boolean) {
  if (!STEP_IDS.includes(id)) throw new Error(`no setup step "${id}"; steps: ${STEP_IDS.join(", ")}`);
  const rest = skippedSteps(db).filter((s) => s !== id);
  setMeta(db, "setup_skipped", (skip ? [...rest, id] : rest).join(","));
}

export function setupSteps(o: { repo: string; skipped?: string[]; probe?: Probe; migration?: { id: number; state: string } | null }): Step[] {
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
  const untrusted = trustFolders().filter((d) => !(probe.trusted ?? isTrusted)(d));
  add("trust", "Claude Code trusts the factory's folders", untrusted.length === 0, "factory setup trust", untrusted.join(", ") || null);
  add("service", "The daemon runs at login", probe.service() !== "absent", "factory service install");
  add("queue", "The queue is set in factory.yaml", !!f.queue?.github_project, "set queue: { github_project: owner/<n or title>, column: Ready, assignee: me } in .factory/factory.yaml");
  add("basics", "Budgets, merge gate and max_running are set", written && lacks.length === 0, "factory setup write --budget 3M/150k --merge human --max-running 3", written ? lacks.join(", ") || null : null);
  add("factory-dir", ".factory/ is written", written, "factory setup write");
  // Offered only when there is something to migrate; the maintainer does it, as a PR.
  const flow = probe.flowStack?.(o.repo) ?? [];
  const m = o.migration?.state === "closed" ? null : o.migration; // closed unmerged: offered again
  if (flow.length)
    add("flow-stack", "flow-stack's history and settings are migrated (by the maintainer, as a PR)", !!m, "factory setup migrate", m ? `#${m.id}, ${m.state}` : `found ${flow.join(", ")}`);
  return steps;
}

// status.json's `setup` field: only while the lead repo has no .factory/ in its checkout.
export function setupField(db: Database, repo: string, probe?: Probe) {
  return existsSync(join(repo, ".factory")) ? null : { steps: setupSteps({ repo, skipped: skippedSteps(db), probe, migration: migrationRequest(db) }) };
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

export function factoryYaml(o: { name: string; slug: string; blueprints: string[]; basics: Basics; floor?: string[] }) {
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
    `defaults: { harness: claude, model: ${DEFAULT_MODEL}, effort: medium }`,
    "budget:", `  per_ticket: ${tokens(b.budget ?? "3M/150k", "--budget")}`, "  headroom: 1.5", `  per_day: ${tokens(b.budgetDay ?? "40M/2M", "--budget-day")}`,
    "hard_stops: [push-to-main, outside-worktree, destructive-commands, secrets-in-output]",
    ...(o.floor?.length ? [`quality_floor: [${o.floor.join(", ")}]`] : ["# quality_floor: [your test command]   (no test command found; the tests check and ready rule need one)"]),
    `merge: ${b.merge ?? "human"}`, "",
  ].join("\n");
}

// The repo's own test command, the checks no change may break. A guess from its files;
// factory.yaml is yours to change.
export function detectFloor(repo: string): string[] {
  const has = (f: string) => existsSync(join(repo, f));
  if (has("package.json")) {
    let pkg: any = {};
    try { pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")); } catch {}
    const test = pkg.scripts?.test;
    if (!test || /no test specified/.test(test)) return [];
    const pm = has("bun.lock") || has("bun.lockb") ? "bun run" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    return [pm === "bun run" ? "bun run test" : `${pm} test`];
  }
  if (has("Cargo.toml")) return ["cargo test"];
  if (has("go.mod")) return ["go test ./..."];
  if (has("pyproject.toml") || has("pytest.ini")) return ["pytest"];
  if (has("Makefile") && /^test:/m.test(readFileSync(join(repo, "Makefile"), "utf8"))) return ["make test"];
  return [];
}

// Blueprints a trigger starts (address-review, for review comments) aren't grooming's picks.
const triggered = (dir: string) => existsSync(join(dir, "triggers"))
  ? readdirSync(join(dir, "triggers")).flatMap((f) => [...readFileSync(join(dir, "triggers", f), "utf8").matchAll(/^blueprint:\s*(\S+)/gm)].map((m) => m[1]))
  : [];

// factory.yaml plus the default blueprints, the agents they name and prompt templates, written
// into the checkout's .factory/, which stays local (local.ts): never committed, and /.factory/
// goes in the repo's .git/info/exclude. Built and checked in a temporary folder first; a file
// already in .factory/ is yours and is never overwritten, so running it again adds only what's missing.
export function writeSetup(o: { repo: string; name: string; slug: string; basics: Basics }) {
  if (sh(["git", "-C", o.repo, "rev-parse", "--git-dir"]).code !== 0) throw new Error(`${o.repo} isn't a git checkout`);
  // Check the values before anything is written.
  factoryYaml({ name: o.name, slug: o.slug, blueprints: [], basics: o.basics });
  const tmp = mkdtempSync(join(tmpdir(), "factory-setup-"));
  try {
    const dir = join(tmp, ".factory");
    mkdirSync(dir, { recursive: true });
    for (const sub of ["blueprints", "prompts"]) if (existsSync(join(DEFAULTS, sub))) cpSync(join(DEFAULTS, sub), join(dir, sub), { recursive: true });
    // The maintenance agent's daily trigger, shipped with enabled: false so it stays off until you turn it on;
    // the built-in queue and review-comment triggers still run beside it.
    mkdirSync(join(dir, "triggers"), { recursive: true });
    cpSync(join(DEFAULTS, "triggers", `${MAINTENANCE}.yaml`), join(dir, "triggers", `${MAINTENANCE}.yaml`));
    const blueprints = readdirSync(join(dir, "blueprints")).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""))
      .filter((b) => !triggered(DEFAULTS).includes(b) && !NEVER_GROOMED.includes(b));
    writeFileSync(join(dir, "factory.yaml"), factoryYaml({ name: o.name, slug: o.slug, blueprints, basics: o.basics, floor: detectFloor(o.repo) }));
    // The repo gets only the agents its blueprints and grooming name, each from the example
    // library: yours in ~/.factory/examples/agents/ first, then the shipped one.
    mkdirSync(join(dir, "agents"), { recursive: true });
    for (const name of neededAgents(dir)) {
      const from = exampleFile(name);
      if (!from) throw new Error(`a blueprint names the agent ${name}, and the example library has no ${name}.md`);
      cpSync(from.file, join(dir, "agents", `${name}.md`));
    }
    const results = validateDir(dir);
    const bad = results.filter((r) => r.errors.length);
    if (bad.length) throw new Error(`the files fail the schema check:\n${bad.map((r) => `${r.path}: ${r.errors.join("; ")}`).join("\n")}`);
    const local = keepLocal(o.repo); // the exclude line before the first file lands
    const written: string[] = [];
    const kept: string[] = [];
    for (const r of results) {
      const to = join(o.repo, ".factory", r.path);
      if (existsSync(to)) { kept.push(r.path); continue; }
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(dir, r.path), to);
      written.push(r.path);
    }
    return { dir: join(o.repo, ".factory"), written, kept, excluded: local.excluded, tracked: local.tracked };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
