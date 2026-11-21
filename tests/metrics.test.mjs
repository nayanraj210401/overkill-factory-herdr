import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMetrics, headlineTiles, minutes, bars } from "../lib/metrics.js";

const doc = JSON.parse(readFileSync(new URL("../fixtures/acme-api/metrics.json", import.meta.url), "utf8"));

test("the sample metrics.json keeps the contract", () => {
  assert.deepEqual(validateMetrics(doc), []);
  assert.deepEqual(validateMetrics({}), ["needs {ranges}"]);
});

test("tiles compare with the period before, knowing lower is better", () => {
  const r = { prs_opened: 3, prs_merged: 4, quality: [{ reverted: 1 }],
    headline: { time_to_pr_min: [50, 84], cost_per_pr_usd: [2.5, 2], interactions_per_pr: [1, 1], revert_rate: [0.25, 0] } };
  assert.deepEqual(headlineTiles(r, "7").map((x) => [x.value, x.sub]), [
    ["50m", "better than 1.4h"], ["$2.50", "worse than $2.00"], ["1", "same as the 7 days before"], ["25%", "1 of 4 merged PRs"],
  ]);
  const none = { ...r, prs_opened: 0, headline: { ...r.headline, time_to_pr_min: [0, 0] } };
  assert.deepEqual(headlineTiles(none, "30")[0], { label: "Time to PR", value: "–", sub: "no PRs the 30 days before" });
});

test("durations and bars", () => {
  assert.deepEqual([minutes(45), minutes(90), minutes(3000)], ["45m", "1.5h", "2.1d"]);
  assert.deepEqual(bars([1, null, 4, 2]), [0.25, 0, 1, 0.5]);
  assert.deepEqual(bars([0, 0]), [0, 0]);
});
