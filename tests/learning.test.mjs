import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { learningView, settingLabel, showValue } from "../lib/learning.js";
import { chartsFor, chartCards, validateMetrics } from "../lib/metrics.js";

const doc = JSON.parse(readFileSync(new URL("../fixtures/acme-api/metrics.json", import.meta.url), "utf8"));
const H = "claude-haiku-5-5", S = "claude-sonnet-5-5";
const empty = (o = {}) => ({ ...doc, learning: { target: "cost_per_pr", hold: null, warmup: { merged: 12, needed: 20 }, budget: { spent: { input: 0, output: 0 }, cap: { input: 4e6, output: 2e5 } }, experiments: [], overrides: [], shifts: [], lessons: [], ...o } });

test("no learning in metrics.json: one message, nothing else", () => {
  const v = learningView({ ...doc, learning: null }, "7");
  assert.equal(v.state, "none");
  assert.match(v.message, /lead repo/);
});

test("warmup: nothing learned yet, the header says how far along, the target still shows", () => {
  const v = learningView(empty({ hold: "warming up: 12 of learn.warmup_tickets 20 tickets merged, so only logging" }), "7");
  assert.equal(v.state, "warmup");
  assert.match(v.message, /until 20 work tickets have merged \(8 to go\)/);
  assert.equal(v.header.status, "Warming up: 12 of 20 merged");
  assert.equal(v.header.held, true);
  assert.equal(v.header.target, "Cost per PR");
  assert.equal(v.header.value, "$2.04");
  assert.equal(v.header.trend, "better than $2.41 the 7 days before");
  assert.equal(v.header.budget, "0 of 4M in · 0 of 200k out");
  assert.equal(v.header.summary, "0 experiments, 0 decided · 0 shifts");
  // past warmup but nothing tried yet: a different reason, still empty
  assert.match(learningView(empty({ warmup: { merged: 25, needed: 20 } }), "7").message, /learn\.tunable/);
});

test("the header: a hold past warmup, the learning budget spent, no cap, no period before", () => {
  const spent = learningView(empty({ warmup: { merged: 30, needed: 20 }, hold: "today's learning budget is spent", budget: { spent: { input: 4.2e6, output: 1e5 }, cap: { input: 4e6, output: 2e5 } } }), "30").header;
  assert.equal(spent.status, "Held: today's learning budget is spent");
  assert.equal(spent.budgetSpent, true);
  assert.equal(spent.trend, "no merged work tickets the 30 days before");
  const open = learningView(empty({ warmup: { merged: 30, needed: 20 }, budget: { spent: { input: 1e6, output: 0 }, cap: null } }), "7").header;
  assert.deepEqual([open.status, open.held, open.budget, open.budgetShare], ["Experimenting", false, "1M in · 0 out, no cap", null]);
});

test("a decided experiment: its winner marked, the value in force, results per value, ε", () => {
  const v = learningView(doc, "7");
  assert.equal(v.state, "learning");
  assert.equal(v.header.summary, "2 experiments, 1 decided · 1 shift");
  const c = v.experiments[0];
  assert.deepEqual([c.title, c.context, c.status, c.epsilon, c.outcomes], ["model for builder", "feature/m", "decided: haiku", "ε 0.229", "19 outcomes"]);
  assert.deepEqual(c.rows[0], { value: "haiku", n: "7 +1 running", mean: "$1.62", first_try: "86%", revert_rate: "0%", floor: "ok", in_force: true, winner: true });
  assert.deepEqual(c.rows.map((r) => r.winner), [true, false, false]);
});

test("a below-floor arm and one not yet known; an undecided experiment wins nothing", () => {
  const c = learningView(doc, "7").experiments[1];
  assert.equal(c.status, "deciding");
  assert.deepEqual(c.rows.map((r) => [r.value, r.floor, r.winner]), [["60%", "ok", false], ["50%", "below", false], ["70%", "unknown", false]]);
  assert.equal(c.rows[1].first_try, "33%");
});

test("shifts: newest first; only one whose override is still active can be undone", () => {
  const l = doc.learning;
  const shifts = [
    { at: "2026-11-10T09:00:00.000Z", key: "agents.builder.model", context: "feature/m", from: S, to: "claude-opus-5-5", override: 2, why: "old" },
    l.shifts[0],
    { at: "2026-11-20T09:00:00.000Z", key: "budget.handoff_at_context", context: "bug/s", from: "70%", to: "60%", override: null, why: "file wins" },
  ];
  const rows = learningView({ ...doc, learning: { ...l, shifts } }, "7").shifts;
  assert.deepEqual(rows.map((r) => r.why), ["file wins", l.shifts[0].why, "old"]);
  assert.deepEqual(rows.map((r) => r.state), ["the file's value again", "in force", "undone or replaced"]);
  assert.equal(rows[1].line, "model for builder: sonnet → haiku");
  assert.equal(rows[1].at, "2026-11-19 15:02");
  assert.match(rows[0].undo.error, /nothing to undo/);
  assert.match(rows[2].undo.error, /already undone or replaced/);
});

test("undo: z or the button asks first, then runs `factory learn undo <key>`", () => {
  const [row] = learningView(doc, "7").shifts;
  assert.equal(row.undo.error, undefined);
  assert.deepEqual(row.undo.args, ["learn", "undo", "agents.builder.model"]);
  assert.equal(row.undo.confirm, "Undo");
  assert.equal(row.undo.title, "Undo agents.builder.model?");
  assert.match(row.undo.detail, /use sonnet again, not haiku/);
});

test("lessons: grouped by area in order, the most used first", () => {
  const areas = learningView(doc, "7").lessons;
  assert.deepEqual(areas.map((a) => a.area), ["migrations/", "src/auth/**", "src/billing/**"]);
  assert.deepEqual(areas[1].lessons.map((x) => x.hits), ["14 hits", "6 hits"]);
  assert.deepEqual(learningView(empty({ lessons: undefined }), "7").lessons, []); // a metrics.json from before lessons
});

test("the target chart: on the Learning tab, its shift days marked, its image drawn", () => {
  const c = chartsFor(doc.ranges["7"]).find((x) => x.id === "target");
  assert.deepEqual([c.tab, c.unit, c.title, c.value], ["Learning", "usd", "Cost per PR, daily mean", "$2.04"]);
  assert.deepEqual(c.marks, [4]);
  assert.equal(c.note, "1 tuning shift, the dotted lines");
  assert.match(chartCards(doc, "7", "Learning", "dark", (f) => f)[0].image, /^7-target-dark-[0-9a-f]{10}\.svg$/);
  const { target, target_per_day, shifts_per_day, ...old } = doc.ranges["7"];
  assert.equal(chartsFor(old).some((x) => x.id === "target"), false);
  assert.deepEqual(validateMetrics({ ranges: { 7: { ...doc.ranges["7"], shifts_per_day: [1] } } }), ["ranges.7: needs target_per_day and shifts_per_day, one per day"]);
});

test("values and settings as the tab names them", () => {
  assert.deepEqual([showValue(H), showValue("60%"), showValue(null), showValue(3)], ["haiku", "60%", "not set", "3"]);
  assert.deepEqual([settingLabel("agents.plan.model"), settingLabel("budget.handoff_at_context")], ["model for plan", "budget.handoff_at_context"]);
});

test("lesson upkeep: the last run's merges and retirements, the totals, and how to undo one", () => {
  assert.deepEqual(learningView(doc, "7").upkeep, {
    line: "Upkeep 2026-11-20 03:00: 2 merged, 1 retired",
    totals: "5 merged · 3 retired in all · factory learn restore <id> undoes one",
  });
  assert.equal(learningView(empty({ upkeep: { last: null, merged: 0, retired: 0 } }), "7").upkeep.line, "Upkeep hasn't run yet");
  assert.equal(learningView(empty(), "7").upkeep, null); // a metrics.json from before upkeep
  assert.deepEqual(validateMetrics({ ...doc, learning: { ...doc.learning, upkeep: { last: null, merged: "x", retired: 0 } } }).filter((e) => e.startsWith("learning.upkeep")).length, 1);
});
