import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveFactories, parseDoc, combineRange, combineMetrics, combinedTiles, columnRows } from "../lib/combine.js";
import { validateMetrics, chartsFor } from "../lib/metrics.js";
import { keyAction } from "../lib/keys.js";

const sample = JSON.parse(readFileSync(new URL("../fixtures/acme-api/metrics.json", import.meta.url), "utf8"));

const days = ["2026-11-20", "2026-11-21", "2026-11-22"];
const range = (o) => ({
  days, prs_opened: 0, prs_merged: 0, quality: [], cycle: { pickup_to_pr_min: 10, pr_to_merge_min: 20, pickup_to_merge_min: 30 },
  headline: { time_to_pr_min: [50, 60], cost_per_pr_usd: [0, 0], interactions_per_pr: [0, 0], revert_rate: [0, 0] },
  merged_per_day: [0, 0, 0], opened_per_day: [0, 0, 0], usd_per_day: [0, 0, 0], ...o,
});

test("counts, tokens and spend are summed, per day by date", () => {
  const a = range({ prs_opened: 2, prs_merged: 3, merged_per_day: [1, 2, 0], usd_per_day: [1, 2, 3], tokens_in_per_day: [10, 20, 30], tokens_in_cap: 100,
    usd_by_stage: [{ name: "implement", usd: 4 }], usd_by_agent_per_day: [{ name: "builder", values: [1, 1, 1] }] });
  // An older metrics.json: one day behind, so its first day falls outside the newest range.
  const b = range({ days: ["2026-11-19", "2026-11-20", "2026-11-21"], prs_opened: 1, prs_merged: 1, merged_per_day: [5, 1, 0], usd_per_day: [9, 1, 1],
    tokens_in_per_day: [99, 5, 5], tokens_in_cap: 50, usd_by_stage: [{ name: "implement", usd: 1 }, { name: "review", usd: 6 }],
    usd_by_agent_per_day: [{ name: "builder", values: [7, 2, 0] }, { name: "reviewer", values: [0, 0, 3] }] });
  const r = combineRange([{ name: "a", r: a }, { name: "b", r: b }]);
  assert.deepEqual(r.days, days);
  assert.deepEqual([r.prs_opened, r.prs_merged], [3, 4]);
  assert.deepEqual(r.merged_per_day, [2, 2, 0]);
  assert.deepEqual(r.usd_per_day, [2, 3, 3]);
  assert.deepEqual(r.tokens_in_per_day, [15, 25, 30]);
  assert.equal(r.tokens_in_cap, 150);
  assert.deepEqual(r.usd_by_stage, [{ name: "review", usd: 6 }, { name: "implement", usd: 5 }]);
  assert.deepEqual(r.usd_by_agent_per_day, [{ name: "builder", values: [3, 1, 1] }, { name: "reviewer", values: [0, 3, 0] }]);
  assert.equal(combineRange([{ name: "a", r: a }, { name: "b", r: { ...b, tokens_in_cap: null } }]).tokens_in_cap, null); // a factory without a cap
});

test("rates are recomputed from their counts, never averaged", () => {
  // a: 1 of 1 merged reverted (100%); b: 0 of 9 (0%). The naive mean says 50%; the truth is 10%.
  const a = range({ prs_opened: 1, prs_merged: 1, merged_per_day: [1, 0, 0], revert_rate_per_day: [1, null, null], first_try_per_day: [0, null, null],
    quality: [{ blueprint: "feature", merged: 1, reverted: 1, retries_per_ticket: 3 }],
    headline: { time_to_pr_min: [50, 60], cost_per_pr_usd: [10, 0], interactions_per_pr: [2, 0], revert_rate: [1, 0] }, opened_per_day: [1, 0, 0], interactions_per_day: [2, null, null] });
  const b = range({ prs_opened: 9, prs_merged: 9, merged_per_day: [9, 0, 0], revert_rate_per_day: [0, null, null], first_try_per_day: [1, null, null],
    quality: [{ blueprint: "feature", merged: 9, reverted: 0, retries_per_ticket: 0 }],
    headline: { time_to_pr_min: [20, 60], cost_per_pr_usd: [1, 0], interactions_per_pr: [1, 0], revert_rate: [0, 0] }, opened_per_day: [9, 0, 0], interactions_per_day: [1, null, null] });
  const r = combineRange([{ name: "a", r: a }, { name: "b", r: b }]);
  assert.equal(r.headline.revert_rate[0], 0.1);
  assert.deepEqual(r.revert_rate_per_day, [0.1, null, null]);
  assert.deepEqual(r.first_try_per_day, [0.9, null, null]);
  assert.equal(r.headline.cost_per_pr_usd[0], 1.9); // (10 + 9) / 10 PRs
  assert.equal(r.headline.interactions_per_pr[0], 1.1);
  assert.deepEqual(r.interactions_per_day, [1.1, null, null]);
  assert.deepEqual(r.quality, [{ blueprint: "feature", merged: 10, reverted: 1, retries_per_ticket: 0.3 }]);
  assert.equal(combinedTiles(r)[3].value, "10%");
  // No earlier counts in metrics.json, so no comparison with the period before.
  assert.equal(r.headline.cost_per_pr_usd[1], null);
});

test("a median can't be combined: it is shown per factory, and its chart is left out", () => {
  const a = range({ prs_opened: 1, time_to_pr_per_day: [50, null, null] });
  const b = range({ prs_opened: 0, time_to_pr_per_day: [null, null, null], cycle: undefined });
  const r = combineRange([{ name: "acme", r: a }, { name: "shop", r: b }]);
  assert.equal(r.headline.time_to_pr_min[0], null);
  assert.equal(r.cycle, undefined);
  assert.deepEqual(r.per_factory.map((f) => [f.name, f.time_to_pr, f.cycle?.pickup_to_merge_min ?? null]), [["acme", "50m", 30], ["shop", "–", null]]);
  assert.deepEqual(combinedTiles(r)[0], { label: "Time to PR", value: "per factory", sub: "acme 50m · shop –" });
  assert.ok(!chartsFor(r).some((c) => c.id === "time-to-pr"));
});

test("the sample combined with itself doubles the sums and keeps the rates", () => {
  const doc = combineMetrics([{ name: "a", doc: sample }, { name: "b", doc: sample }]);
  for (const k of ["7", "30"]) {
    const [one, two] = [sample.ranges[k], doc.ranges[k]];
    assert.equal(two.prs_merged, one.prs_merged * 2);
    assert.deepEqual(two.merged_per_day, one.merged_per_day.map((n) => n * 2));
    assert.equal(two.headline.cost_per_pr_usd[0], one.headline.cost_per_pr_usd[0]);
    assert.deepEqual(two.first_try_per_day, one.first_try_per_day);
  }
  // Charts that come out of it: every one but the median's and the per-factory target's.
  assert.deepEqual(chartsFor(doc.ranges["7"]).map((c) => c.id), ["prs", "interactions", "spend", "tokens", "by-agent", "by-model", "reverts", "first-try"]);
});

test("agents-live.json's factories, and a file through its validator", () => {
  assert.deepEqual(liveFactories({ factories: [{ name: "a", dir: "/h/a", repos: [] }, { name: "b" }] }), [{ name: "a", dir: "/h/a" }]);
  assert.deepEqual(liveFactories(null), []);
  assert.deepEqual(parseDoc(null, validateMetrics, "m.json"), { doc: null, error: null });
  assert.deepEqual(parseDoc("{}", validateMetrics, "m.json"), { doc: null, error: "m.json: needs {ranges}" });
  assert.match(parseDoc("{", validateMetrics, "m.json").error, /^m\.json: /);
});

test("columns: each day a share of the series' highest, a gap kept", () => {
  assert.deepEqual(columnRows([{ name: "x", values: [1, null, 4] }, { name: "z", values: [0, 0] }]), [{ name: "x", cols: [0.25, null, 1] }, { name: "z", cols: [0, 0] }]);
});

test("⇧A toggles all factories; a stays Reviews' approve", () => {
  assert.deepEqual(keyAction({ key: "a", modifiers: { shift: true } }), { kind: "all-factories" });
  assert.deepEqual(keyAction({ key: "a", modifiers: {} }), { kind: "approve" });
});
