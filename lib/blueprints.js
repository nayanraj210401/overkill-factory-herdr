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
    b.stages.forEach((s, j) => {
      if (typeof s.id !== "string" || !Number.isInteger(s.runs) || !Array.isArray(s.next)) errors.push(`${p}.stages[${j}]: needs {id, runs, next}`);
    });
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
