// The V2 Blueprint page's numbers and tables (docs/prototypes/blueprint-v2). The daemon uses the
// first half on the database's stage rows to write blueprints.json (daemon/blueprints.ts); the
// page uses the rest on that file. Pure, so node tests it.
import { stageOrder } from "./blueprints.js";

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const secs = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null);

// --- the daemon's half: stage rows → outcomes, history, stats ---

// Each stage run with how it ended, from what the ticket did next. `rows` are one blueprint's
// stage rows ({ticket, title, stage (lowercase id), started_at, ended_at, state, needs_text}),
// ordered by ticket, then start. A run failed when the ticket went next to the stage's
// on_fail, or parked on it with "failed" (retries used up). Still open: running. A ticket
// stopped on it for anything else (paused, parked on its budget) is "stopped", neither.
export function stageOutcomes(rows, stages) {
  const onFail = Object.fromEntries(stages.map((s) => [s.id, s.on_fail ?? null]));
  return rows.map((r, i) => {
    const next = rows[i + 1]?.ticket === r.ticket ? rows[i + 1] : null;
    let outcome;
    if (next) outcome = onFail[r.stage] && next.stage === onFail[r.stage] ? "fail" : "pass";
    else if (!r.ended_at) outcome = "running";
    else if (r.state === "parked" || r.state === "paused") outcome = r.state === "parked" && / failed \d+ times/.test(r.needs_text ?? "") ? "fail" : "stopped";
    else outcome = "pass";
    return { ...r, outcome, duration_s: secs(r.started_at, r.ended_at) };
  });
}

// One stage's history: its last 10 runs' outcomes (oldest first), and over the window
// (started at or after `since`) its runs, passes, fails and median time; its 4 latest runs.
export function stageHistory(runs, id, since) {
  const mine = runs.filter((r) => r.stage === id).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const recent = mine.filter((r) => r.started_at >= since);
  const ended = recent.filter((r) => r.outcome === "pass" || r.outcome === "fail");
  const m = median(ended.map((r) => r.duration_s).filter((x) => x != null));
  return {
    pass: ended.filter((r) => r.outcome === "pass").length,
    fail: ended.filter((r) => r.outcome === "fail").length,
    median_s: m == null ? null : Math.round(m),
    last: mine.slice(-10).map((r) => r.outcome),
    recent: mine.slice(-4).reverse().map((r) => ({ ticket: r.ticket, title: r.title, outcome: r.outcome, started_at: r.started_at, duration_s: r.duration_s == null ? null : Math.round(r.duration_s) })),
  };
}

// The blueprint's stats strip, over tickets with a stage started in the window: how many,
// the share that never failed back, and over those whose PR opened in the window the median
// minutes from the ask to the PR and the median cost. `tickets`: id → {ask_at, pr_at, usd}.
// A number with nothing to measure is null (the page leaves it out).
export function blueprintStats(runs, tickets, since) {
  const ids = [...new Set(runs.filter((r) => r.started_at >= since && r.stage !== "groom").map((r) => r.ticket))];
  const failed = new Set(runs.filter((r) => r.outcome === "fail").map((r) => r.ticket));
  const prs = ids.map((id) => tickets[id]).filter((t) => t?.pr_at && t.pr_at >= since);
  const lead = median(prs.map((t) => secs(t.ask_at, t.pr_at)).filter((x) => x != null));
  const usd = median(prs.map((t) => t.usd ?? 0));
  return {
    tickets: ids.length,
    clean: ids.length ? +(ids.filter((id) => !failed.has(id)).length / ids.length).toFixed(3) : null,
    ask_to_pr_min: lead == null ? null : Math.round(lead / 60),
    usd: usd == null ? null : +usd.toFixed(2),
  };
}

// --- the page's half: blueprints.json → what it draws ---

// "52m", "1h 10m", "9s"; "–" for nothing measured.
export function took(s) {
  if (s == null) return "–";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

// The blueprints that run step `step`, in the file's order.
export const usedBy = (doc, step) => (step ? (doc?.blueprints ?? []).filter((b) => b.stages.some((s) => s.step === step)).map((b) => b.name) : []);

// Every step any blueprint names, in the order they're first met (blueprints in file order,
// stages in path order).
export function allSteps(doc) {
  const seen = [];
  for (const b of doc?.blueprints ?? []) for (const s of b.error ? [] : stageOrder(b)) if (s.step && !seen.includes(s.step)) seen.push(s.step);
  return seen;
}

// Compare: one row per step, one column per blueprint; a cell is the stage that runs the step
// there (null: not run there). Stages written out in full, with no step, are counted apart.
export function compareGrid(doc) {
  const names = (doc?.blueprints ?? []).map((b) => b.name);
  const rows = allSteps(doc).map((step) => ({
    step,
    cells: (doc.blueprints).map((b) => b.stages.find((s) => s.step === step)?.id ?? null),
    used: usedBy(doc, step).length,
  }));
  const inline = (doc?.blueprints ?? []).flatMap((b) => b.stages.filter((s) => !s.step).map((s) => `${b.name}.${s.id}`));
  return { names, rows, inline };
}

// What a stage's work leaves behind: its output file, else what its kind always leaves.
export function leaves(s) {
  if (s?.output) return s.output;
  if (s?.role === "verify") return "a holdout verdict";
  if (s?.role === "review") return "a review verdict";
  if (s?.check) return `the ${s.check} check's result`;
  if (s?.gate === "human") return "the merged PR";
  if (s?.role === "build") return "commits in the worktree";
  return "–";
}

// Shared steps: each step, what it leaves, the blueprints running it and its runs in the window.
export function stepsTable(doc) {
  return allSteps(doc).map((step) => {
    const stages = (doc.blueprints).flatMap((b) => b.stages.filter((s) => s.step === step));
    return { step, leaves: doc.steps?.[step]?.output ?? leaves(stages[0]), usedBy: usedBy(doc, step), runs: stages.reduce((a, s) => a + s.runs, 0),
      description: doc.steps?.[step]?.description ?? null, file: doc.steps?.[step]?.file ?? null, label: doc.steps?.[step]?.label ?? null };
  });
}

// What runs a stage, in the flow's words.
export function stageKind(s) {
  if (s.gate === "human") return "human gate";
  if (s.requires === "ready") return "ready rules";
  if (s.check) return "check, no agent";
  if (s.agent) return `${s.agent} agent`;
  return "daemon";
}

// The pass % of a stage's finished runs in the window; null with none.
export const passPct = (h) => (h && h.pass + h.fail ? Math.round((100 * h.pass) / (h.pass + h.fail)) : null);

// The flow's rows, in path order: each stage with its number, chips, kind, routes, step and
// whether that step is shared, and the tickets on it now (`live`: status.json's tickets).
// Grooming comes first, as the row that picks the blueprint, when the file has its runs.
export function flowRows(doc, b, live = []) {
  if (!b || b.error) return [];
  const order = stageOrder(b);
  const groom = b.grooming ? [{ id: "grooming", step: null, agent: null, role: "triage", check: null, next: [b.start], on_fail: null, gate: "auto", requires: null,
    output: "GROOMING.md", runs: b.grooming_runs ?? 0, ...b.grooming, onPath: true, who: "triage agent", grooming: true }] : [];
  return [...groom, ...order].map((s, i) => {
    const n = usedBy(doc, s.step).length;
    return {
      ...s, n: i + 1,
      // Another way on passes it by: a stage before it can go straight to where it leads.
      skip: order.some((o) => o.next.includes(s.id) && o.next.some((y) => y !== s.id && (s.next ?? []).includes(y))),
      you: s.gate === "human",
      here: live.filter((t) => t.blueprint === b.name && t.state === "running" && (t.stage ?? "").toLowerCase() === s.id).map((t) => t.id),
      kind: s.grooming ? "picks the blueprint" : stageKind(s),
      failsTo: s.on_fail ?? null,
      waits: s.requires === "ready" ? "the ready rules" : s.gate === "human" ? "you" : null,
      must: s.role === "verify" ? "a holdout verdict" : s.role === "review" ? "a review verdict" : null,
      shared: s.grooming ? "every blueprint" : n > 1 ? `shared · ${n} blueprints` : s.step ? "only here" : "written here, no step",
      pct: passPct(s),
    };
  });
}

// The fail-back arcs on the flow's left: from each failing row up (or down) to its on_fail
// row, one lane each so they never overlap; lane 0 is nearest the nodes.
export function failArcs(rows) {
  const at = Object.fromEntries(rows.map((r, i) => [r.id, i]));
  return rows.filter((r) => r.failsTo && at[r.failsTo] != null).map((r, lane) => ({ from: at[r.id], to: at[r.failsTo], lane, id: r.id, to_id: r.failsTo }));
}

// A blueprint is live when a ticket on it runs now.
export const isLive = (b, live = []) => live.some((t) => t.blueprint === b.name && t.state === "running");

// The stats strip's tiles; a number with nothing to measure is left out, never made up.
export function statTiles(stats, days) {
  if (!stats) return [];
  const tiles = [{ value: String(stats.tickets), label: `tickets · ${days}d` }];
  if (stats.clean != null) tiles.push({ value: `${Math.round(stats.clean * 100)}%`, label: "no fail-back" });
  if (stats.ask_to_pr_min != null) tiles.push({ value: took(stats.ask_to_pr_min * 60), label: "ask → PR, median" });
  if (stats.usd != null) tiles.push({ value: `$${stats.usd.toFixed(2)}`, label: "per ticket, median" });
  return tiles;
}

// Where the pass exit goes: the next stages, or done.
export const passTo = (s) => (s.next.length ? s.next.map((n) => (n === "end" ? "done" : n)).join(" or ") : "done");
