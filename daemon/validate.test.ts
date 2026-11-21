import { test, expect } from "bun:test";
import { join } from "node:path";
import { validateDir, validateFile } from "./validate.ts";

test("the sample .factory/ from plan.md is valid", () => {
  const results = validateDir(join(import.meta.dir, "../fixtures/acme-api/.factory"));
  expect(results.map((r) => r.path)).toContain("blueprints/feature.yaml");
  expect(results.filter((r) => r.errors.length)).toEqual([]);
});

test("unknown keys, wrong types and bad enums are named, one line each", () => {
  const errors = validateFile("factory.yaml", "name: x\nmax_runing: 3\nmerge: sometimes\nrepos: acme/api\n");
  expect(errors).toEqual([
    "max_runing: unknown key (allowed: name, repos, cross_check, tickets, queue, grooming, max_running, defaults, budget, plan, learn, review, away, maintainer, ready, quality_floor, hard_stops, merge, merge_method, secrets, mcp)",
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

test("duplicate keys are caught, per block, not across blocks or list items", async () => {
  const { duplicateKeys } = await import("./validate.ts");
  expect(duplicateKeys("merge: human\nname: x\nmerge: auto\n")).toEqual(["line 3: merge appears twice; YAML would keep only this one"]);
  expect(duplicateKeys("a:\n  x: 1\nb:\n  x: 2\n")).toEqual([]);
  expect(duplicateKeys("variants:\n  - name: a\n  - name: b\n")).toEqual([]);
  expect(duplicateKeys("a:\n  x: 1\n  x: 2\n")).toEqual(["line 3: x appears twice; YAML would keep only this one"]);
});
