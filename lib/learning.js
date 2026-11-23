// The Metrics page's Learning tab: metrics.json's learning (daemon/experiments.ts) and the
// range's target series, shaped into what the tab draws. Pure, so it's tested.
import { compact } from "./model.js";
import { targetLabel, targetValue } from "./metrics.js";
import { undoOverrideAsk } from "./actions.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pct = (n) => (n == null ? "–" : `${Math.round(n * 100)}%`);

// A setting's value as the page shows it: a model by its tier, null as the file's value unset.
export function showValue(v) {
  if (v == null) return "not set";
  if (typeof v === "string") return v.match(/^claude-([a-z]+)-/)?.[1] ?? v;
  return JSON.stringify(v);
}

// agents.builder.model reads "model for builder"; anything else is its dotted path.
export function settingLabel(key) {
  const [root, name, ...field] = key.split(".");
  return root === "agents" && field.length ? `${field.join(".")} for ${name}` : key;
}

// The header: the target now against the range before (every target is better lower), why
// experiments are held, and the learning budget.
function header(l, r, days) {
  const [now, before] = r?.target?.value ?? [null, null];
  const trend = now == null ? "no merged work tickets in range"
    : before == null ? `no merged work tickets the ${days} days before`
    : now === before ? `same as the ${days} days before`
    : `${now < before ? "better" : "worse"} than ${targetValue(l.target, before)} the ${days} days before`;
  const warming = l.warmup.merged < l.warmup.needed;
  const status = warming ? `Warming up: ${l.warmup.merged} of ${l.warmup.needed} merged`
    : l.hold ? `Held: ${l.hold}` : "Experimenting";
  const { spent, cap } = l.budget;
  const share = cap ? Math.max(cap.input ? spent.input / cap.input : 0, cap.output ? spent.output / cap.output : 0) : null;
  return {
    target: targetLabel(l.target), value: targetValue(l.target, now), trend, status, held: warming || l.hold != null,
    summary: `${l.experiments.length} experiment${l.experiments.length === 1 ? "" : "s"}, ${l.experiments.filter((e) => e.decided).length} decided · ${l.shifts.length} shift${l.shifts.length === 1 ? "" : "s"}`,
    budget: cap ? `${compact(spent.input)} of ${compact(cap.input)} in · ${compact(spent.output)} of ${compact(cap.output)} out` : `${compact(spent.input)} in · ${compact(spent.output)} out, no cap`,
    budgetShare: share, budgetSpent: share != null && share >= 1,
  };
}

// One card per experiment (a setting in one context), one row per value tried.
function experimentCard(l, e) {
  return {
    id: `${e.key}@${e.context}`, title: settingLabel(e.key), key: e.key, context: e.context,
    status: e.decided ? `decided: ${showValue(e.winner)}` : "deciding", decided: e.decided,
    epsilon: e.epsilon == null ? "ε –" : `ε ${e.epsilon}`, outcomes: `${e.outcomes} outcome${e.outcomes === 1 ? "" : "s"}`,
    rows: e.arms.map((a) => ({
      value: showValue(a.value),
      n: a.pending ? `${a.n} +${a.pending} running` : String(a.n),
      mean: targetValue(l.target, a.mean), first_try: pct(a.first_try), revert_rate: pct(a.revert_rate),
      floor: a.floor, in_force: a.in_force, winner: e.decided && same(a.value, e.winner),
    })),
  };
}

// Shifts newest first. Only a shift whose override is still active can be undone, through
// `factory learn undo <key>` (Config's z): the setting goes back to the file's value.
function shiftRows(l) {
  const active = new Set(l.overrides.map((o) => o.id));
  return l.shifts.map((s, i) => ({ s, i })).sort((a, b) => (a.s.at === b.s.at ? b.i - a.i : a.s.at < b.s.at ? 1 : -1)).map(({ s }) => {
    const live = s.override != null && active.has(s.override);
    const file = l.experiments.find((e) => e.key === s.key)?.file;
    return {
      id: `${s.at}-${s.key}`, at: s.at.slice(0, 16).replace("T", " "), key: s.key,
      line: `${settingLabel(s.key)}: ${showValue(s.from)} → ${showValue(s.to)}`, context: s.context, why: s.why,
      state: live ? "in force" : s.override == null ? "the file's value again" : "undone or replaced",
      undo: live ? undoOverrideAsk({ key: s.key, value: showValue(s.to), file: file === undefined ? undefined : showValue(file) })
        : { error: s.override == null ? "This shift went back to the file's value: nothing to undo" : "This shift's override is already undone or replaced" },
    };
  });
}

// The lesson store by area, the most used first within one.
function lessonAreas(l) {
  const by = new Map();
  for (const x of [...(l.lessons ?? [])].sort((a, b) => b.hits - a.hits || a.id - b.id)) by.set(x.area, [...(by.get(x.area) ?? []), x]);
  return [...by.keys()].sort().map((area) => ({ area, lessons: by.get(area).map((x) => ({ id: x.id, text: x.text, hits: `${x.hits} hit${x.hits === 1 ? "" : "s"}`, source: x.source })) }));
}

// state: "none" (no learning in metrics.json), "warmup" (nothing learned yet) or "learning".
export function learningView(doc, days) {
  const l = doc?.learning;
  if (!l) return { state: "none", message: "No learning yet: the daemon writes it to metrics.json once the factory has a lead repo." };
  const view = { header: header(l, doc.ranges?.[days], days), experiments: l.experiments.map((e) => experimentCard(l, e)), shifts: shiftRows(l), lessons: lessonAreas(l) };
  if (!view.experiments.length && !view.shifts.length) {
    const left = l.warmup.needed - l.warmup.merged;
    return { ...view, state: "warmup", message: left > 0
      ? `Nothing learned yet. The factory only logs until ${l.warmup.needed} work tickets have merged (${left} to go); then it tries values for the settings in learn.tunable.`
      : "Nothing learned yet. Experiments start with the next ticket once learn.tunable lists a setting with values to try." };
  }
  return { ...view, state: "learning" };
}
