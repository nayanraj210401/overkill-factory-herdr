// Metrics' "All factories" view: every factory on this machine (agents-live.json lists them)
// combined into one range the page draws like a single factory's. Counts, tokens and spend
// are summed, per day by date. A rate or mean is recomputed from the counts it came from,
// never averaged. A median can't be rebuilt from metrics.json, so it stays per factory.
import { minutes } from "./metrics.js";

const round = (n, d = 2) => +n.toFixed(d);
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const total = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

// What the page says under the tiles while the toggle is on.
export const ALL_NOTE = "Counts, tokens and spend are summed; rates and means are recomputed from the counts. "
  + "Medians (time to PR, cycle time) can't be combined, so they're shown per factory, and there's no comparison with the period before: metrics.json keeps no earlier counts.";

// agents-live.json's factories: [{name, dir}].
export function liveFactories(doc) {
  return (Array.isArray(doc?.factories) ? doc.factories : [])
    .filter((f) => typeof f?.name === "string" && typeof f?.dir === "string")
    .map(({ name, dir }) => ({ name, dir }));
}

// A JSON file's text through its validator: {doc, error}, both null for a missing file.
export function parseDoc(text, validate, file) {
  if (text == null) return { doc: null, error: null };
  try {
    const doc = JSON.parse(text);
    const errors = validate(doc);
    return errors.length ? { doc: null, error: `${file}: ${errors[0]}` } : { doc, error: null };
  } catch (e) { return { doc: null, error: `${file}: ${e.message}` }; }
}

// One range (7 or 30 days) of several factories: parts is [{name, r}]. The days are the
// newest factory's; a factory whose metrics.json is older adds nothing on a day it lacks.
export function combineRange(parts) {
  const days = parts.map((p) => p.r.days).reduce((a, b) => (b.at(-1) > a.at(-1) ? b : a));
  const on = (p, key) => {
    const v = p.r[key];
    if (!Array.isArray(v)) return null;
    const at = new Map(p.r.days.map((d, i) => [d, i]));
    return days.map((d) => (at.has(d) ? v[at.get(d)] : null));
  };
  // Summed per day; absent when no factory has the series (a metrics.json from before it).
  const perDay = (key) => {
    const have = parts.map((p) => on(p, key)).filter(Boolean);
    return have.length ? days.map((_, i) => round(total(have.map((v) => v[i])))) : undefined;
  };
  // A per-day rate or mean, weighted back to its counts: rate × count summed over the factories
  // that measured the day, over their counts. whole: the rate's numerator is a whole count.
  const ratePerDay = (key, weight, digits, whole) => {
    if (!parts.some((p) => Array.isArray(p.r[key]))) return undefined;
    return days.map((_, i) => {
      let num = 0, den = 0;
      for (const p of parts) {
        const v = on(p, key)?.[i], w = on(p, weight)?.[i] ?? 0;
        if (v == null || !w) continue;
        num += whole ? Math.round(v * w) : v * w;
        den += w;
      }
      return den ? round(num / den, digits) : null;
    });
  };
  // Named parts summed by name (spend by stage, by model), the biggest first.
  const byName = (key) => {
    const m = new Map();
    for (const p of parts) for (const x of p.r[key] ?? []) m.set(x.name, (m.get(x.name) ?? 0) + x.usd);
    return [...m].map(([name, n]) => ({ name, usd: round(n) })).sort((a, b) => b.usd - a.usd);
  };
  // Named series summed by name and day (spend by agent, by model, per day).
  const seriesByName = (key) => {
    if (!parts.some((p) => Array.isArray(p.r[key]))) return undefined;
    const m = new Map();
    for (const p of parts) for (const s of p.r[key] ?? []) {
      const at = new Map(p.r.days.map((d, i) => [d, i]));
      const cur = m.get(s.name) ?? days.map(() => 0);
      m.set(s.name, cur.map((n, i) => round(n + (at.has(days[i]) ? s.values[at.get(days[i])] ?? 0 : 0))));
    }
    return [...m.keys()].sort().map((name) => ({ name, values: m.get(name) }));
  };
  const opened = total(parts.map((p) => p.r.prs_opened));
  const merged = total(parts.map((p) => p.r.prs_merged));
  // A per-PR mean over the PRs opened in range, weighted back by each factory's count.
  const perPr = (key, digits) => (opened ? round(total(parts.map((p) => p.r.headline[key][0] * p.r.prs_opened)) / opened, digits) : 0);
  const reverted = total(parts.flatMap((p) => (p.r.quality ?? []).map((q) => q.reverted)));
  const quality = new Map();
  for (const p of parts) for (const q of p.r.quality ?? []) {
    const c = quality.get(q.blueprint) ?? { blueprint: q.blueprint, merged: 0, reverted: 0, retries: 0 };
    quality.set(q.blueprint, { ...c, merged: c.merged + q.merged, reverted: c.reverted + q.reverted, retries: c.retries + q.retries_per_ticket * q.merged });
  }
  const caps = parts.map((p) => p.r.tokens_in_cap);
  return {
    days, prs_opened: opened, prs_merged: merged,
    // [now, before]: before is null, as nothing in metrics.json rebuilds it.
    headline: {
      time_to_pr_min: [null, null], cost_per_pr_usd: [perPr("cost_per_pr_usd", 2), null],
      interactions_per_pr: [perPr("interactions_per_pr", 1), null], revert_rate: [merged ? round(reverted / merged, 3) : 0, null],
    },
    merged_per_day: perDay("merged_per_day"), opened_per_day: perDay("opened_per_day"),
    usd_per_day: perDay("usd_per_day"), learning_usd_per_day: perDay("learning_usd_per_day"),
    tokens_in_per_day: perDay("tokens_in_per_day"), learning_tokens_in_per_day: perDay("learning_tokens_in_per_day"),
    shifts_per_day: perDay("shifts_per_day"),
    // The daily caps add up only when every factory has one.
    tokens_in_cap: caps.every((c) => typeof c === "number") ? total(caps) : null,
    revert_rate_per_day: ratePerDay("revert_rate_per_day", "merged_per_day", 3, true),
    first_try_per_day: ratePerDay("first_try_per_day", "merged_per_day", 3, true),
    interactions_per_day: ratePerDay("interactions_per_day", "opened_per_day", 1, false),
    usd_by_agent_per_day: seriesByName("usd_by_agent_per_day"), usd_by_model_per_day: seriesByName("usd_by_model_per_day"),
    usd_by_stage: byName("usd_by_stage"), usd_by_model: byName("usd_by_model"),
    quality: [...quality.values()].sort((a, b) => (a.blueprint < b.blueprint ? -1 : 1))
      .map((q) => ({ blueprint: q.blueprint, merged: q.merged, reverted: q.reverted, retries_per_ticket: q.merged ? round(q.retries / q.merged, 1) : 0 })),
    // Medians, which no sum rebuilds: one line per factory. time_to_pr_per_day and cycle
    // are left out, so the time-to-PR chart isn't drawn.
    per_factory: parts.map((p) => ({
      name: p.name, opened: p.r.prs_opened, merged: p.r.prs_merged,
      time_to_pr: p.r.prs_opened ? minutes(p.r.headline.time_to_pr_min[0]) : "–", cycle: p.r.cycle ?? null,
    })),
  };
}

// metrics.json docs of several factories, [{name, doc}], as one doc with the ranges every
// factory has. Learning, agreement and charts stay with each factory.
export function combineMetrics(list) {
  const keys = list.length ? Object.keys(list[0].doc.ranges).filter((k) => list.every((f) => f.doc.ranges[k])) : [];
  return { ranges: Object.fromEntries(keys.map((k) => [k, combineRange(list.map((f) => ({ name: f.name, r: f.doc.ranges[k] })))])) };
}

// The four tiles for a combined range. Time to PR is a median: one factory per part of its line.
export function combinedTiles(r) {
  const of = (n, what) => `${n} ${what} in all factories`;
  return [
    { label: "Time to PR", value: "per factory", sub: r.per_factory.map((f) => `${f.name} ${f.time_to_pr}`).join(" · ") },
    { label: "Cost per PR", value: r.prs_opened ? usd(r.headline.cost_per_pr_usd[0]) : "–", sub: of(r.prs_opened, "PRs opened") },
    { label: "Interactions / PR", value: r.prs_opened ? String(r.headline.interactions_per_pr[0]) : "–", sub: of(r.prs_opened, "PRs opened") },
    { label: "Revert rate", value: pct(r.headline.revert_rate[0]), sub: `${total(r.quality.map((q) => q.reverted))} of ${r.prs_merged} merged PRs` },
  ];
}

// A combined chart has no SVG (the daemon draws one factory's), so the page draws each series
// as a row of day columns: each a share of that series' highest day, null a day with nothing.
export function columnRows(series) {
  return series.map((s) => {
    const max = Math.max(0, ...s.values.map((v) => v ?? 0));
    return { name: s.name, cols: s.values.map((v) => (v == null ? null : max ? v / max : 0)) };
  });
}
