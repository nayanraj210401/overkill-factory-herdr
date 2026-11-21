// runs.json (daemon/runs.ts writes it): every agent session, newest first, and the
// words the Tickets page's Runs view puts on it.

export const KINDS = ["stage", "fix", "grooming", "cloud", "maintenance", "benchmark"];
const LABEL = { stage: "Stage", fix: "Fix", grooming: "Grooming", cloud: "Cloud", maintenance: "Maintenance", benchmark: "Benchmark" };

export function validateRuns(doc) {
  if (!doc || !Array.isArray(doc.runs)) return ["needs {runs: []}"];
  const errors = [];
  doc.runs.forEach((r, i) => {
    const bad = (m) => errors.push(`runs[${i}]: ${m}`);
    if (!Number.isInteger(r?.id)) return bad("needs a numeric id");
    if (!KINDS.includes(r.kind)) bad(`kind must be one of ${KINDS.join(", ")}`);
    if (r.ticket != null && !Number.isInteger(r.ticket)) bad("ticket must be a number or null");
    for (const k of ["stage", "harness", "started_at"]) if (typeof r[k] !== "string" || !r[k]) bad(`needs ${k}`);
    for (const k of ["tokens_in", "tokens_out"]) if (typeof r[k] !== "number") bad(`needs a number for ${k}`);
    for (const k of ["duration_s", "usd"]) if (r[k] != null && typeof r[k] !== "number") bad(`${k} must be a number or null`);
    for (const k of ["model", "transcript"]) if (r[k] != null && typeof r[k] !== "string") bad(`${k} must be text or null`);
  });
  return errors;
}

// The kinds the file has, with a count each, in KINDS order: the filter chips.
export function kindCounts(runs) {
  return KINDS.map((k) => ({ id: k, title: LABEL[k], n: runs.filter((r) => r.kind === k).length })).filter((k) => k.n);
}

export const filterRuns = (runs, kind) => (kind ? runs.filter((r) => r.kind === kind) : runs);

export function duration(s) {
  if (s == null) return "running";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// "Stage · plan", "Grooming": the Kind column.
export const runWhat = (r) => (r.kind === "stage" || r.kind === "fix" ? `${LABEL[r.kind]} · ${r.stage}` : LABEL[r.kind]);

// "Nov 21 09:30" in UTC, so a test and the window read the same anywhere.
export const startedAt = (iso) =>
  `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)} ${iso.slice(11, 16)}`;

// "codex gpt-5", but "claude-opus-5-5" already says its harness.
export const runModel = (r) => (r.model?.startsWith(r.harness) ? r.model : [r.harness, r.model].filter(Boolean).join(" "));
