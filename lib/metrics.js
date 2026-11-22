// metrics.json (daemon/metrics.ts writes it) and the words the Metrics page puts on it.
import { compact } from "./model.js";

export function validateMetrics(doc) {
  if (!doc || typeof doc.ranges !== "object" || !doc.ranges) return ["needs {ranges}"];
  const errors = [];
  for (const [k, r] of Object.entries(doc.ranges)) {
    if (!r?.headline || !Array.isArray(r.days) || !Array.isArray(r.merged_per_day) || r.merged_per_day.length !== r.days.length) errors.push(`ranges.${k}: needs headline, days and merged_per_day of the same length`);
    for (const h of ["time_to_pr_min", "cost_per_pr_usd", "interactions_per_pr", "revert_rate"])
      if (!Array.isArray(r?.headline?.[h]) || r.headline[h].length !== 2) errors.push(`ranges.${k}.headline.${h}: needs [now, before]`);
  }
  const a = doc.agreement;
  if (a != null) {
    if (a.rate !== null && typeof a.rate !== "number") errors.push("agreement.rate: a share, or null before the first run");
    for (const k of ["examples", "agreed", "failed", "min"]) if (typeof a[k] !== "number") errors.push(`agreement.${k}: needs a number`);
    if (typeof a.ok !== "boolean" || typeof a.why !== "string" || !Array.isArray(a.by_verdict)) errors.push("agreement: needs ok, why and by_verdict");
  }
  if (doc.learning != null) errors.push(...learningErrors(doc.learning));
  return errors;
}

// metrics.json's learning (daemon/experiments.ts): what the Learning tab reads. Values are
// any JSON (a model ID, "60%", null for the file's value unset).
const num = (v) => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v) => v === null || num(v);
const toks = (t) => t && num(t.input) && num(t.output);
function learningErrors(l) {
  const errors = [];
  if (typeof l.target !== "string") errors.push("learning.target: needs the learn.target");
  if (l.hold !== null && typeof l.hold !== "string") errors.push("learning.hold: why experiments are held, or null");
  if (!num(l.warmup?.merged) || !num(l.warmup?.needed)) errors.push("learning.warmup: needs merged and needed");
  if (!toks(l.budget?.spent) || (l.budget.cap !== null && !toks(l.budget.cap))) errors.push("learning.budget: needs spent {input, output} and cap, or null");
  for (const k of ["experiments", "overrides", "shifts"]) if (!Array.isArray(l[k])) errors.push(`learning.${k}: needs a list`);
  (Array.isArray(l.experiments) ? l.experiments : []).forEach((e, i) => {
    const at = `learning.experiments[${i}]`;
    if (typeof e?.key !== "string" || typeof e?.context !== "string") errors.push(`${at}: needs key and context`);
    if (!("current" in (e ?? {})) || typeof e?.decided !== "boolean" || !num(e?.outcomes) || !numOrNull(e?.epsilon)) errors.push(`${at}: needs current, decided, outcomes and epsilon`);
    if (!Array.isArray(e?.arms) || !e.arms.length) { errors.push(`${at}.arms: needs a list`); return; }
    e.arms.forEach((a, j) => {
      if (!num(a?.pulls) || !num(a?.pending) || !num(a?.n) || !numOrNull(a?.mean) || !numOrNull(a?.first_try) || !numOrNull(a?.revert_rate)) errors.push(`${at}.arms[${j}]: needs pulls, pending, n, and mean, first_try, revert_rate (or null)`);
      if (!["ok", "below", "unknown"].includes(a?.floor) || typeof a?.in_force !== "boolean") errors.push(`${at}.arms[${j}]: needs floor (ok, below, unknown) and in_force`);
    });
  });
  (Array.isArray(l.overrides) ? l.overrides : []).forEach((o, i) => {
    if (!num(o?.id) || typeof o?.key !== "string" || typeof o?.since !== "string" || typeof o?.from_experiment !== "boolean") errors.push(`learning.overrides[${i}]: needs id, key, value, since and from_experiment`);
  });
  (Array.isArray(l.shifts) ? l.shifts : []).forEach((s, i) => {
    if (typeof s?.at !== "string" || typeof s?.key !== "string" || typeof s?.context !== "string" || typeof s?.why !== "string" || (s.override !== null && !num(s.override))) errors.push(`learning.shifts[${i}]: needs at, key, context, from, to, override (or null) and why`);
  });
  return errors;
}

// The agreement card: the rate against the bar, what it allows while you're away, and
// the rate per verdict you gave.
export function agreementCard(a) {
  if (!a || a.rate == null) return { value: "–", sub: `Not measured yet. factory agreement re-judges your past review comments.`, rows: [] };
  return {
    value: pct(a.rate),
    sub: `${a.agreed} of ${a.examples} comments${a.failed ? ` (${a.failed} unanswered)` : ""} with ${a.model}, ${a.at.slice(0, 10)}; bar ${pct(a.min)}. Pushbacks while away: ${a.ok ? "allowed" : "off"}`,
    rows: a.by_verdict.map((v) => [`You said ${v.verdict === "pushback" ? "push back" : v.verdict}`, `${v.agreed} of ${v.examples}`]),
  };
}

export const minutes = (m) => (m >= 60 * 24 ? `${(m / 1440).toFixed(1)}d` : m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`);
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;

// The four tiles: a value, and a line comparing it with the period before.
export function headlineTiles(r, days) {
  const h = r.headline;
  const cmp = ([now, before], fmt, lowerIsBetter = true) => {
    if (!before) return `no PRs the ${days} days before`;
    if (now === before) return `same as the ${days} days before`;
    return `${(now < before) === lowerIsBetter ? "better" : "worse"} than ${fmt(before)}`;
  };
  return [
    { label: "Time to PR", value: r.prs_opened ? minutes(h.time_to_pr_min[0]) : "–", sub: cmp(h.time_to_pr_min, minutes) },
    { label: "Cost per PR", value: r.prs_opened ? usd(h.cost_per_pr_usd[0]) : "–", sub: cmp(h.cost_per_pr_usd, usd) },
    { label: "Interactions / PR", value: r.prs_opened ? String(h.interactions_per_pr[0]) : "–", sub: cmp(h.interactions_per_pr, String) },
    { label: "Revert rate", value: pct(h.revert_rate[0]), sub: `${r.quality.reduce((a, q) => a + q.reverted, 0)} of ${r.prs_merged} merged PRs` },
  ];
}

// The charts, one spec per card: the daemon renders each as an SVG (daemon/charts.ts) and the
// page shows it under a headline and a legend made from the same spec. A value of null is a day
// with nothing to measure (no PR opened, nothing merged): the line breaks there. kind "line"
// overlays its series; "stacked" stacks parts of a whole. ref is a dashed level (a budget).

// A chart's drawn size: about half the Metrics page, so the page scales it little either way.
export const CHART = { w: 520, h: 180 };

// Categorical colours in a fixed order (series i takes slot i), stepped for each appearance:
// the dataviz reference palette, whose adjacent pairs pass the colour-blind checks in both.
export const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};

const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

// Spend by agent or model per day: the four biggest, the rest folded into "Other".
function fold(parts) {
  const sorted = [...parts].sort((a, b) => sum(b.values) - sum(a.values));
  if (sorted.length <= 5) return sorted;
  const rest = sorted.slice(4);
  return [...sorted.slice(0, 4), { name: "Other", values: rest[0].values.map((_, i) => sum(rest.map((p) => p.values[i]))) }];
}

// Every chart a range has data for, in page order. A metrics.json from before a series
// existed simply has fewer charts.
export function chartsFor(r) {
  const days = r.days;
  const out = [];
  const add = (c) => {
    if (c.series.every((s) => Array.isArray(s.values) && s.values.length === days.length)) out.push({ days, kind: "line", ...c });
  };
  const merged = sum(r.merged_per_day);
  add({ id: "time-to-pr", tab: "Throughput", title: "Time to PR, median", unit: "min", value: r.prs_opened ? minutes(r.headline.time_to_pr_min[0]) : "–", note: `${r.prs_opened} PRs opened`,
    series: [{ name: "Time to PR", values: r.time_to_pr_per_day }] });
  add({ id: "prs", tab: "Throughput", title: "PRs opened and merged", unit: "count", value: String(r.prs_merged), note: `merged, ${r.prs_opened} opened`,
    series: [{ name: "Opened", values: r.opened_per_day }, { name: "Merged", values: r.merged_per_day }] });
  add({ id: "interactions", tab: "Throughput", title: "Human interactions per PR", unit: "count", value: r.prs_opened ? String(r.headline.interactions_per_pr[0]) : "–", note: "lower means more hands-off",
    series: [{ name: "Interactions per PR", values: r.interactions_per_day }] });
  add({ id: "spend", tab: "Cost", title: "Spend per day", unit: "usd", value: usd(sum(r.usd_per_day)), note: `in ${days.length} days`,
    series: [{ name: "Spend", values: r.usd_per_day }] });
  const cap = r.tokens_in_cap ?? null;
  add({ id: "tokens", tab: "Cost", title: "Input tokens per day", unit: "tokens", value: compact(sum(r.tokens_in_per_day ?? [])), note: cap ? `daily budget ${compact(cap)}` : "no daily budget set",
    series: [{ name: "Input tokens", values: r.tokens_in_per_day }], ...(cap ? { ref: { name: "Daily budget", value: cap } } : {}) });
  for (const [id, key, title, what] of [["by-agent", "usd_by_agent_per_day", "Spend by agent", "agents"], ["by-model", "usd_by_model_per_day", "Spend by model", "models"]]) {
    if (!Array.isArray(r[key])) continue;
    const parts = fold(r[key]);
    add({ id, tab: "Cost", title, unit: "usd", kind: "stacked", value: usd(sum(parts.map((p) => sum(p.values)))), note: parts.length ? `${parts.length} ${what}` : "nothing spent yet",
      series: parts.length ? parts : [{ name: "Spend", values: days.map(() => 0) }] });
  }
  add({ id: "reverts", tab: "Quality", title: "Revert rate", unit: "pct", value: pct(r.headline.revert_rate[0]), note: `of ${r.prs_merged} merged PRs`,
    series: [{ name: "Revert rate", values: r.revert_rate_per_day }] });
  const firstTry = merged && r.first_try_per_day ? sum(r.first_try_per_day.map((x, i) => (x ?? 0) * r.merged_per_day[i])) / merged : null;
  add({ id: "first-try", tab: "Quality", title: "First-try pass rate", unit: "pct", value: firstTry == null ? "–" : pct(firstTry), note: "merged with no retry",
    series: [{ name: "First-try pass rate", values: r.first_try_per_day }] });
  return out;
}

// The path image() takes for a chart file. Herdr loads images only by a path inside its own
// folder (~/.config/herdr-app), never an absolute one: the sample data lives there, and a real
// factory's charts are reached through the link the daemon keeps at factory-charts/<factory>.
export function chartAsset(root, appHome, file) {
  if (root.startsWith(`${appHome}/`)) return `${root.slice(appHome.length + 1)}/charts/${file}`;
  return `factory-charts/${root.split("/").filter(Boolean).at(-1)}/${file}`;
}

// What each card on a tab shows: the headline, a legend (each series with its colour in this
// appearance; none for a single series, whose title names it) and the image for this range
// and appearance (null until the daemon has drawn it).
export function chartCards(doc, range, tab, mode, asset) {
  return chartsFor(doc.ranges[range]).filter((c) => c.tab === tab).map((c) => {
    const file = doc.charts?.[range]?.[c.id]?.[mode];
    const legend = c.series.length > 1 || c.ref ? c.series.map((s, i) => ({ name: s.name, color: PALETTE[mode][i] })) : [];
    if (c.ref) legend.push({ name: c.ref.name, color: null });
    return { id: c.id, title: c.title, value: c.value, note: c.note, legend, image: file ? asset(file) : null };
  });
}
