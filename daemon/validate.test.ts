import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateAccount, validateDir, validateFile } from "./validate.ts";

test("the sample .factory/ from plan.md is valid", () => {
  const results = validateDir(join(import.meta.dir, "../fixtures/acme-api/.factory"));
  expect(results.map((r) => r.path)).toContain("blueprints/feature.yaml");
  expect(results.filter((r) => r.errors.length)).toEqual([]);
});

test("unknown keys, wrong types and bad enums are named, one line each", () => {
  const errors = validateFile("factory.yaml", "name: x\nmax_runing: 3\nmerge: sometimes\nrepos: acme/api\n");
  expect(errors).toEqual([
    "max_runing: unknown key (allowed: name, repos, cross_check, tickets, queue, grooming, max_running, defaults, budget, plan, learn, review, away, cloud, artifacts, maintainer, verify, memory, ready, quality_floor, hard_stops, merge, merge_method, secrets, mcp, V2_UI, V2_SIDEBAR)",
    'merge: "sometimes" is not one of human, auto',
    "repos: expected a list of text, got string",
  ]);
  expect(validateFile("factory.yaml", "repos: [a]\n")).toEqual(["file: missing name"]);
});

test("blueprint stages must reference each other", () => {
  const yaml = "name: b\nstart: spec\nstages:\n  spec: { agent: w, next: [plan, end] }\n  verify: { check: evidence, on_fail: build, gate: maybe }\n";
  expect(validateFile("blueprints/b.yaml", yaml)).toEqual([
    'stages.verify.gate: "maybe" is not one of human, auto',
    'stages.spec.next: no stage "plan"',
    'stages.verify.on_fail: no stage "build"',
  ]);
});

test("agents need a header with a role and a prompt; bad YAML and stray files are reported", () => {
  expect(validateFile("agents/a.md", "---\nrole: review\n---\nGrade the diff.\n")).toEqual([]);
  expect(validateFile("agents/a.md", "---\nmodel: opus\n---\nx\n")).toEqual(["file: needs role, or from another agent"]);
  expect(validateFile("agents/a.md", "no header")).toEqual(["agent: needs a YAML header between --- lines, then the prompt"]);
  expect(validateFile("triggers/t.yaml", "on: [unclosed")[0]).toStartWith("YAML:");
  expect(validateFile("notes.txt", "")[0]).toStartWith("not a .factory file kind");
});

test("every agent, orchestrator, grooming blueprint and trigger blueprint a factory names has its file", () => {
  const home = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "names-home-")); // no example library installed yet
  try { namesCheck(); } finally { process.env.FACTORY_HOME = home; }
});
function namesCheck() {
  const dir = mkdtempSync(join(tmpdir(), "factory-names-"));
  const put = (p: string, text: string) => { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text); };
  put("factory.yaml", "name: t\ngrooming: { agent: triager, blueprints: [feature, bugfix] }\n");
  put("blueprints/feature.yaml", "name: feature\norchestrator: foreman\nstart: a\nstages:\n  a: { agent: builder, next: [end] }\n");
  put("triggers/t.yaml", "on: manual\nblueprint: nope\n");
  put("agents/builder.md", "---\nrole: build\n---\nBuild.\n");
  const errors = validateDir(dir).flatMap((f) => f.errors.map((e) => `${f.path}: ${e}`));
  expect(errors).toEqual([
    "blueprints/feature.yaml: orchestrator: no file agents/foreman.md; the example library has one: copy it from examples/agents/foreman.md in the factory's repo, or ask Overwatch",
    "factory.yaml: grooming.agent: no file agents/triager.md; the example library has one: copy it from examples/agents/triager.md in the factory's repo, or ask Overwatch",
    "factory.yaml: grooming.blueprints: no file blueprints/bugfix.yaml",
    "triggers/t.yaml: blueprint: no file blueprints/nope.yaml",
  ]);
  // Installed, the library's copy is named (yours first); an agent no library has gets no hint.
  const lib = join(process.env.FACTORY_HOME!, "examples", "agents");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "foreman.md"), "---\nrole: orchestrator\n---\nMine.\n");
  writeFileSync(join(lib, "migrator.md"), "---\nrole: build\n---\nMigrate.\n");
  put("blueprints/feature.yaml", "name: feature\norchestrator: foreman\nstart: a\nstages:\n  a: { agent: builder, next: [b] }\n  b: { agent: migrator, next: [c] }\n  c: { agent: ghost, next: [end] }\n");
  expect(validateDir(dir).find((f) => f.path === "blueprints/feature.yaml")!.errors).toEqual([
    "orchestrator: no file agents/foreman.md; the example library has one: copy it from ~/.factory/examples/agents/foreman.md, or ask Overwatch",
    "stages.b.agent: no file agents/migrator.md; the example library has one: copy it from ~/.factory/examples/agents/migrator.md, or ask Overwatch",
    "stages.c.agent: no file agents/ghost.md",
  ]);
}

test("the default .factory/ that setup and init copy names only files it has", () => {
  const errors = validateDir(join(import.meta.dir, "../fixtures/acme-api/.factory")).flatMap((f) => f.errors.map((e) => `${f.path}: ${e}`));
  expect(errors).toEqual([]);
});

test("duplicate keys are caught, per block, not across blocks or list items", async () => {
  const { duplicateKeys } = await import("./validate.ts");
  expect(duplicateKeys("merge: human\nname: x\nmerge: auto\n")).toEqual(["line 3: merge appears twice; YAML would keep only this one"]);
  expect(duplicateKeys("a:\n  x: 1\nb:\n  x: 2\n")).toEqual([]);
  expect(duplicateKeys("variants:\n  - name: a\n  - name: b\n")).toEqual([]);
  expect(duplicateKeys("a:\n  x: 1\n  x: 2\n")).toEqual(["line 3: x appears twice; YAML would keep only this one"]);
});

test("cloud.on_sleep is move or off, in factory.yaml and in the account's config.yaml", () => {
  expect(validateFile("factory.yaml", "name: x\ncloud: { on_sleep: move }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: x\ncloud: { on_sleep: off }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: x\ncloud: { on_sleep: always }\n")).toEqual(['cloud.on_sleep: "always" is not one of move, off']);
  expect(validateFile("factory.yaml", "name: x\ncloud: { on_slep: move }\n")[0]).toContain("cloud.on_slep: unknown key");
  expect(validateAccount("cloud: { on_sleep: move }\n")).toEqual([]);
  expect(validateAccount("cloud: { on_sleep: maybe }\n")).toEqual(['cloud.on_sleep: "maybe" is not one of move, off']);
});
