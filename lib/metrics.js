// metrics.json (daemon/metrics.ts writes it) and the words the Metrics page puts on it.

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

// Bar heights 0..1 against the tallest; null (no PRs that day) stays empty.
export const bars = (xs) => {
  const top = Math.max(0, ...xs.filter((x) => x != null));
  return xs.map((x) => (x == null || !top ? 0 : x / top));
};
