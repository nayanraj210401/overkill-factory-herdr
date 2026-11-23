// Shared steps (plan: Blueprints). A step is one stage's work as its own file: the agent,
// output, template, prompt, check, per, requires, gate and a default max_retries, with a
// one-line description. A blueprint stage names it (`spec: { step: write-spec, next: [plan] }`)
// and keeps the graph (next, on_fail, start); any field the stage sets wins over the step's.
// A stage without `step:` is written out in full, as before.
//
// `step: <name>` loads from the repo's .factory/steps/<name>.yaml, then the account's
// <FACTORY_HOME>/steps/<name>.yaml, the library every repo shares, and nowhere else. The
// shipped examples (examples/steps/ here) are installed into <FACTORY_HOME>/examples/steps/,
// beside your own; setup copies the ones a repo's blueprints name into its .factory/steps/,
// like the example agents. An example is never run: a stage loads its repo's or account's file.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { validateFile } from "./validate.ts";

export const SHIPPED_STEPS = join(import.meta.dir, "../examples/steps");
const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");
export const stepsDir = (home = factoryHome()) => join(home, "steps");
export const exampleStepsDir = (home = factoryHome()) => join(home, "examples", "steps");

// A step's name is a file name: no path in it.
export const badStepName = (name: string) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..");

// The file step `name` loads from for `repo` (null: the account's only), and how to name it.
export function stepFile(repo: string | null, name: string): { file: string; label: string } | null {
  if (badStepName(name)) return null;
  const own = repo ? join(repo, ".factory", "steps", `${name}.yaml`) : null;
  if (own && existsSync(own)) return { file: own, label: `.factory/steps/${name}.yaml` };
  const shared = join(stepsDir(), `${name}.yaml`);
  return existsSync(shared) ? { file: shared, label: `~/.factory/steps/${name}.yaml` } : null;
}

export function missingStep(name: string) {
  if (badStepName(name)) return `"${name}" is not a step name (a file name under steps/)`;
  const ex = exampleStepFile(name);
  return `no step "${name}": looked in .factory/steps/${name}.yaml, then ~/.factory/steps/${name}.yaml${ex ? `; the example library has one: copy it from ${ex.label.replace(/ \(shipped\)$/, "")}${ex.label.startsWith("~") ? "" : " in the factory's repo"}` : ""}`;
}

export type Step = Record<string, unknown> & { description?: string };

// Step `name` as `repo` runs it, checked; null when there is none.
export function loadStep(repo: string | null, name: string): Step | null {
  const at = stepFile(repo, name);
  if (!at) return null;
  const text = readFileSync(at.file, "utf8");
  const errors = validateFile(`steps/${name}.yaml`, text);
  if (errors.length) throw new Error(`${at.label}: ${errors[0]}`);
  return (Bun.YAML.parse(text) as Step) ?? {};
}

// A blueprint's stages with each `step:` filled in: the step's fields under the stage's own.
// The stage keeps `step` so pages can name it. A step that can't load goes to `missing`
// (the stage then stays as written); without `missing`, it throws.
export function applySteps<S extends Record<string, any>>(stages: Record<string, S>, repo: string | null, missing?: (id: string, error: string) => void): Record<string, S> {
  const out: Record<string, S> = {};
  for (const [id, s] of Object.entries(stages ?? {})) {
    if (typeof s?.step !== "string") { out[id] = s; continue; }
    let step: Step | null = null;
    let error: string | null = null;
    try { step = loadStep(repo, s.step); if (!step) error = missingStep(s.step); } catch (e) { error = (e as Error).message; }
    if (error) {
      if (!missing) throw new Error(`stages.${id}.step: ${error}`);
      missing(id, error);
      out[id] = s;
      continue;
    }
    const { description: _, ...fields } = step!;
    out[id] = { ...fields, ...s } as S;
  }
  return out;
}

const yamls = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(dir, f)) : []);

// The steps you have in <FACTORY_HOME>/steps/ and <FACTORY_HOME>/examples/steps/, for `factory validate`.
export const stepFiles = (home?: string) => yamls(stepsDir(home));
export const exampleStepFiles = (home?: string) => yamls(exampleStepsDir(home));

// Setup: the shipped example steps into <FACTORY_HOME>/examples/steps/, once each. A file
// already there is yours and is never overwritten; one shipped later is added.
export function installExampleSteps(home?: string) {
  const dir = exampleStepsDir(home);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const from of yamls(SHIPPED_STEPS)) {
    const to = join(dir, basename(from));
    if (existsSync(to)) continue;
    copyFileSync(from, to);
    written.push(basename(from).replace(/\.ya?ml$/, ""));
  }
  return written;
}

// The example step called `name`: yours in <FACTORY_HOME>/examples/steps/ first, then the shipped one.
export function exampleStepFile(name: string, home?: string): { file: string; label: string } | null {
  if (badStepName(name)) return null;
  const own = join(exampleStepsDir(home), `${name}.yaml`);
  if (existsSync(own)) return { file: own, label: `~/.factory/examples/steps/${name}.yaml` };
  const shipped = join(SHIPPED_STEPS, `${name}.yaml`);
  return existsSync(shipped) ? { file: shipped, label: `examples/steps/${name}.yaml (shipped)` } : null;
}

// The steps a .factory/ folder's blueprints name.
export function neededSteps(dir: string): string[] {
  const names = new Set<string>();
  for (const f of yamls(join(dir, "blueprints"))) {
    let b: any = null;
    try { b = Bun.YAML.parse(readFileSync(f, "utf8")); } catch {}
    for (const s of Object.values<any>(b?.stages && typeof b.stages === "object" ? b.stages : {})) if (typeof s?.step === "string") names.add(s.step);
  }
  return [...names].sort();
}
