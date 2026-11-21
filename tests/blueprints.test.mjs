import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stageOrder, stageNotes, validateBlueprints } from "../lib/blueprints.js";

const doc = JSON.parse(readFileSync(new URL("../fixtures/acme-api/blueprints.json", import.meta.url), "utf8"));
const feature = doc.blueprints.find((b) => b.name === "feature");

test("the sample blueprints.json keeps the contract", () => {
  assert.deepEqual(validateBlueprints(doc), []);
  assert.deepEqual(validateBlueprints({ days: 7, blueprints: [{ name: "x", stages: [{ id: "a" }] }] }), ["blueprints[0].stages[0]: needs {id, runs, next}"]);
  assert.deepEqual(validateBlueprints(null), ["needs {days, blueprints: []}"]);
});

test("stages follow each first next from the start; skipped ones come after", () => {
  assert.deepEqual(stageOrder(feature).map((s) => [s.id, s.onPath, s.who]), [
    ["spec", true, "spec-writer agent"], ["plan", true, "planner agent"], ["implement", true, "builder agent"], ["verify", true, "check: evidence"],
    ["holdout", true, "checker agent"], ["review", true, "reviewer agent"], ["pr", true, "daemon"], ["merge", true, "you"],
  ]);
  const skip = { start: "a", stages: [{ id: "a", next: ["c"], runs: 0 }, { id: "b", next: ["c"], runs: 0 }, { id: "c", next: ["end"], runs: 0 }] };
  assert.deepEqual(stageOrder(skip).map((s) => [s.id, s.onPath]), [["a", true], ["c", true], ["b", false]]);
});

test("notes say what the boxes can't: choices, failure routes, gates, verdicts", () => {
  const notes = stageNotes(feature);
  assert.ok(notes.includes("spec can go to plan or implement; the foreman agent picks."));
  assert.ok(notes.includes("review fails back to implement."));
  assert.ok(notes.includes("holdout must end with a holdout verdict."));
  assert.ok(notes.includes("merge waits for you."));
});
