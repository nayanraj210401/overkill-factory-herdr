import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBlueprint } from "./runner.ts";
import { validateDir, validateFile } from "./validate.ts";
import { loadDraft } from "./dryrun.ts";
import { buildBlueprints } from "./blueprints.ts";
import { exampleStepsDir, installExampleSteps, SHIPPED_STEPS } from "./steps.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/acme-api/.factory");

// A repo with the sample .factory/ and an account of its own (FACTORY_HOME).
const setup = () => {
  const repo = mkdtempSync(join(tmpdir(), "steps-repo-"));
  cpSync(FIXTURE, join(repo, ".factory"), { recursive: true });
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "steps-home-"));
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  return { repo, home: process.env.FACTORY_HOME, write, bp: (name: string, text: string) => write(join(repo, ".factory/blueprints", `${name}.yaml`), text) };
};
const errorsOf = (repo: string) => Object.fromEntries(validateDir(join(repo, ".factory")).filter((r) => r.errors.length).map((r) => [r.path, r.errors]));

test("one step is shared by two blueprints: each stage gets its agent and output, and keeps its own graph", () => {
  const { repo } = setup();
  const feature = loadBlueprint(repo, "feature").stages;
  const bugfix = loadBlueprint(repo, "bugfix").stages;
  expect(feature.review).toEqual({ step: "review", agent: "reviewer", next: ["pr"], on_fail: "implement" });
  expect(bugfix.review).toEqual(feature.review);
  expect(feature.pr).toEqual({ step: "write-pr", agent: "pr-writer", requires: "ready", output: "PR.md", template: "pr-readable", next: ["merge"] });
  expect(loadBlueprint(repo, "chore").stages.pr).toEqual(feature.pr);
  expect(errorsOf(repo)).toEqual({});
});

test("a field on the stage wins over the step's, in that blueprint only", () => {
  const { repo, bp } = setup();
  bp("chore", "name: chore\nstart: implement\nstages:\n  implement: { step: build, next: [verify] }\n  verify: { step: run-tests, max_retries: 5, next: [end], on_fail: implement }\n");
  expect(loadBlueprint(repo, "chore").stages.verify).toMatchObject({ check: "tests", max_retries: 5 });
  expect(loadBlueprint(repo, "bugfix").stages.verify).toMatchObject({ check: "tests", max_retries: 2 });
  expect(loadBlueprint(repo, "feature").stages.implement).toEqual({ step: "build", agent: "builder", per: "slice", next: ["verify"] });
});

test("the repo's step wins over the account's; without one, the account's library is used", () => {
  const { repo, home, write } = setup();
  write(join(home, "steps", "spec-lite.yaml"), "description: A short spec.\nagent: spec-writer\noutput: NOTES.md\n");
  write(join(repo, ".factory/blueprints/lite.yaml"), "name: lite\nstart: spec\nstages:\n  spec: { step: spec-lite, next: [end] }\n");
  expect(loadBlueprint(repo, "lite").stages.spec).toMatchObject({ output: "NOTES.md" });
  write(join(repo, ".factory/steps/spec-lite.yaml"), "description: Ours.\nagent: spec-writer\noutput: INTENT.md\n");
  expect(loadBlueprint(repo, "lite").stages.spec).toMatchObject({ output: "INTENT.md" });
  // The account's own write-spec loses to the repo's copy.
  write(join(home, "steps", "write-spec.yaml"), "description: x\nagent: planner\n");
  expect(loadBlueprint(repo, "feature").stages.spec.agent).toBe("spec-writer");
  rmSync(join(repo, ".factory/steps/write-spec.yaml"));
  expect(loadBlueprint(repo, "feature").stages.spec.agent).toBe("planner");
});

test("an unknown step fails validate, naming the blueprint and the stage, and the blueprint won't load", () => {
  const { repo, bp } = setup();
  bp("lite", "name: lite\nstart: spec\nstages:\n  spec: { step: ghost, next: [end] }\n");
  expect(errorsOf(repo)["blueprints/lite.yaml"]).toEqual(['stages.spec.step: no step "ghost": looked in .factory/steps/ghost.yaml, then ~/.factory/steps/ghost.yaml']);
  expect(() => loadBlueprint(repo, "lite")).toThrow('blueprint "lite": stages.spec.step: no step "ghost"');
  // A step the example library has says where to copy it from.
  rmSync(join(repo, ".factory/steps/review.yaml"));
  expect(errorsOf(repo)["blueprints/bugfix.yaml"]![0]).toContain("the example library has one: copy it from examples/steps/review.yaml");
  bp("lite", "name: lite\nstart: spec\nstages:\n  spec: { step: ../agents/builder, next: [end] }\n");
  expect(errorsOf(repo)["blueprints/lite.yaml"]![0]).toContain("is not a step name");
});

test("a step naming an agent the repo doesn't have is the same error an inline stage gives", () => {
  const { repo, write, bp } = setup();
  write(join(repo, ".factory/steps/migrate.yaml"), "description: Run the migration.\nagent: migrator\n");
  bp("db", "name: db\nstart: a\nstages:\n  a: { step: migrate, next: [b] }\n  b: { agent: migrator, next: [end] }\n");
  const [step, inline] = errorsOf(repo)["blueprints/db.yaml"]!;
  expect(step).toBe("stages.a.agent: no file agents/migrator.md (from step migrate)");
  expect(inline).toBe("stages.b.agent: no file agents/migrator.md");
});

test("a step file is checked like any other: unknown keys, and the graph, are errors", () => {
  expect(validateFile("steps/x.yaml", "description: x\nagent: builder\nnext: [end]\n")).toEqual([expect.stringContaining("next: unknown key")]);
  expect(validateFile("steps/x.yaml", "agent: builder\n")).toEqual(["file: missing description"]);
  expect(validateFile("blueprints/x.yaml", "name: x\nstart: a\nstages:\n  a: { step: build, nxt: [end] }\n")[0]).toContain("nxt: unknown key");
  const { repo, write } = setup();
  write(join(repo, ".factory/steps/bad.yaml"), "description: x\ncheck: vibes\n");
  expect(errorsOf(repo)["steps/bad.yaml"]![0]).toContain('"vibes" is not one of');
  // A step that fails its check fails the blueprint that names it, too.
  write(join(repo, ".factory/blueprints/lite.yaml"), "name: lite\nstart: a\nstages:\n  a: { step: bad, next: [end] }\n");
  expect(() => loadBlueprint(repo, "lite")).toThrow(".factory/steps/bad.yaml");
});

test("inline stages are unchanged, beside stages that name a step", () => {
  const { repo, bp } = setup();
  const inline = { agent: "builder", per: "slice", next: ["verify"] };
  bp("mixed", "name: mixed\nstart: implement\nstages:\n  implement: { agent: builder, per: slice, next: [verify] }\n  verify: { step: run-tests, next: [end], on_fail: implement }\n");
  expect(loadBlueprint(repo, "mixed").stages).toEqual({ implement: inline, verify: { step: "run-tests", check: "tests", max_retries: 2, next: ["end"], on_fail: "implement" } });
});

test("the sample blueprints on shared steps run exactly what they ran inline", () => {
  const { repo, bp } = setup();
  // The feature blueprint as it was before steps, stage for stage.
  bp("inline", `name: inline
orchestrator: foreman
start: spec
stages:
  spec:      { agent: spec-writer, output: INTENT.md, next: [plan, implement] }
  plan:      { agent: planner, output: SLICES.md, next: [implement] }
  implement: { agent: builder, per: slice, next: [verify] }
  verify:    { check: evidence, next: [holdout], on_fail: implement, max_retries: 3 }
  holdout:   { agent: checker, next: [review], on_fail: implement, max_retries: 3 }
  review:    { agent: reviewer, next: [pr], on_fail: implement }
  pr:        { agent: pr-writer, requires: ready, output: PR.md, template: pr-readable, next: [merge] }
  merge:     { gate: human, next: [end] }
`);
  const strip = (stages: Record<string, any>) => Object.fromEntries(Object.entries(stages).map(([id, { step: _, ...s }]) => [id, s]));
  expect(strip(loadBlueprint(repo, "feature").stages)).toEqual(loadBlueprint(repo, "inline").stages);
});

test("the dry run counts a step's max_retries, and the Blueprint page names the step", () => {
  const { repo } = setup();
  const g = loadDraft("name: chore\nstart: a\nstages:\n  a: { step: build, next: [v] }\n  v: { step: run-tests, next: [end], on_fail: a }\n", undefined, repo);
  expect(g.stages.v.max_retries).toBe(2);
  expect(() => loadDraft("name: chore\nstart: a\nstages:\n  a: { step: ghost, next: [end] }\n", undefined, repo)).toThrow(/invalid:\n  stages\.a\.step: no step "ghost"/);
  const feature = buildBlueprints(null, repo).blueprints.find((b) => b.name === "feature")!;
  expect(feature.stages.find((s) => s.id === "spec")).toMatchObject({ step: "write-spec", agent: "spec-writer", role: "spec" });
});

test("a gate a step sets warns like an inline one", () => {
  const { repo, write } = setup();
  write(join(repo, ".factory/steps/merge.yaml"), "description: Merges itself.\ngate: auto\n");
  const chore = validateDir(join(repo, ".factory")).find((r) => r.path === "blueprints/chore.yaml")!;
  expect(chore.warnings?.[0]).toContain("stages.merge.gate is auto");
});

test("the example steps install into the account's example library once, and never overwrite yours", () => {
  const { home } = setup();
  const shipped = readdirSync(SHIPPED_STEPS).map((f) => f.slice(0, -5)).sort();
  expect(installExampleSteps(home).sort()).toEqual(shipped);
  writeFileSync(join(exampleStepsDir(home), "review.yaml"), "description: Mine.\nagent: reviewer\n");
  expect(installExampleSteps(home)).toEqual([]);
  expect(Bun.file(join(exampleStepsDir(home), "review.yaml")).text()).resolves.toContain("Mine.");
  for (const f of readdirSync(SHIPPED_STEPS)) expect(validateFile(`steps/${f}`, require("node:fs").readFileSync(join(SHIPPED_STEPS, f), "utf8"))).toEqual([]);
  expect(existsSync(join(home, "steps"))).toBe(false); // the shared library is yours to fill
});
