import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stageOrder, stageNotes, validateBlueprints, draftView, draftsFor } from "../lib/blueprints.js";

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
    ["holdout", true, "checker agent"], ["review", true, "reviewer agent"], ["pr", true, "pr-writer agent"], ["merge", true, "you"],
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

test("a draft is set against the current blueprint: stages marked added, changed or same, dropped ones listed", () => {
  const draft = { name: "feature", ticket: 12, title: "Skip holdout", start: "spec", orchestrator: "foreman", error: null,
    stages: feature.stages.filter((s) => s.id !== "holdout").map((s) => (s.id === "verify" ? { ...s, next: ["review"] } : s)).concat([{ id: "docs", agent: "writer", next: ["end"], runs: 0 }]) };
  const v = draftView(feature, draft);
  assert.deepEqual(v.removed.map((s) => s.id), ["holdout"]);
  assert.equal(v.summary, "1 added, 1 removed, 1 changed");
  const mark = Object.fromEntries(v.stages.map((s) => [s.id, s.change]));
  assert.deepEqual([mark.docs, mark.verify, mark.spec], ["added", "changed", "same"]);
  assert.equal(v.stages.find((s) => s.id === "docs").onPath, false); // nothing leads to it
  assert.equal(v.isNew, false);
});

test("a draft of a blueprint that doesn't exist yet is all new; a broken draft shows its error and no stages", () => {
  const fresh = draftView(null, { name: "db", ticket: 3, start: "a", stages: [{ id: "a", next: ["end"], runs: 0 }] });
  assert.deepEqual([fresh.isNew, fresh.summary, fresh.stages[0].change], [true, "a new blueprint", "added"]);
  const broken = draftView(feature, { name: "feature", ticket: 3, error: "stages.a.next: no stage \"x\"", stages: [] });
  assert.deepEqual([broken.error, broken.stages.length], ["stages.a.next: no stage \"x\"", 0]);
});

test("the page takes the drafts for the picked blueprint, and validateBlueprints checks their shape", () => {
  const d = { name: "feature", ticket: 1, start: "spec", stages: [{ id: "spec", next: ["end"], runs: 0 }] };
  const withDrafts = { ...doc, drafts: [d, { ...d, name: "chore" }] };
  assert.deepEqual(validateBlueprints(withDrafts), []);
  assert.equal(draftsFor(withDrafts, "feature").length, 1);
  assert.equal(draftsFor(doc, "feature").length, 0); // an older blueprints.json has no drafts
  assert.deepEqual(validateBlueprints({ ...doc, drafts: [{ name: "x" }] }), ["drafts[0]: needs {name, ticket, stages}"]);
});

test("a stage names its shared step; a draft that swaps the step is a change", () => {
  assert.equal(feature.stages.find((s) => s.id === "spec").step, "write-spec");
  assert.deepEqual(validateBlueprints({ days: 7, blueprints: [{ name: "x", stages: [{ id: "a", runs: 0, next: [], step: 3 }] }] }), ["blueprints[0].stages[0].step: needs text or null"]);
  const draft = { ...feature, ticket: 4, stages: feature.stages.map((s) => (s.id === "spec" ? { ...s, step: "write-spec-lite" } : s)) };
  assert.equal(draftView(feature, draft).stages.find((s) => s.id === "spec").change, "changed");
});
