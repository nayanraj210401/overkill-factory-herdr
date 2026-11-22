// The learner talks to the maintainer (plan: What the learner learns). It never writes a
// file: an override that held for learn.promote_after merged tickets, a lesson that keeps
// firing, or any change outside learn.tunable becomes a maintainer request carrying its
// evidence, through the same request() Overwatch uses, marked as from the learner. One
// request per override, and none while another for the same setting is still open.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import { request } from "./maintainer.ts";
import { interactionsBefore } from "./metrics.ts";
import { readFactory, type Run } from "./runner.ts";

export const PROMOTE_AFTER = 30;
const TARGET = "cost_per_pr";
const FINISHED = ["merged", "closed"];

// A ticket's value on learn.target; null when it has none (no PR, no usage recorded).
export function ticketMetric(db: Database, id: number, target: string): number | null {
  const opened = (db.query("SELECT MIN(at) AS at FROM decisions WHERE ticket = ? AND who = 'daemon' AND what LIKE 'opened PR #%'").get(id) as { at: string | null }).at;
  if (target === "cost_per_pr") return (db.query("SELECT SUM(usd) AS usd FROM usage WHERE ticket = ?").get(id) as { usd: number | null }).usd;
  if (target === "time_to_pr") {
    const began = (db.query("SELECT MIN(started_at) AS at FROM stages WHERE ticket = ?").get(id) as { at: string | null }).at;
    return opened && began ? (Date.parse(opened) - Date.parse(began)) / 60000 : null;
  }
  if (target === "interactions_per_pr") return opened ? interactionsBefore(db, id, opened) : null;
  if (target === "review_rounds_per_pr") return (db.query("SELECT COUNT(*) AS n FROM review_rounds WHERE ticket = ?").get(id) as { n: number }).n;
  return null;
}

const avgOf = (db: Database, ids: number[], target: string) => {
  const xs = ids.map((id) => ticketMetric(db, id, target)).filter((x): x is number => x != null);
  return xs.length ? { avg: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null;
};
const show = (target: string, v: number) => (target === "cost_per_pr" ? `$${v.toFixed(2)}` : target === "time_to_pr" ? `${Math.round(v)} min` : v.toFixed(1));

// The request this key filed, while it's open; `ever` counts a finished one too.
function filed(db: Database, key: string, ever = false) {
  const id = getMeta(db, `learner:${key}`);
  if (!id) return false;
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(Number(id)) as { state: string } | null;
  return !!t && (ever || !FINISHED.includes(t.state));
}

function file(db: Database, o: { keys: string[]; text: string; evidence: string; dir: string; slug: string; run: Run; now: string }) {
  const r = request(db, { text: o.text, evidence: o.evidence, from: "learner", dir: o.dir, repo: o.slug, run: o.run, now: o.now });
  for (const k of o.keys) setMeta(db, `learner:${k}`, String(r.id));
  return r;
}

// Every 10 minutes: overrides that held, and lessons that keep firing, go to the maintainer.
export function promoteOverrides(db: Database, o: { dir: string; repo: string; slug: string; run: Run; now: string }) {
  const learn = readFactory(o.repo).learn ?? {};
  const after = learn.promote_after ?? PROMOTE_AFTER;
  const target = learn.target ?? TARGET;
  const out: { id: number; title: string }[] = [];
  // Work tickets the factory started (they carry a settings snapshot), not requests themselves.
  const merged = (db.query("SELECT id, settings FROM tickets WHERE state = 'merged' AND settings IS NOT NULL AND blueprint != 'factory' ORDER BY id").all() as { id: number; settings: string }[])
    .map((t) => { try { return { id: t.id, on: JSON.parse(t.settings) as Record<string, unknown> }; } catch { return { id: t.id, on: {} }; } });
  const overrides = db.query("SELECT id, key, value, reason, created_at FROM overrides WHERE undone_at IS NULL ORDER BY id").all() as { id: number; key: string; value: string; reason: string | null; created_at: string }[];
  for (const ov of overrides) {
    if (filed(db, `override:${ov.id}`, true) || filed(db, `setting:${ov.key}`)) continue;
    const held = merged.filter((t) => ov.key in t.on && JSON.stringify(t.on[ov.key]) === ov.value).map((t) => t.id);
    if (held.length < after) continue;
    const others = merged.map((t) => t.id).filter((id) => !held.includes(id));
    const withIt = avgOf(db, held, target), before = avgOf(db, others, target);
    const evidence = [
      `- Override #${ov.id}: \`${ov.key}\` = \`${ov.value}\`, set ${ov.created_at.slice(0, 10)}${ov.reason ? ` (${ov.reason})` : ""}.`,
      `- Held for ${held.length} merged tickets (learn.promote_after: ${after}).`,
      `- Metric (learn.target): ${target}. Before: ${before ? `${show(target, before.avg)} over ${before.n} tickets` : "no tickets without it to compare"}. After: ${withIt ? `${show(target, withIt.avg)} over ${withIt.n} tickets` : "not measured"}.`,
      `- Make it permanent where the setting lives (\`factory learn export\` prints the edit); once that merges, the override matches the file and can be undone.`,
    ].join("\n");
    out.push(file(db, { keys: [`override:${ov.id}`, `setting:${ov.key}`], text: `Make ${ov.key} = ${ov.value} permanent (override #${ov.id}, held for ${held.length} tickets)`, evidence, ...o }));
  }
  // A lesson loaded into many briefs is a mistake that keeps coming back: a check catches it for good.
  const lessons = db.query("SELECT id, area, text, source, hits FROM lessons WHERE retired_at IS NULL AND dup_of IS NULL AND hits >= ? ORDER BY id").all(after) as { id: number; area: string; text: string; source: string; hits: number }[];
  for (const l of lessons) {
    if (filed(db, `lesson:${l.id}`, true)) continue;
    const evidence = [
      `- Lesson #${l.id} (area \`${l.area}\`, from ${l.source}): ${l.text}`,
      `- Loaded into ${l.hits} ticket briefs (learn.promote_after: ${after}).`,
      "- A lint rule, test or ready rule would catch it without a brief; retire the lesson once the check merges.",
    ].join("\n");
    out.push(file(db, { keys: [`lesson:${l.id}`], text: `Turn lesson #${l.id} (${l.area}) into a lint rule or test`, evidence, ...o }));
  }
  return out;
}

// `factory learn suggest`: a change outside learn.tunable (a prompt, a stage, a check), with its evidence.
export function learnerSuggest(db: Database, o: { dir: string; repo: string; slug: string; text: string; evidence: string; run: Run; now: string }) {
  if (!o.evidence.trim()) throw new Error('usage: factory learn suggest "<the change>" --why "<the evidence: metric, before/after, tickets>"');
  const key = `suggest:${o.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
  if (filed(db, key)) return null;
  return file(db, { keys: [key], text: o.text, evidence: o.evidence, dir: o.dir, slug: o.slug, run: o.run, now: o.now });
}
