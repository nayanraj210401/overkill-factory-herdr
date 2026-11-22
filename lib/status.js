// The contract between the daemon and the window: the shape of status.json.
// In M1 the fixtures follow it; in M2 the daemon writes it. Pure, no Herdr imports,
// so the mods and `node --test` share it.

export const STATES = ["grooming", "queued", "running", "paused", "blocked", "parked", "ready", "merged", "closed"];
const NEEDS = ["question", "merge", "parked"];
const WHERE = ["local", "cloud"];
const SETUP = ["ok", "missing", "skipped"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function tokens(v, path, errors) {
  if (!isObj(v) || !isNum(v.input) || !isNum(v.output)) errors.push(`${path}: needs {input, output} numbers`);
}

function pr(v, path, errors) {
  if (v == null) return;
  if (!isObj(v) || !Number.isInteger(v.number) || typeof v.watched !== "boolean") errors.push(`${path}: needs {number, watched}`);
  else if (v.checked_at != null && !isTime(v.checked_at)) errors.push(`${path}.checked_at: needs an ISO time`);
}

// Optional: the repos a ticket works in, its lead first (multi-repo; one factory per lead repo).
function repos(v, path, errors) {
  if (v == null) return;
  if (!Array.isArray(v) || !v.length) return errors.push(`${path}: needs a non-empty array`);
  v.forEach((r, i) => {
    if (!isObj(r) || !isStr(r.slug) || typeof r.lead !== "boolean") errors.push(`${path}[${i}]: needs {slug, lead: boolean, pr, worktree}`);
    else {
      pr(r.pr, `${path}[${i}].pr`, errors);
      if (r.worktree != null && !isStr(r.worktree)) errors.push(`${path}[${i}].worktree: needs a path or null`);
      if (r.branch != null && !isStr(r.branch)) errors.push(`${path}[${i}].branch: needs text or null`);
      if (r.merged_at != null && !isTime(r.merged_at)) errors.push(`${path}[${i}].merged_at: needs an ISO time or null`);
      if (r.merge != null && !(Number.isInteger(r.merge) && r.merge >= 1)) errors.push(`${path}[${i}].merge: needs its place in the merge order (1, 2…)`);
    }
  });
  if (v.filter((r) => r?.lead).length !== 1) errors.push(`${path}: needs exactly one lead repo`);
}

function ticket(t, i, errors) {
  const p = `tickets[${i}]`;
  if (!isObj(t)) return errors.push(`${p}: not an object`);
  if (!Number.isInteger(t.id)) errors.push(`${p}.id: needs an integer`);
  if (!isStr(t.title)) errors.push(`${p}.title: needs text`);
  if (!STATES.includes(t.state)) errors.push(`${p}.state: "${t.state}" is not one of ${STATES.join(", ")}`);
  if (!isStr(t.blueprint)) errors.push(`${p}.blueprint: needs text`);
  if (t.stage != null && !isStr(t.stage)) errors.push(`${p}.stage: needs text or null`);
  if (t.detail != null && typeof t.detail !== "string") errors.push(`${p}.detail: needs text or null`);
  if (!isTime(t.updated_at)) errors.push(`${p}.updated_at: needs an ISO time`);
  tokens(t.tokens, `${p}.tokens`, errors);
  tokens(t.budget, `${p}.budget`, errors);
  if (t.warning != null && !isStr(t.warning)) errors.push(`${p}.warning: needs text or null`);
  if (!isNum(t.usd)) errors.push(`${p}.usd: needs a number`);
  if (!WHERE.includes(t.where)) errors.push(`${p}.where: needs "local" or "cloud"`);
  pr(t.pr, `${p}.pr`, errors);
  repos(t.repos, `${p}.repos`, errors);
  if (t.needs != null && (!isObj(t.needs) || !NEEDS.includes(t.needs.kind) || !isStr(t.needs.text)))
    errors.push(`${p}.needs: needs {kind: ${NEEDS.join("|")}, text}`);
  // Optional: a grooming ticket's open questions, numbered as its `A1:` answers are.
  if (t.questions != null) {
    if (!Array.isArray(t.questions)) errors.push(`${p}.questions: needs an array`);
    else t.questions.forEach((q, j) => {
      if (!isObj(q) || !Number.isInteger(q.n) || !["product", "engineering"].includes(q.kind) || !isStr(q.text))
        errors.push(`${p}.questions[${j}]: needs {n, kind: product|engineering, text}`);
    });
  }
  if (t.blocked_by != null && !Number.isInteger(t.blocked_by)) errors.push(`${p}.blocked_by: needs an integer or null`);
  if (t.terminal != null && !isStr(t.terminal)) errors.push(`${p}.terminal: needs a herdr-core address (t7) or null`);
  if (t.session != null && !(Number.isInteger(t.session) && t.session >= 1)) errors.push(`${p}.session: needs the session number (1, 2…) or null`);
  if (t.state === "blocked" && t.blocked_by == null) errors.push(`${p}: state blocked needs blocked_by`);
  if (t.state === "parked" && t.needs?.kind !== "parked") errors.push(`${p}: state parked needs needs.kind "parked"`);
}

// One line per problem, so a mod can show them as-is. [] means valid.
export function validateStatus(s) {
  const errors = [];
  if (!isObj(s)) return ["status.json: not a JSON object"];
  if (s.version !== 1) errors.push(`version: expected 1, got ${JSON.stringify(s.version)}`);
  if (!isTime(s.generated_at)) errors.push("generated_at: needs an ISO time");
  if (!["fixture", "daemon"].includes(s.source)) errors.push(`source: needs "fixture" or "daemon"`);
  if (!isObj(s.factory) || !isStr(s.factory.name) || !isStr(s.factory.repo) || typeof s.factory.daemon !== "boolean")
    errors.push("factory: needs {name, repo, daemon: boolean}");
  else if (s.factory.repos != null && (!Array.isArray(s.factory.repos) || !s.factory.repos.every(isStr) || s.factory.repos[0] !== s.factory.repo))
    errors.push("factory.repos: needs the repo slugs, the lead (factory.repo) first");
  else if (s.factory.path != null && !isStr(s.factory.path)) errors.push("factory.path: needs the lead repo's checkout folder");
  if (!isObj(s.plan) || !isNum(s.plan.window_5h) || !isNum(s.plan.week)) errors.push("plan: needs {window_5h, week} fractions");
  else if (s.plan.hold != null && !isStr(s.plan.hold)) errors.push("plan.hold: needs text or null");
  // plan.source: "claude" (Claude Code's own reading, as of plan.as_of), "estimate"
  // (this factory's tokens against limits set by hand) or "none" (nothing to go on).
  else if (s.plan.source != null && !["claude", "estimate", "none"].includes(s.plan.source)) errors.push("plan.source: needs claude, estimate or none");
  else if (s.plan.as_of != null && !isTime(s.plan.as_of)) errors.push("plan.as_of: needs an ISO time or null");
  const d = s.today;
  if (!isObj(d)) errors.push("today: missing");
  else {
    for (const k of ["time_to_pr_min", "cost_per_pr_usd", "interactions_per_pr", "revert_rate", "usd"])
      if (!isNum(d[k])) errors.push(`today.${k}: needs a number`);
    tokens(d.tokens, "today.tokens", errors);
    tokens(d.budget, "today.budget", errors);
  }
  // Optional: away mode, and what happened while you were away (the Home digest).
  if (s.away != null) {
    const a = s.away;
    if (!isObj(a) || typeof a.on !== "boolean" || !isTime(a.since) || (a.until != null && !isTime(a.until)) || !Array.isArray(a.events))
      errors.push("away: needs {on, since, until, events: []}");
    else a.events.forEach((e, i) => { if (!isStr(e?.who) || !isStr(e?.what) || !isTime(e?.at)) errors.push(`away.events[${i}]: needs {ticket, who, what, at}`); });
  }
  // Optional: the first-run checklist, present while the lead repo has no .factory/.
  if (s.setup != null) {
    if (!isObj(s.setup) || !Array.isArray(s.setup.steps) || !s.setup.steps.length) errors.push("setup: needs {steps: [{id, label, status, fix}]}");
    else s.setup.steps.forEach((st, i) => {
      if (!isObj(st) || !isStr(st.id) || !isStr(st.label) || !SETUP.includes(st.status) || (st.fix != null && !isStr(st.fix)))
        errors.push(`setup.steps[${i}]: needs {id, label, status: ${SETUP.join("|")}, fix: text or null}`);
    });
  }
  // Optional: tuned settings (learn overrides) beside the files' values, for the Config page.
  if (s.overrides != null) {
    const scalar = (v) => ["string", "number", "boolean"].includes(typeof v);
    if (!Array.isArray(s.overrides)) errors.push("overrides: needs an array");
    else s.overrides.forEach((o, i) => {
      if (!isStr(o?.key) || !scalar(o?.value) || !(o.file == null || scalar(o.file)) || !(o.reason == null || typeof o.reason === "string") || !isTime(o?.at))
        errors.push(`overrides[${i}]: needs {key, value, file, reason, at}`);
    });
  }
  if (!Number.isInteger(s.to_review)) errors.push("to_review: needs an integer");
  if (!Number.isInteger(s.rules_failing)) errors.push("rules_failing: needs an integer");
  if (!Array.isArray(s.tickets)) errors.push("tickets: needs an array");
  else {
    s.tickets.forEach((t, i) => ticket(t, i, errors));
    const ids = s.tickets.map((t) => t?.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) errors.push(`tickets: id ${dup} appears twice`);
  }
  return errors;
}
