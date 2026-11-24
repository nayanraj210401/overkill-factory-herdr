import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { stageOutcomes, stageHistory, blueprintStats, usedBy, allSteps, compareGrid, stepsTable, flowRows, failArcs, statTiles, isLive, leaves, took, passTo } from "../lib/blueprint-v2.js";

const doc = JSON.parse(readFileSync("fixtures/acme-api/blueprints.json", "utf8"));
const status = JSON.parse(readFileSync("fixtures/acme-api/status.json", "utf8"));
const feature = doc.blueprints.find((b) => b.name === "feature");

// --- the daemon's half ---

const row = (ticket, stage, started_at, ended_at, o = {}) => ({ ticket, title: `t${ticket}`, stage, started_at, ended_at, state: "merged", needs_text: null, ...o });
const STAGES = [{ id: "implement", on_fail: null }, { id: "verify", on_fail: "implement" }, { id: "pr", on_fail: null }];

test("a run fails when the ticket goes next to its on_fail, or parks on it with retries used up; open is running", () => {
  const runs = stageOutcomes([
    row(1, "implement", "2026-11-20T08:00:00Z", "2026-11-20T08:30:00Z"), row(1, "verify", "2026-11-20T08:30:00Z", "2026-11-20T08:32:00Z"),
    row(1, "implement", "2026-11-20T08:32:00Z", "2026-11-20T09:00:00Z"), row(1, "verify", "2026-11-20T09:00:00Z", "2026-11-20T09:05:00Z"),
    row(2, "verify", "2026-11-20T10:00:00Z", "2026-11-20T10:01:00Z", { state: "parked", needs_text: "Verify failed 4 times: flaky" }),
    row(3, "verify", "2026-11-20T10:00:00Z", "2026-11-20T10:01:00Z", { state: "parked", needs_text: "Budget used up" }),
    row(4, "implement", "2026-11-21T10:00:00Z", null, { state: "running" }),
  ], STAGES);
  assert.deepEqual(runs.map((r) => `${r.ticket}:${r.stage}:${r.outcome}`), ["1:implement:pass", "1:verify:fail", "1:implement:pass", "1:verify:pass", "2:verify:fail", "3:verify:stopped", "4:implement:running"]);
  assert.equal(runs[1].duration_s, 120);
});

test("a stage's history: the last 10 oldest first, pass/fail and median in the window, the 4 latest runs", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row(i, "verify", `2026-11-${String(5 + i).padStart(2, "0")}T00:00:00Z`, `2026-11-${String(5 + i).padStart(2, "0")}T00:0${(i % 3) + 1}:00Z`, i % 4 === 0 ? { state: "parked", needs_text: "Verify failed 4 times" } : {}));
  const h = stageHistory(stageOutcomes(rows, STAGES), "verify", "2026-11-14T00:00:00Z");
  assert.equal(h.last.length, 10);
  assert.deepEqual(h.last.slice(0, 3), ["pass", "pass", "fail"]); // runs 2, 3, 4
  assert.deepEqual([h.pass, h.fail, h.median_s], [3, 0, 120]); // runs 9, 10, 11 started in the window
  assert.deepEqual(h.recent.map((r) => r.ticket), [11, 10, 9, 8]);
  assert.deepEqual(stageHistory([], "verify", "x"), { pass: 0, fail: 0, median_s: null, last: [], recent: [] });
});

test("the stats strip: tickets in the window, the share never failed back, medians over PRs opened; nothing measured is null", () => {
  const runs = stageOutcomes([
    row(1, "implement", "2026-11-20T08:00:00Z", "2026-11-20T08:30:00Z"), row(1, "verify", "2026-11-20T08:30:00Z", "2026-11-20T08:32:00Z"), row(1, "implement", "2026-11-20T08:32:00Z", null, { state: "running" }),
    row(2, "implement", "2026-11-20T09:00:00Z", "2026-11-20T09:30:00Z"), row(2, "pr", "2026-11-20T09:30:00Z", "2026-11-20T09:40:00Z"),
    row(3, "implement", "2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z"),
  ], STAGES);
  const tickets = { 1: { ask_at: "2026-11-20T07:00:00Z", pr_at: null, usd: 9 }, 2: { ask_at: "2026-11-20T08:40:00Z", pr_at: "2026-11-20T09:40:00Z", usd: 1.5 } };
  assert.deepEqual(blueprintStats(runs, tickets, "2026-11-14T00:00:00Z"), { tickets: 2, clean: 0.5, ask_to_pr_min: 60, usd: 1.5 });
  assert.deepEqual(blueprintStats([], {}, "x"), { tickets: 0, clean: null, ask_to_pr_min: null, usd: null });
});

// --- the page's half ---

test("used-by and the compare grid: one row per step, a cell per blueprint, steps first met first", () => {
  assert.deepEqual(usedBy(doc, "build"), ["address-review", "bugfix", "chore", "feature"]);
  assert.deepEqual(usedBy(doc, "holdout"), ["feature"]);
  assert.deepEqual(usedBy(doc, null), []);
  const g = compareGrid(doc);
  assert.deepEqual(g.names, ["address-review", "bugfix", "chore", "feature", "maintenance"]);
  assert.deepEqual(g.rows[0], { step: "build", cells: ["fix", "implement", "implement", "implement", null], used: 4 });
  assert.deepEqual(g.rows.find((r) => r.step === "check-evidence").cells, [null, null, null, "verify", null]);
  assert.deepEqual(g.inline, ["maintenance.maintain"]);
  assert.deepEqual(allSteps(doc), g.rows.map((r) => r.step));
});

test("shared steps: what each leaves, who uses it, and its runs summed over every blueprint", () => {
  const rows = Object.fromEntries(stepsTable(doc).map((r) => [r.step, r]));
  assert.equal(rows["write-pr"].leaves, "PR.md");
  assert.equal(rows.review.leaves, "a review verdict");
  assert.equal(rows["run-tests"].leaves, "the tests check's result");
  assert.equal(rows.build.runs, doc.blueprints.flatMap((b) => b.stages).filter((s) => s.step === "build").reduce((a, s) => a + s.runs, 0));
  assert.equal(rows.build.file, ".factory/steps/build.yaml");
  assert.equal(leaves({ gate: "human" }), "the merged PR");
});

test("the flow: grooming first, then path order, with chips, routes, shared marks and the tickets on each stage now", () => {
  const rows = flowRows(doc, feature, status.tickets);
  assert.deepEqual(rows.map((r) => r.id), ["grooming", "spec", "plan", "implement", "verify", "holdout", "review", "pr", "merge"]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.plan.skip, true); // spec can go straight to implement
  assert.equal(by.implement.skip, false);
  assert.deepEqual(by.implement.here, [412]);
  assert.deepEqual(by.verify.here, []); // #425 is parked there, not running
  assert.equal(by.merge.you, true);
  assert.deepEqual([by.verify.kind, by.pr.kind, by.merge.kind, by.spec.kind], ["check, no agent", "ready rules", "human gate", "spec-writer agent"]);
  assert.equal(by.verify.failsTo, "implement");
  assert.equal(by.holdout.must, "a holdout verdict");
  assert.equal(by.build?.shared, undefined);
  assert.equal(by.implement.shared, "shared · 4 blueprints");
  assert.equal(by.holdout.shared, "only here");
  assert.equal(passTo(by.spec), "plan or implement");
  assert.equal(passTo(by.merge), "done");
});

test("fail-back arcs: one lane each, from the failing row to its on_fail row", () => {
  const arcs = failArcs(flowRows(doc, feature));
  assert.deepEqual(arcs.map((a) => [a.id, a.from, a.to, a.lane]), [["verify", 4, 3, 0], ["holdout", 5, 3, 1], ["review", 6, 3, 2]]);
});

test("the stats strip leaves out what wasn't measured, and a blueprint is live while a ticket runs on it", () => {
  assert.deepEqual(statTiles({ tickets: 3, clean: 1, ask_to_pr_min: null, usd: null }, 7).map((x) => x.value), ["3", "100%"]);
  assert.deepEqual(statTiles({ tickets: 8, clean: 0.75, ask_to_pr_min: 101, usd: 1.5 }, 7).map((x) => x.value), ["8", "75%", "1h 41m", "$1.50"]);
  assert.deepEqual(statTiles(undefined, 7), []); // an older daemon's file
  assert.equal(isLive(feature, status.tickets), true);
  assert.equal(isLive(doc.blueprints.find((b) => b.name === "address-review"), status.tickets), false);
  assert.deepEqual([took(null), took(9), took(3000), took(4200)], ["–", "9s", "50m", "1h 10m"]);
});

// --- the page itself, under tests/fake-gpui.mjs ---

const FAKE = pathToFileURL("tests/fake-gpui.mjs").href;
const LIB = pathToFileURL("lib/").href;
const EMPTY = `data:text/javascript,${encodeURIComponent("export default null;")}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "gpui-kit" || spec === "gpui-base" || spec === "herdr") return { url: FAKE, shortCircuit: true };
    if (spec === "./sample.js" || spec === "./sample-reviews.js" || spec === "./cli.js") return { url: EMPTY, shortCircuit: true };
    if (spec.startsWith("./lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(6), LIB).href, ctx);
    return next(spec, ctx);
  },
});
const { fake, cx } = await import(FAKE);
const { default: FactoryBlueprint } = await import("../mods/factory-blueprint/main.js");
const words = (el) => (typeof el === "object" ? (el.node ?? el).kids.map(words).join(" ") : String(el));
const page = (ui) => {
  fake.status = ui === undefined ? status : { ...status, ui };
  const v = new FactoryBlueprint();
  v.init({}, cx);
  v.doc = doc;
  return v;
};

test("with the gate off (or no ui at all) the page is the current one, word for word", () => {
  const none = words(page(undefined).render());
  assert.equal(words(page({ v2: false }).render()), none);
  assert.match(none, /OFF THE USUAL PATH|Grooming picks this blueprint/);
  assert.doesNotMatch(none, /Shared steps|LAST 10 RUNS/);
});

test("with the gate on: the three columns, the strip, the flow, and the keys move through it", () => {
  const v = page({ v2: true });
  let text = words(v.render());
  for (const w of ["BLUEPRINTS", "Shared steps", "Grooming picks it for: New behaviour", "no fail-back", "LAST 10 RUNS", "● #412 here", "may skip", "shared · 4 blueprints", "the triage agent"]) assert.ok(text.includes(w), w);
  const key = (k) => v.v2.key({ key: k, modifiers: {} }, { bps: v.v2.list(doc), b: v.v2.picked(v.v2.list(doc)), rows: flowRows(doc, v.v2.picked(v.v2.list(doc)), status.tickets), steps: stepsTable(doc) }, { stop_propagation() {}, notify() {} });
  key("j"); key("j"); key("j");
  text = words(v.render());
  assert.ok(text.includes("Changing build changes all 4 blueprints."));
  assert.ok(text.includes("Ask maintainer to change"));
  key("c");
  assert.match(words(v.render()), /Which step each blueprint runs/);
  key("s");
  assert.match(words(v.render()), /LEAVES BEHIND/);
  key("]");
  assert.equal(v.v2.picked(v.v2.list(doc)).name, "maintenance");
  assert.equal(v.v2.view, "flow");
  key("["); key("[");
  assert.equal(v.v2.picked(v.v2.list(doc)).name, "chore");
});

test("with the gate on, a pending request's draft still shows beside the blueprint it changes", () => {
  const v = page({ v2: true });
  const chore = doc.blueprints.find((b) => b.name === "chore");
  v.doc = { ...doc, drafts: [{ ticket: 77, title: "Skip verify on chores", name: "chore", error: null, start: "implement", orchestrator: "foreman",
    stages: chore.stages.filter((s) => s.id !== "verify").map((s) => (s.id === "implement" ? { ...s, next: ["pr"] } : s)) }] };
  v.v2.bp = "chore";
  const text = words(v.render());
  assert.match(text, /DRAFT FROM #77: Skip verify on chores · 1 removed, 1 changed/);
  assert.match(text, /Removed: verify/);
});
