// blueprints.json, the Blueprint page's data (daemon/blueprints.ts writes it), and
// the order the page draws a blueprint's stages in. Pure, so node tests it.

export function validateBlueprints(doc) {
  const errors = [];
  if (!doc || !Number.isInteger(doc.days) || !Array.isArray(doc.blueprints)) return ["needs {days, blueprints: []}"];
  doc.blueprints.forEach((b, i) => {
    const p = `blueprints[${i}]`;
    if (typeof b.name !== "string") errors.push(`${p}.name: needs text`);
    if (b.error != null && typeof b.error !== "string") errors.push(`${p}.error: needs text or null`);
    if (!Array.isArray(b.stages)) return errors.push(`${p}.stages: needs an array`);
    // The V2 page's numbers (lib/blueprint-v2.js), absent from an older daemon's file.
    if (b.stats != null && !Number.isInteger(b.stats.tickets)) errors.push(`${p}.stats: needs {tickets, clean, ask_to_pr_min, usd}`);
    b.stages.forEach((s, j) => {
      if (typeof s.id !== "string" || !Number.isInteger(s.runs) || !Array.isArray(s.next)) errors.push(`${p}.stages[${j}]: needs {id, runs, next}`);
      if (s.step != null && typeof s.step !== "string") errors.push(`${p}.stages[${j}].step: needs text or null`);
      if (s.last != null && (!Array.isArray(s.last) || !Array.isArray(s.recent))) errors.push(`${p}.stages[${j}]: needs last and recent as lists`);
    });
  });
  if (doc.steps != null && (typeof doc.steps !== "object" || Array.isArray(doc.steps))) errors.push("steps: needs {name: {file, label, description, output}}");
  (doc.drafts ?? []).forEach((d, i) => {
    if (typeof d.name !== "string" || !Number.isInteger(d.ticket) || !Array.isArray(d.stages)) errors.push(`drafts[${i}]: needs {name, ticket, stages}`);
  });
  return errors;
}

// The path with no surprises first (start, then each stage's first next), then any
// stage it skips. Each stage gets what its box says under the name.
export function stageOrder(b) {
  const by = Object.fromEntries(b.stages.map((s) => [s.id, s]));
  const path = [];
  for (let at = b.start; at && by[at] && !path.includes(at); at = by[at].next[0]) path.push(at);
  const rest = b.stages.map((s) => s.id).filter((id) => !path.includes(id));
  return [...path, ...rest].map((id) => ({ ...by[id], onPath: path.includes(id), who: by[id].agent ? `${by[id].agent} agent` : by[id].check ? `check: ${by[id].check}` : by[id].gate === "human" ? "you" : "daemon" }));
}

// One line per thing the boxes can't show: skips, failure routes, gates, rules.
export function stageNotes(b) {
  const notes = [];
  for (const s of b.stages) {
    if (s.next.length > 1) notes.push(`${s.id} can go to ${s.next.join(" or ")}; the ${b.orchestrator ?? "orchestrator"} agent picks.`);
    if (s.on_fail) notes.push(`${s.id} fails back to ${s.on_fail}.`);
    if (s.requires === "ready") notes.push(`${s.id} waits for the ready rules.`);
    if (s.gate === "human") notes.push(`${s.id} waits for you.`);
    if (s.role === "verify" || s.role === "review") notes.push(`${s.id} must end with a ${s.role === "verify" ? "holdout" : "review"} verdict.`);
  }
  return notes;
}

const SAME = ["step", "agent", "check", "on_fail", "gate", "requires"];
const differs = (a, b) => SAME.some((k) => (a[k] ?? null) !== (b[k] ?? null)) || (a.next ?? []).join() !== (b.next ?? []).join();

// A pending maintainer request's draft of a blueprint, set against the current one: each
// draft stage marked added, changed or same, in the draft's path order, and the stages
// the draft drops. `current` is null for a blueprint the request creates.
export function draftView(current, draft) {
  const old = Object.fromEntries((current?.stages ?? []).map((s) => [s.id, s]));
  const have = new Set(draft.stages.map((s) => s.id));
  const marked = { ...draft, stages: draft.stages.map((s) => ({ ...s, change: !current || !old[s.id] ? "added" : differs(old[s.id], s) ? "changed" : "same" })) };
  const stages = draft.error ? [] : stageOrder(marked);
  const removed = (current?.stages ?? []).filter((s) => !have.has(s.id));
  const count = (c) => stages.filter((s) => s.change === c).length;
  const parts = [[count("added"), "added"], [removed.length, "removed"], [count("changed"), "changed"]].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  return { name: draft.name, ticket: draft.ticket, title: draft.title ?? "", isNew: !current, error: draft.error ?? null, stages, removed,
    summary: current ? parts.join(", ") || "no stage changes (only text differs)" : "a new blueprint" };
}

// Each pending draft with the current blueprint it replaces, for the page.
export function draftsFor(doc, name) {
  return (doc?.drafts ?? []).filter((d) => d.name === name).map((d) => draftView((doc.blueprints ?? []).find((b) => b.name === name) ?? null, d));
}
