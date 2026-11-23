import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRuns, kindCounts, filterRuns, duration, runWhat, startedAt, runModel } from "../lib/runs.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/acme-api/runs.json", import.meta.url), "utf8"));

test("the fixture's runs.json passes the contract, newest first", () => {
  assert.deepEqual(validateRuns(fixture), []);
  const times = fixture.runs.map((r) => r.started_at);
  assert.deepEqual(times, [...times].sort().reverse());
});

test("a run with a bad kind or a missing field is refused", () => {
  assert.deepEqual(validateRuns({}), ["needs {runs: []}"]);
  const run = fixture.runs[0];
  assert.match(validateRuns({ runs: [{ ...run, kind: "nap" }] })[0], /kind must be one of/);
  assert.match(validateRuns({ runs: [{ ...run, tokens_in: "1" }] })[0], /tokens_in/);
  assert.match(validateRuns({ runs: [{ ...run, harness: "" }] })[0], /needs harness/);
});

test("the kind chips count only the kinds that are there, and a kind filters the list", () => {
  assert.deepEqual(kindCounts(fixture.runs).map((k) => [k.id, k.n]), [["stage", 7], ["grooming", 1], ["cloud", 1], ["benchmark", 1]]);
  assert.equal(filterRuns(fixture.runs, null).length, fixture.runs.length);
  assert.deepEqual(filterRuns(fixture.runs, "cloud").map((r) => r.id), [7]);
});

test("run labels", () => {
  assert.equal(duration(null), "running");
  assert.equal(duration(45), "45s");
  assert.equal(duration(540), "9m");
  assert.equal(duration(7200), "2.0h");
  assert.equal(runWhat({ kind: "stage", stage: "plan" }), "Stage · plan");
  assert.equal(runWhat({ kind: "grooming", stage: "groom" }), "Grooming");
  assert.equal(startedAt("2026-11-21T09:05:00Z"), "Nov 21 09:05");
  assert.equal(runModel({ harness: "claude", model: "claude-opus-5-5" }), "claude-opus-5-5");
  assert.equal(runModel({ harness: "codex", model: "gpt-5" }), "codex gpt-5");
  assert.equal(runModel({ harness: "codex", model: null }), "codex");
});
