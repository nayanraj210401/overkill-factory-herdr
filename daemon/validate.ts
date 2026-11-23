// `factory validate`: checks every .factory/ file against its kind's shape, one
// line per problem. Unknown keys are errors, so a typo never silently does nothing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { whyNotTunable } from "./learn.ts";
import { PLACEHOLDERS, templateErrors } from "./prompts.ts";
import { featureErrors } from "./features.ts";
import { exampleFile, FACTORY_AGENTS, isFactoryAgent } from "./agents.ts";
import { skillErrors, skillFileErrors } from "./skills.ts";
import { applySteps } from "./steps.ts";

type Rule =
  | "string" | "number" | "boolean" | "strings" | "any"
  | { enum: string[] }
  | { object: Record<string, Rule>; required?: string[]; open?: boolean }
  | { map: Rule }
  | { list: Rule }
  | { either: [Rule, Rule] }; // the first for a plain value, the second for a map

const str = "string" as const, num = "number" as const, strs = "strings" as const;
const open = { object: {}, open: true };
const gate = { enum: ["human", "auto"] };
// away: in factory.yaml and in the account's config.yaml (daemon/away.ts).
const AWAY: Rule = { object: { blueprints: strs, budget: str, review_rounds: num, never: strs, min_agreement: num } };
// cloud: in factory.yaml and in the account's config.yaml (daemon/sleep.ts).
const CLOUD: Rule = { object: { on_sleep: { enum: ["move", "off"] } } };
// artifacts: in factory.yaml and in the account's config.yaml (daemon/artifacts.ts).
export const PUBLISHABLE = ["INTENT.md", "SLICES.md", "PR.md", "HANDOFF.md"];
const ARTIFACTS: Rule = { object: { as: { enum: ["artifact", "doc", "off"] }, publish: { list: { enum: PUBLISHABLE } } } };
const TICKET_SOURCE = { enum: ["github", "linear", "local"] };
const LEARN_TARGETS = ["cost_per_pr", "time_to_pr", "interactions_per_pr", "review_rounds_per_pr"];

// What a stage runs. A shared step (steps/<name>.yaml, daemon/steps.ts) holds the same fields
// and a description; a stage naming it with `step:` keeps the graph and may override any field.
const WORK = {
  agent: str, prompt: str, check: { enum: ["evidence", "tests", "lint", "factory"] }, output: str,
  max_retries: num, per: { enum: ["ticket", "slice"] }, requires: str, template: str, gate,
} satisfies Record<string, Rule>;
const STAGE: Rule = { object: { step: str, ...WORK, next: strs, on_fail: str, stages: "any" } };

export const KINDS: Record<string, Rule> = {
  factory: {
    required: ["name"],
    object: {
      name: str, repos: strs, cross_check: str, tickets: { either: [TICKET_SOURCE, { object: { source: TICKET_SOURCE, split: gate } }] },
      queue: { object: { github_project: str, column: str, assignee: str } },
      grooming: { object: { agent: str, blueprints: strs, questions: strs, product_owner: str } },
      max_running: num, defaults: { object: { harness: str, model: str, effort: str } },
      budget: { object: { per_ticket: open, per_day: open, headroom: num, floor: "any", learning: "any", show_cost: str } }, plan: { object: { pause_at: "any" } }, learn: { object: { target: { enum: LEARN_TARGETS }, tunable: strs, arms: open, warmup_tickets: num, pause_above: "any", promote_after: num, review_every: num, retire_after: num } }, review: { object: { pushbacks: num, judge_model: str, round_budget: "any" }, open: true }, away: AWAY, cloud: CLOUD, artifacts: ARTIFACTS, maintainer: { object: { gate } },
      verify: { object: { features: str } },
      ready: strs, quality_floor: strs, hard_stops: strs, merge: gate, merge_method: { enum: ["squash", "merge", "rebase"] }, secrets: { map: "any" }, mcp: "any",
    },
  },
  blueprint: { required: ["name", "start", "stages"], object: { name: str, orchestrator: str, start: str, stages: { map: STAGE } } },
  step: { required: ["description"], object: { description: str, ...WORK } },
  agent: {
    object: {
      // overwatch, babysit, maintain and learn are the factory agents' roles (agents.ts).
      role: { enum: ["orchestrator", "triage", "spec", "plan", "build", "review", "verify", "scorer", "maintain", "overwatch", "babysit", "learn"] },
      territory: str, // one line: what only this agent acts on, for every brief's neighbour map
      harness: str, model: str, effort: str, from: str, tools: strs, mcp: strs, skills: strs, context: strs,
    },
  },
  trigger: {
    required: ["on", "blueprint"],
    object: { on: { enum: ["manual", "project_ready", "pr_review_comment", "schedule"] }, filter: open, blueprint: str, concurrency: num, schedule: str, every: str, run: { enum: ["ticket", "health"] }, setup: strs, enabled: "boolean" },
  },
  benchmark: {
    required: ["target", "variants"],
    object: {
      target: { object: { stage: str, blueprint: str } }, size: { enum: ["smoke", "mini", "full"] },
      tasks: { object: { from: { enum: ["merged-prs"] }, repo: str, pick: num, holdout: { enum: ["tests-added-by-pr"] } } },
      variants: { list: { object: { name: str, set: { map: "any" } }, required: ["name"] } },
      score: { list: { enum: ["holdout_pass", "cost_usd", "minutes", "diff_lines"] } },
      limits: { object: { max_usd: num, max_tokens: num, parallel: num } }, schedule: str,
    },
  },
};

// <FACTORY_HOME>/config.yaml, the account-wide layer (daemon/account.ts).
export const ACCOUNT: Rule = {
  object: {
    plan: { object: { limits: { object: { five_hour: "any", week: "any" } }, pause_at: "any" } },
    budget: { object: { per_day: { object: { input: "any", output: "any" } } } },
    away: AWAY,
    cloud: CLOUD,
    artifacts: ARTIFACTS,
    profile: { object: { taste: strs, rules: strs } },
    claude: { object: { path: str } }, // which claude every session runs (claude-bin.ts)
  },
};

export function validateAccount(text: string): string[] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch (e) { return [`YAML: ${(e as Error).message.split("\n")[0]}`]; }
  const errors = duplicateKeys(text);
  if (doc != null) check(doc, ACCOUNT, "", errors);
  awayRange(doc, errors);
  return errors;
}

// A share, so 85 (meaning 85%) can't quietly close the gate for good.
function awayRange(doc: unknown, errors: string[]) {
  const m = (doc as any)?.away?.min_agreement;
  if (typeof m === "number" && (m < 0 || m > 1)) errors.push("away.min_agreement: a share from 0 to 1, like 0.85 (0 turns the agreement gate off)");
}

// `every: 30m | 6h | 1d`, in milliseconds; null when it isn't that.
export function parseEvery(v: unknown): number | null {
  const m = typeof v === "string" ? v.trim().match(/^(\d+)([mhd])$/) : null;
  return m && Number(m[1]) > 0 ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] : null;
}

// A benchmark's `schedule:` in milliseconds: hourly, daily, weekly, or the triggers' 30m / 6h / 1d.
export function parseSchedule(v: unknown): number | null {
  const named = ({ hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000 } as Record<string, number>)[String(v).trim()];
  return named ?? parseEvery(v);
}

// Where a variant's `set:` path may start: agents.<name>.<key>, factory.<key>…, blueprints.<name>.…
export const SET_HEADS = ["agents", "factory", "blueprints"];
const AGENT_KEYS = Object.keys((KINDS.agent as { object: object }).object);

const kindOf = (path: string) =>
  path === "factory.yaml" ? "factory"
  : path === "blueprint.yaml" || /^blueprints\/[^/]+\.ya?ml$/.test(path) ? "blueprint"
  : /^steps\/[^/]+\.ya?ml$/.test(path) ? "step"
  : /^agents\/[^/]+\.md$/.test(path) ? "agent"
  : /^prompts\/[^/]+\.md$/.test(path) ? "prompt"
  : /^triggers\/[^/]+\.ya?ml$/.test(path) ? "trigger"
  : /^benchmarks\/[^/]+\.ya?ml$/.test(path) ? "benchmark"
  : /^features\/[^/]+\.md$/.test(path) ? "feature"
  : /^skills\/[^/]+\/SKILL\.md$/.test(path) ? "skill"
  : /^skills\/[^/]+\/./.test(path) ? "skill-file" // a skill's scripts and references: Claude Code's to read
  : null;

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "a map" : typeof v);

function check(v: unknown, rule: Rule, at: string, errors: string[]) {
  const bad = (want: string) => errors.push(`${at}: expected ${want}, got ${typeName(v)}`);
  if (rule === "any") return;
  if (typeof rule === "object" && "either" in rule) return check(v, rule.either[typeof v === "object" && v !== null && !Array.isArray(v) ? 1 : 0], at, errors);
  if (rule === "string") return typeof v === "string" || bad("text");
  if (rule === "number") return typeof v === "number" || bad("a number");
  if (rule === "boolean") return typeof v === "boolean" || bad("true or false");
  if (rule === "strings") return (Array.isArray(v) && v.every((x) => typeof x === "string")) || bad("a list of text");
  if ("enum" in rule) return rule.enum.includes(v as string) || errors.push(`${at}: "${v}" is not one of ${rule.enum.join(", ")}`);
  if ("list" in rule) {
    if (!Array.isArray(v)) return bad("a list");
    return v.forEach((x, i) => check(x, rule.list, `${at}[${i}]`, errors));
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("a map");
  const o = v as Record<string, unknown>;
  if ("map" in rule) return Object.entries(o).forEach(([k, x]) => check(x, rule.map, `${at}.${k}`, errors));
  for (const k of rule.required ?? []) if (!(k in o)) errors.push(`${at || "file"}: missing ${k}`);
  for (const [k, x] of Object.entries(o)) {
    if (k in rule.object) check(x, rule.object[k], at ? `${at}.${k}` : k, errors);
    else if (!rule.open) errors.push(`${at ? `${at}.` : ""}${k}: unknown key (allowed: ${Object.keys(rule.object).join(", ")})`);
  }
}

// A blueprint's stages must name each other: start, next and on_fail.
function blueprintRefs(b: any, errors: string[]) {
  const ids = new Set(Object.keys(b?.stages ?? {}));
  if (b?.start && !ids.has(b.start)) errors.push(`start: no stage "${b.start}"`);
  for (const [id, s] of Object.entries<any>(b?.stages ?? {})) {
    for (const n of s?.next ?? []) if (n !== "end" && !ids.has(n)) errors.push(`stages.${id}.next: no stage "${n}"`);
    if (s?.on_fail && !ids.has(s.on_fail)) errors.push(`stages.${id}.on_fail: no stage "${s.on_fail}"`);
  }
}

// YAML keeps the last of two equal keys and drops the first without a word.
export function duplicateKeys(text: string): string[] {
  const errors: string[] = [];
  const scopes: { indent: number; keys: Set<string> }[] = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^(\s*)(- )?([A-Za-z_][\w.-]*):(\s|$)/);
    if (!m || line.trimStart().startsWith("#")) return;
    const indent = m[1].length + (m[2] ? 2 : 0);
    while (scopes.length && scopes.at(-1)!.indent > indent) scopes.pop();
    if (m[2] || !scopes.length || scopes.at(-1)!.indent < indent) scopes.push({ indent, keys: new Set() });
    const keys = scopes.at(-1)!.keys;
    if (keys.has(m[3])) errors.push(`line ${i + 1}: ${m[3]} appears twice; YAML would keep only this one`);
    keys.add(m[3]);
  });
  return errors;
}

export function validateFile(path: string, text: string): string[] {
  const kind = kindOf(path);
  if (!kind) return [`not a .factory file kind (factory.yaml, blueprints/, steps/, agents/, prompts/, triggers/, benchmarks/, features/, skills/<name>/SKILL.md)`];
  if (kind === "skill") return skillFileErrors(text);
  if (kind === "skill-file") return [];
  // flow-stack's feature map, copied by the migration (daemon/features.ts).
  if (kind === "feature") return featureErrors(text, path.slice("features/".length));
  if (kind === "prompt") {
    const name = path.slice("prompts/".length, -".md".length);
    return [...(text.trim() ? [] : ["prompt: the file is empty"]), ...templateErrors(name, text)];
  }
  let doc: unknown;
  try {
    if (kind === "agent") {
      const m = text.match(/^---\n([\s\S]*?)\n---\n/);
      if (!m) return ["agent: needs a YAML header between --- lines, then the prompt"];
      doc = Bun.YAML.parse(m[1]);
      if (!text.slice(m[0].length).trim()) return ["agent: the prompt after the header is empty"];
    } else doc = Bun.YAML.parse(text);
  } catch (e) {
    return [`YAML: ${(e as Error).message.split("\n")[0]}`];
  }
  const errors: string[] = duplicateKeys(kind === "agent" ? text.split(/\n---\n/)[0] : text);
  check(doc, KINDS[kind], "", errors);
  if (kind === "agent" && !(doc as any)?.role && !(doc as any)?.from) errors.push("file: needs role, or from another agent");
  if (kind === "blueprint") blueprintRefs(doc, errors);
  if (kind === "factory") {
    // The learner may only move settings; what steers the work stays yours.
    const tunable = (doc as any)?.learn?.tunable;
    if (Array.isArray(tunable)) for (const k of tunable) {
      const why = typeof k === "string" ? whyNotTunable(k) : null;
      if (why) errors.push(`learn.tunable: ${k} ${why}`);
    }
    // learn.arms: the values an experiment tries for a tunable setting (experiments.ts).
    const arms = (doc as any)?.learn?.arms;
    if (arms && typeof arms === "object") for (const [k, v] of Object.entries(arms)) {
      if (!Array.isArray(tunable) || !tunable.includes(k)) errors.push(`learn.arms.${k}: not in learn.tunable`);
      if (!Array.isArray(v) || v.length < 1) errors.push(`learn.arms.${k}: a list of values to try`);
    }
    const rb = (doc as any)?.review?.round_budget;
    if (rb !== undefined && !/^\s*(\d+(\.\d+)?\s*%|\d+(\.\d+)?\s*[kKmM]?(\s*\/\s*\d+(\.\d+)?\s*[kKmM]?)?)\s*$/.test(String(rb)))
      errors.push("review.round_budget: a share of the ticket's budget (25%) or tokens (200k, or 200k/20k for input/output)");
    const fl = (doc as any)?.budget?.floor;
    if (fl !== undefined && !/^\s*\d+(\.\d+)?\s*%?\s*$/.test(String(fl)))
      errors.push("budget.floor: a share of budget.per_ticket, like 50% or 0.5");
    awayRange(doc, errors);
  }
  if (kind === "trigger") {
    const t = doc as any;
    if (t?.on === "schedule" && parseEvery(t.every) === null) errors.push("every: a schedule trigger needs every: 30m, 6h or 1d");
    if (t?.on !== "schedule" && t?.every !== undefined) errors.push("every: only a schedule trigger has it");
    if (t?.run === "health" && !["schedule", "manual"].includes(t?.on)) errors.push("run: health runs on: schedule (or on: manual, by factory health only)");
    if (t?.run !== "health" && t?.setup !== undefined) errors.push("setup: only a run: health trigger has it");
  }
  if (kind === "benchmark") benchmarkRefs(doc, errors);
  return errors;
}

function benchmarkRefs(b: any, errors: string[]) {
  const t = b?.target;
  if (t && typeof t === "object" && !t.stage === !t.blueprint) errors.push("target: name exactly one of stage or blueprint");
  if (b?.schedule !== undefined && parseSchedule(b.schedule) === null) errors.push("schedule: hourly, daily, weekly, or 30m, 6h, 1d");
  const seen = new Set<string>();
  (Array.isArray(b?.variants) ? b.variants : []).forEach((v: any, i: number) => {
    if (seen.has(v?.name)) errors.push(`variants[${i}].name: "${v.name}" is used twice`);
    seen.add(v?.name);
    for (const path of Object.keys(v?.set ?? {})) {
      const parts = path.split(".");
      if (!SET_HEADS.includes(parts[0]) || parts.length < (parts[0] === "factory" ? 2 : 3))
        errors.push(`variants[${i}].set.${path}: use a dotted path like agents.builder.model, factory.defaults.model or blueprints.feature.stages.verify.max_retries`);
      else if (parts[0] === "agents" && !AGENT_KEYS.includes(parts[2]))
        errors.push(`variants[${i}].set.${path}: agents have no ${parts[2]} (allowed: ${AGENT_KEYS.join(", ")})`);
    }
  });
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

// Names that point at other files: a stage's agent and prompt, a blueprint's orchestrator, the
// grooming agent and the blueprints it may pick, a trigger's blueprint. A name with
// no file would break the first run, so it fails here for every user's factory.
function danglingNames(dir: string, paths: string[]): Record<string, string[]> {
  const base = (p: string, folder: string) => p.startsWith(`${folder}/`) ? p.slice(folder.length + 1).replace(/\.(md|ya?ml)$/, "") : null;
  // A factory agent (the maintainer, say) is there for every repo, with or without a file here.
  const agents = new Set([...paths.map((p) => base(p, "agents")).filter(Boolean), ...FACTORY_AGENTS]);
  const blueprints = new Set(paths.map((p) => base(p, "blueprints")).filter(Boolean));
  const prompts = new Set([...paths.map((p) => base(p, "prompts")).filter(Boolean), "stage"]); // stage.md is built in
  const parse = (p: string) => { try { return Bun.YAML.parse(readFileSync(join(dir, p), "utf8")) as any; } catch { return null; } };
  const out: Record<string, string[]> = {};
  const add = (p: string, e: string) => (out[p] ??= []).push(e);
  // A missing agent the example library has: say where to copy it from (agents.ts).
  const noAgent = (n: string) => {
    const ex = exampleFile(n);
    return `no file agents/${n}.md${ex ? `; the example library has one: copy it from ${ex.label.replace(/ \(shipped\)$/, "")}${ex.label.startsWith("~") ? "" : " in the factory's repo"}, or ask Overwatch` : ""}`;
  };
  for (const p of paths) {
    if (kindOf(p) === "blueprint") {
      const b = parse(p);
      if (typeof b?.orchestrator === "string" && !agents.has(b.orchestrator)) add(p, `orchestrator: ${noAgent(b.orchestrator)}`);
      // A stage's shared step: the repo's steps/, then the account's (steps.ts). Its fields count as the stage's.
      const raw = b?.stages && typeof b.stages === "object" ? b.stages : {};
      const stages = applySteps(raw, dirname(dir), (id, e) => add(p, `stages.${id}.step: ${e}`));
      const from = (id: string, k: string) => typeof raw[id]?.step === "string" && raw[id]?.[k] === undefined ? ` (from step ${raw[id].step})` : "";
      for (const [id, s] of Object.entries<any>(stages))
        if (typeof s?.agent === "string" && !agents.has(s.agent)) add(p, `stages.${id}.agent: ${noAgent(s.agent)}${from(id, "agent")}`);
      for (const [id, s] of Object.entries<any>(stages))
        if (typeof s?.prompt !== "string") continue;
        else if (s.prompt !== "stage" && s.prompt in PLACEHOLDERS) add(p, `stages.${id}.prompt: ${s.prompt} is not a stage template (it is for ${s.prompt === "groom" ? "grooming" : s.prompt === "handoff" ? "handoffs" : "overwatch"})${from(id, "prompt")}`);
        else if (!prompts.has(s.prompt)) add(p, `stages.${id}.prompt: no file prompts/${s.prompt}.md${from(id, "prompt")}`);
    } else if (p === "factory.yaml") {
      const g = parse(p)?.grooming;
      if (typeof g?.agent === "string" && !agents.has(g.agent)) add(p, `grooming.agent: ${noAgent(g.agent)}`);
      for (const n of Array.isArray(g?.blueprints) ? g.blueprints : []) if (!blueprints.has(n)) add(p, `grooming.blueprints: no file blueprints/${n}.yaml`);
    } else if (kindOf(p) === "trigger") {
      const n = parse(p)?.blueprint;
      if (typeof n === "string" && !blueprints.has(n)) add(p, `blueprint: no file blueprints/${n}.yaml`);
    }
  }
  return out;
}

// An agent file's listed skills that don't exist for it: in `repo`'s .factory/skills/, else
// ~/.factory/skills/. A factory agent or an example passes no repo (skills.ts).
export function agentSkillErrors(text: string, repo: string | null): string[] {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  let doc: any = null;
  try { doc = m ? Bun.YAML.parse(m[1]) : null; } catch { return []; } // the schema check reports it
  return skillErrors(doc?.skills, [repo]);
}

export function validateDir(dir: string) {
  const paths = files(dir)
    .map((p) => relative(dir, p))
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")))
    .sort();
  const dangling = danglingNames(dir, paths);
  return paths.map((path) => {
    const text = readFileSync(join(dir, path), "utf8");
    const skills = kindOf(path) === "agent" ? agentSkillErrors(text, dirname(dir)) : [];
    const r: { path: string; errors: string[]; warnings?: string[]; off?: true } = { path, errors: [...validateFile(path, text), ...(dangling[path] ?? []), ...skills] };
    if (kindOf(path) === "trigger" && triggerOff(text)) r.off = true; // `factory validate` prints it "(off)"
    const w = [warningOf(path), ...gateWarnings(path, join(dir, path))].filter((x): x is string => !!x);
    if (w.length) r.warnings = w;
    return r;
  });
}

// A trigger file with `enabled: false`: valid, and never fires (triggers.ts).
function triggerOff(text: string) {
  try { return (Bun.YAML.parse(text) as any)?.enabled === false; } catch { return false; }
}

// A gate turned to auto: it passes without you, and for the merge gate the factory merges the PR
// itself. Never refused, always said (plan: Every gate is yours to set).
export function gateWarnings(path: string, file: string): string[] {
  const kind = kindOf(path);
  if (kind !== "blueprint" && kind !== "factory") return [];
  let doc: any;
  try { doc = Bun.YAML.parse(readFileSync(file, "utf8")); } catch { return []; }
  if (kind === "factory") return doc?.maintainer?.gate === "auto" ? ["maintainer.gate is auto: the maintainer's PRs merge themselves, and the account config and factory agents change on that merge, with nobody looking. Check the revert rate on Home"] : [];
  // A gate set by a shared step counts too; the repo is the folder above .factory/ (steps.ts).
  const stages = applySteps(doc?.stages && typeof doc.stages === "object" ? doc.stages : {}, dirname(file.endsWith(path) ? file.slice(0, -path.length - 1) : dirname(file)), () => {});
  return Object.entries<any>(stages).filter(([, s]) => s?.gate === "auto")
    .map(([id]) => `stages.${id}.gate is auto: this stage passes without you${(stages[id].next ?? []).every((n: string) => n === "end") ? ", and ready PRs of this blueprint merge themselves" : ""}. Check this blueprint's revert rate on Home`);
}

// Files that pass but do nothing: a repo's copy of a factory agent, or of Overwatch's template, is never read.
function warningOf(path: string) {
  if (path === "prompts/overwatch.md") return "ignored: Overwatch is one for every repo and uses the built-in template; change ~/.factory/agents/overwatch.md instead (through the maintainer)";
  const name = path.match(/^agents\/([^/]+)\.md$/)?.[1];
  return name && isFactoryAgent(name) ? `ignored: ${name} is a factory agent, one for every repo; change ~/.factory/agents/${name}.md instead (through the maintainer)` : null;
}
