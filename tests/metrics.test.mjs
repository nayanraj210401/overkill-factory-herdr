import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMetrics, headlineTiles, minutes, chartsFor, chartCards, chartAsset, PALETTE } from "../lib/metrics.js";

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

test("durations", () => {
  assert.deepEqual([minutes(45), minutes(90), minutes(3000)], ["45m", "1.5h", "2.1d"]);
});

test("charts per tab: every time series the sample has, opened vs merged together, spend parts stacked", () => {
  const byTab = (tab) => chartsFor(doc.ranges["7"]).filter((c) => c.tab === tab).map((c) => `${c.id}:${c.kind}:${c.series.length}`);
  assert.deepEqual(byTab("Throughput"), ["time-to-pr:line:1", "prs:line:2", "interactions:line:1"]);
  assert.deepEqual(byTab("Cost"), ["spend:line:1", "tokens:line:1", "by-agent:stacked:3", "by-model:stacked:2"]);
  assert.deepEqual(byTab("Quality"), ["reverts:line:1", "first-try:line:1"]);
  assert.deepEqual(byTab("Benchmarks"), []);
});

test("a metrics.json from before the per-day series still gets the charts it has data for", () => {
  const { opened_per_day, time_to_pr_per_day, usd_by_agent_per_day, usd_by_model_per_day, revert_rate_per_day, first_try_per_day, tokens_in_per_day, ...old } = doc.ranges["7"];
  assert.deepEqual(chartsFor(old).map((c) => c.id), ["interactions", "spend"]);
});

test("spend by model folds past five into Other, biggest first; nothing spent is one flat series", () => {
  const days = ["2026-11-20", "2026-11-21"];
  const r = { ...doc.ranges["7"], days, merged_per_day: [0, 0], first_try_per_day: [null, null], usd_by_model_per_day: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `m${n}`, values: [n, null] })), usd_by_agent_per_day: [] };
  const charts = Object.fromEntries(chartsFor(r).map((c) => [c.id, c]));
  assert.deepEqual(charts["by-model"].series.map((s) => [s.name, s.values]), [["m6", [6, null]], ["m5", [5, null]], ["m4", [4, null]], ["m3", [3, null]], ["Other", [3, 0]]]);
  assert.equal(charts["by-model"].value, "$21.00");
  assert.deepEqual(charts["by-agent"].series, [{ name: "Spend", values: [0, 0] }]);
  assert.equal(charts["by-agent"].note, "nothing spent yet");
  assert.equal(charts["first-try"].value, "–");
});

test("cards: headline, legend colours for the appearance, a dashed key for the budget, the image path", () => {
  const cards = chartCards(doc, "7", "Throughput", "dark", (f) => `x/${f}`);
  const prs = cards.find((c) => c.id === "prs");
  assert.deepEqual(prs.legend, [{ name: "Opened", color: PALETTE.dark[0] }, { name: "Merged", color: PALETTE.dark[1] }]);
  assert.equal(prs.image, `x/${doc.charts["7"].prs.dark}`);
  assert.deepEqual(cards.find((c) => c.id === "time-to-pr").legend, []); // one series: the title names it
  const light = chartCards(doc, "30", "Cost", "light", (f) => f);
  const tokens = light.find((c) => c.id === "tokens");
  assert.deepEqual(tokens.legend, [{ name: "Input tokens", color: PALETTE.light[0] }, { name: "Daily budget", color: null }]);
  assert.equal(tokens.image, doc.charts["30"].tokens.light);
  assert.match(tokens.image, /^30-tokens-light-[0-9a-f]{10}\.svg$/);
  assert.equal(chartCards({ ranges: doc.ranges }, "7", "Cost", "light", (f) => f)[0].image, null); // not drawn yet
});

test("chart paths are relative to Herdr's folder: the sample in place, a real factory through its link", () => {
  assert.equal(chartAsset("/u/.config/herdr-app/factory-data/acme-api", "/u/.config/herdr-app", "7-a.svg"), "factory-data/acme-api/charts/7-a.svg");
  assert.equal(chartAsset("/u/.factory/acme-api", "/u/.config/herdr-app", "7-a.svg"), "factory-charts/acme-api/7-a.svg");
});
