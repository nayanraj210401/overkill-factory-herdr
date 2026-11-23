import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBenchmarks, variantRows, benchmarkMarkdown, suiteNote } from "../lib/benchmarks.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/acme-api/benchmarks.json", import.meta.url), "utf8"));

test("the fixture's benchmarks.json passes the contract", () => {
  assert.deepEqual(validateBenchmarks(fixture), []);
});

test("a suite with a missing number, no variants or a winner that isn't a variant is refused", () => {
  const s = fixture.suites[0];
  assert.deepEqual(validateBenchmarks({}), ["needs {suites: []}"]);
  assert.match(validateBenchmarks({ suites: [{ ...s, variants: [] }] })[0], /needs variants/);
  assert.match(validateBenchmarks({ suites: [{ ...s, winner: "nobody" }] })[0], /not a variant/);
  assert.match(validateBenchmarks({ suites: [{ ...s, variants: [{ ...s.variants[0], usd: "1" }] }] })[0], /number for usd/);
});

test("the table has a row per variant, and only the winner's is marked", () => {
  const rows = variantRows(fixture.suites[0]);
  assert.deepEqual(rows.map((r) => [r.cells[0], r.best]), [["baseline", false], ["opus-builder", true]]);
  assert.deepEqual(rows[1].cells, ["opus-builder", "73% (11/15)", "468k / 25k", "$0.61", "9.2m", "104 vs 88"]);
});

test("BENCHMARK.md carries the table and the recommendation; a stop at the cap is said", () => {
  const md = benchmarkMarkdown(fixture);
  assert.match(md, /\| \*\*opus-builder\*\* \(recommended\) \| 73% \(11\/15\)/);
  assert.match(md, /Recommendation: opus-builder passed 73%/);
  assert.match(suiteNote({ ...fixture.suites[0], stopped: "cap" }), /stopped at its spending cap/);
  assert.match(benchmarkMarkdown({ suites: [] }), /No benchmark has run yet/);
});
