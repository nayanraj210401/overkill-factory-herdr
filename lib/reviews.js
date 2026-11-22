// reviews.json: teammates' PRs waiting on you, prepared by the factory (plan.md,
// "Reviewing teammates' PRs"). DRAFT: M6's data shape is pending the user's ideas, so
// everything the page reads goes through this file. Pure, no Herdr imports, so the
// Reviews page, the sidebar's count and `node --test` share it. Until the daemon writes
// the file, fixtures/acme-api/reviews.json follows it.

export const KINDS = ["must-fix", "suggestion", "noise"];
export const CHECK_STATUS = ["pass", "fail"];
export const EVIDENCE = ["verified", "failed", "none"]; // none: the author's PR has no evidence pack
export const HIGH_RISK = 60; // a score from here up reads "high", below "med"; a low_risk PR reads "low"

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function pr(p, i, errors) {
  const at = `prs[${i}]`;
  const bad = (m) => errors.push(`${at}.${m}`);
  if (!isObj(p)) return errors.push(`${at}: not an object`);
  if (!isStr(p.repo)) bad("repo: needs the slug (acme/api)");
  if (!Number.isInteger(p.number)) bad("number: needs an integer");
  if (!isStr(p.title)) bad("title: needs text");
  if (!isStr(p.author)) bad("author: needs text");
  if (!/^https?:\/\//.test(p.url ?? "")) bad("url: needs the PR's web address");
  if (!(Number.isInteger(p.additions) && p.additions >= 0) || !(Number.isInteger(p.deletions) && p.deletions >= 0)) bad("additions, deletions: need line counts");
  if (!isTime(p.requested_at)) bad("requested_at: needs an ISO time");
  if (typeof p.low_risk !== "boolean") bad("low_risk: needs true or false (the daemon applies review.low_risk)");
  if (!isObj(p.risk) || !isNum(p.risk.score) || !Array.isArray(p.risk.reasons) || !p.risk.reasons.every(isStr)) bad("risk: needs {score: number, reasons: [text]}");
  if (p.summary != null && typeof p.summary !== "string") bad("summary: needs text or null");
  if (typeof p.pending_review !== "boolean") bad("pending_review: needs true or false (a pending review is on GitHub)");
  if (!EVIDENCE.includes(p.evidence)) bad(`evidence: needs ${EVIDENCE.join("|")}`);
  if (!Array.isArray(p.findings)) bad("findings: needs an array");
  else p.findings.forEach((f, j) => {
    if (!isObj(f) || !KINDS.includes(f.kind) || !isStr(f.text) || (f.file != null && typeof f.file !== "string") || (f.line != null && !Number.isInteger(f.line)))
      bad(`findings[${j}]: needs {kind: ${KINDS.join("|")}, text, file, line}`);
  });
  if (!Array.isArray(p.checks)) bad("checks: needs an array");
  else p.checks.forEach((c, j) => {
    if (!isObj(c) || !isStr(c.name) || !CHECK_STATUS.includes(c.status) || (c.detail != null && typeof c.detail !== "string"))
      bad(`checks[${j}]: needs {name, status: ${CHECK_STATUS.join("|")}, detail}`);
  });
}

// One line per problem, so the page can show the first. [] means valid.
export function validateReviews(doc) {
  const errors = [];
  if (!isObj(doc)) return ["reviews.json: not a JSON object"];
  if (doc.version !== 1) errors.push(`version: expected 1, got ${JSON.stringify(doc.version)}`);
  if (!isTime(doc.generated_at)) errors.push("generated_at: needs an ISO time");
  if (!["fixture", "daemon"].includes(doc.source)) errors.push(`source: needs "fixture" or "daemon"`);
  if (!isObj(doc.low_risk) || !["human", "auto"].includes(doc.low_risk.gate)) errors.push("low_risk: needs {gate: human|auto}");
  if (!Array.isArray(doc.prs)) errors.push("prs: needs an array");
  else {
    doc.prs.forEach((p, i) => pr(p, i, errors));
    const keys = doc.prs.map((p) => `${p?.repo}#${p?.number}`);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) errors.push(`prs: ${dup} appears twice`);
  }
  return errors;
}

// The file's text to what the page shows: { doc, error, missing }. No file is not an
// error: the daemon hasn't written one (or you review nothing), so the page says so.
export function parseReviews(text) {
  if (text == null) return { doc: null, error: null, missing: true };
  try {
    const doc = JSON.parse(text);
    const errors = validateReviews(doc);
    return errors.length ? { doc: null, error: `reviews.json: ${errors[0]}`, missing: false } : { doc, error: null, missing: false };
  } catch (e) {
    return { doc: null, error: `reviews.json: ${e.message}`, missing: false };
  }
}

export const lines = (p) => p.additions + p.deletions;
export const key = (p) => `${p.repo}#${p.number}`;
// What the row shows before the number: the slug's last part, api#95.
export const label = (p) => `${p.repo.split("/").pop()}#${p.number}`;

// Highest risk first; the older request first among equals.
const byRisk = (a, b) => b.risk.score - a.risk.score || Date.parse(a.requested_at) - Date.parse(b.requested_at);

// The queue: the low-risk fast lane (lowest risk first, since those are one-click),
// then everything else by risk. `all` is that order, the one j and k walk.
export function shapeReviews(doc) {
  const prs = doc?.prs ?? [];
  const fastLane = prs.filter((p) => p.low_risk).sort((a, b) => a.risk.score - b.risk.score || Date.parse(a.requested_at) - Date.parse(b.requested_at));
  const queue = prs.filter((p) => !p.low_risk).sort(byRisk);
  return { fastLane, queue, all: [...fastLane, ...queue], gate: doc?.low_risk?.gate ?? "human" };
}

// The sidebar's "To review" number: the file's, else the status.json count.
export const reviewCount = (doc, fallback = 0) => (doc ? doc.prs.length : fallback);

export const riskLevel = (p) => (p.low_risk ? "low" : p.risk.score >= HIGH_RISK ? "high" : "med");

// Findings by kind; noise is kept, only the page hides it.
export function splitFindings(p) {
  const of = (k) => p.findings.filter((f) => f.kind === k);
  return { mustFix: of("must-fix"), suggestions: of("suggestion"), noise: of("noise") };
}

// Counts for a queue row's right edge: "3 must-fix", "4 suggestions", or "clean".
export function findingsTally(p) {
  const { mustFix, suggestions } = splitFindings(p);
  if (mustFix.length) return `${mustFix.length} must-fix`;
  if (suggestions.length) return `${suggestions.length} ${suggestions.length === 1 ? "suggestion" : "suggestions"}`;
  return "no findings";
}

export function age(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export const sizeText = (p) => `${lines(p)} lines`;

// The checks beside the author's evidence, for a row's quiet line: "checks ✓", "2 checks ✗".
export function checksText(p) {
  const failing = p.checks.filter((c) => c.status === "fail").length;
  return failing ? `${failing} ${failing === 1 ? "check" : "checks"} failing` : p.checks.length ? "checks ✓" : "no checks run";
}

export const evidenceText = (p) => ({ verified: "Evidence verified by re-running it", failed: "Evidence did not hold up when re-run", none: "No evidence pack from the author" }[p.evidence]);

// a: approve a low-risk PR. The daemon has no review command yet (M6), so WIRED is
// false and the page toasts instead; flip it when `factory review approve` exists.
export const APPROVE_WIRED = false;
export function approveAsk(p) {
  if (!p) return { error: "No PR selected" };
  if (!p.low_risk) return { error: `${label(p)} isn't low risk; open it on GitHub (o) to review` };
  if (p.checks.some((c) => c.status === "fail")) return { error: `${label(p)} has failing checks` };
  return {
    title: `Approve ${label(p)}?`,
    detail: `${p.title}, by ${p.author}. Submits an approving review as you, with a one-line summary.`,
    confirm: "Approve",
    args: ["review", "approve", key(p)],
    done: `${label(p)} approved`,
  };
}
