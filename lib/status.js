// The contract between the daemon and the window: the shape of status.json.
// In M1 the fixtures follow it; in M2 the daemon writes it. Pure, no Herdr imports,
// so the mods and `node --test` share it.

export const STATES = ["grooming", "queued", "running", "blocked", "parked", "ready", "merged", "closed"];
const NEEDS = ["question", "merge", "parked"];
const WHERE = ["local", "cloud"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function tokens(v, path, errors) {
  if (!isObj(v) || !isNum(v.input) || !isNum(v.output)) errors.push(`${path}: needs {input, output} numbers`);
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
  if (!isNum(t.usd)) errors.push(`${p}.usd: needs a number`);
  if (!WHERE.includes(t.where)) errors.push(`${p}.where: needs "local" or "cloud"`);
  if (t.pr != null) {
    if (!isObj(t.pr) || !Number.isInteger(t.pr.number) || typeof t.pr.watched !== "boolean") errors.push(`${p}.pr: needs {number, watched}`);
    else if (t.pr.checked_at != null && !isTime(t.pr.checked_at)) errors.push(`${p}.pr.checked_at: needs an ISO time`);
  }
  if (t.needs != null && (!isObj(t.needs) || !NEEDS.includes(t.needs.kind) || !isStr(t.needs.text)))
    errors.push(`${p}.needs: needs {kind: ${NEEDS.join("|")}, text}`);
  if (t.blocked_by != null && !Number.isInteger(t.blocked_by)) errors.push(`${p}.blocked_by: needs an integer or null`);
  if (t.terminal != null && !isStr(t.terminal)) errors.push(`${p}.terminal: needs a herdr-core address (t7) or null`);
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
  if (!isObj(s.plan) || !isNum(s.plan.window_5h) || !isNum(s.plan.week)) errors.push("plan: needs {window_5h, week} fractions");
  const d = s.today;
  if (!isObj(d)) errors.push("today: missing");
  else {
    for (const k of ["time_to_pr_min", "cost_per_pr_usd", "interactions_per_pr", "revert_rate", "usd"])
      if (!isNum(d[k])) errors.push(`today.${k}: needs a number`);
    tokens(d.tokens, "today.tokens", errors);
    tokens(d.budget, "today.budget", errors);
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
