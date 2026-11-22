// The learner talks to the maintainer (plan: What the learner learns). Two halves:
//   - code, deterministic: overrides held for learn.promote_after tickets and lessons that
//     keep firing become requests (promoteOverrides, every 10 minutes);
//   - the learner agent (learner.md): on a schedule, one claude -p call reads a digest the
//     daemon builds and returns proposals in a fixed format, each filed as a request
//     (runLearner). It spends only from budget.learning.
// It never writes a
// file: an override that held for learn.promote_after merged tickets, a lesson that keeps
// firing, or any change outside learn.tunable becomes a maintainer request carrying its
// evidence, through the same request() Overwatch uses, marked as from the learner. One
// request per override, and none while another for the same setting is still open.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import { notesSection, openAsks, takeNotes } from "./ask.ts";
import { request } from "./maintainer.ts";
import { interactionsBefore, planKnown, planMeters } from "./metrics.ts";
import { readFactory, type Run } from "./runner.ts";
import { factoryMap, loadAgent } from "./agents.ts";
import { accountDayCap, dayCap, tokensToday } from "./budget.ts";
import { pinModel } from "./models.ts";
import { parseTokens } from "../lib/model.js";

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

// ---- the learner agent ----------------------------------------------------------------

export const REVIEW_EVERY = 10;
export const WARMUP_TICKETS = 20;
export const PAUSE_ABOVE = 0.7;
export const LEARNING_SHARE = "10%";
const DAY = 86_400_000;
const RETRY_AFTER = 3_600_000; // a failed call waits an hour, not a tick
const DIGEST_TICKETS = 100; // the newest finished work tickets the digest looks at
const MAX_PROPOSALS = 5;
type Tokens = { input: number; output: number };

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// "70%" or 0.7 as a fraction; anything else is the default.
function share(v: unknown, dflt: number) {
  if (v == null || v === "") return dflt;
  const n = parseFloat(String(v));
  if (!(n >= 0)) return dflt;
  return String(v).includes("%") || n > 1 ? n / 100 : n;
}

// budget.learning: a share of the day's budget ("10%", the default) or tokens ("2M",
// "2M/100k" for input/output). A share of no day cap is no cap.
export function learningCap(repo: string): Tokens | null {
  const v = String(((readFactory(repo) as any).budget ?? {}).learning ?? LEARNING_SHARE).trim();
  if (v.endsWith("%")) {
    const day = dayCap(repo) ?? accountDayCap();
    const f = share(v, 0.1);
    return day && f > 0 ? { input: day.input * f, output: day.output * f } : null;
  }
  const [input, output] = v.split("/").map((x) => parseTokens(x.trim()));
  return input || output ? { input: input || Infinity, output: output || Infinity } : null;
}

// What learner runs spent today (UTC day, as tokensToday counts).
export function learningSpent(db: Database, now: Date): Tokens {
  const r = db.query("SELECT SUM(tokens_in) AS i, SUM(tokens_out) AS o FROM learner_runs WHERE started_at >= ?").get(now.toISOString().slice(0, 10)) as { i: number | null; o: number | null };
  return { input: r.i ?? 0, output: r.o ?? 0 };
}

// Work tickets (not the maintainer's requests) that merged.
const mergedWork = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged' AND blueprint != 'factory'").get() as { n: number }).n;

const learnOf = (repo: string) => (readFactory(repo).learn ?? {}) as NonNullable<ReturnType<typeof readFactory>["learn"]>;

// Why the learner may not run now, or null: warmup, the 5-hour window or the day's budget
// past learn.pause_above, or budget.learning spent (with `need`, the run's estimated input).
export function learnerHold(db: Database, repo: string, now: Date, need = 0): string | null {
  const learn = learnOf(repo);
  const warmup = learn.warmup_tickets ?? WARMUP_TICKETS;
  const merged = mergedWork(db);
  if (merged < warmup) return `warming up: ${merged} of learn.warmup_tickets ${warmup} tickets merged, so only logging`;
  const pause = share(learn.pause_above, PAUSE_ABOVE);
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  if (planKnown(db)) {
    const w = planMeters(db, now).window_5h;
    if (w >= pause) return `the 5-hour window is at ${pct(w)}, past learn.pause_above ${pct(pause)}`;
  }
  const day = dayCap(repo);
  if (day) {
    const used = tokensToday(db, now);
    const f = Math.max(used.input / day.input, used.output / day.output);
    if (f >= pause) return `the day's budget is at ${pct(f)}, past learn.pause_above ${pct(pause)}`;
  }
  const cap = learningCap(repo);
  if (cap) {
    const spent = learningSpent(db, now);
    if (spent.input + need > cap.input || spent.output >= cap.output) return `budget.learning is spent for today (${Math.round(spent.input)}/${Math.round(cap.input)} in, ${Math.round(spent.output)}/${Math.round(cap.output)} out)`;
  }
  return null;
}

type LastRun = { started_at: string; status: string; merged: number } | null;
const lastRun = (db: Database, done = false) =>
  db.query(`SELECT started_at, status, merged FROM learner_runs ${done ? "WHERE status != 'failed'" : ""} ORDER BY id DESC LIMIT 1`).get() as LastRun;

// When the learner runs: after every learn.review_every merged tickets (default 10), and
// once a day when anything merged since its last run. The first run comes after warmup.
export function learnerDue(db: Database, repo: string, now: Date): { due: boolean; why: string } {
  const every = learnOf(repo).review_every ?? REVIEW_EVERY;
  const merged = mergedWork(db);
  const any = lastRun(db);
  if (any?.status === "failed" && now.getTime() - Date.parse(any.started_at) < RETRY_AFTER) return { due: false, why: "the last run failed; it tries again an hour later" };
  const last = lastRun(db, true);
  if (!last) return { due: true, why: "first run" };
  if (merged - last.merged >= every) return { due: true, why: `${merged - last.merged} tickets merged since the last run (learn.review_every ${every})` };
  if (now.getTime() - Date.parse(last.started_at) >= DAY && merged > last.merged) return { due: true, why: "daily run" };
  return { due: false, why: merged > last.merged ? "ran less than a day ago" : "nothing merged since the last run" };
}

// ---- the digest ----

export type Digest = {
  target: string;
  tickets: { finished: number; merged: number; reverted: number; revert_rate: number };
  trend: { tickets: string; value: number | null; n: number }[];
  settings: { key: string; value: string; tickets: number; merged: number; reverted: number; target: number | null }[];
  overrides: { id: number; key: string; value: string; since: string; reason: string | null }[];
  lessons: { id: number; area: string; text: string; hits: number }[];
  repeated_comments: { text: string; times: number; tickets: number }[];
  open_requests: { id: number; title: string; from: string }[];
};

const round = (v: number | null) => (v == null ? null : +v.toFixed(3));

// The compact view of the factory's history the learner reads, all from SQLite.
export function learnerDigest(db: Database, repo: string): Digest {
  const learn = learnOf(repo);
  const target = learn.target ?? TARGET;
  const every = learn.review_every ?? REVIEW_EVERY;
  const rows = (db.query(`SELECT id, state, settings, reverted_by FROM tickets WHERE state IN ('merged', 'closed') AND blueprint != 'factory' ORDER BY id DESC LIMIT ?`)
    .all(DIGEST_TICKETS) as { id: number; state: string; settings: string | null; reverted_by: number | null }[]).reverse();
  const t = rows.map((r) => {
    let on: Record<string, unknown> = {};
    try { on = JSON.parse(r.settings ?? "{}") ?? {}; } catch {}
    return { ...r, on, metric: r.state === "merged" ? ticketMetric(db, r.id, target) : null };
  });
  const merged = t.filter((x) => x.state === "merged");
  const reverted = merged.filter((x) => x.reverted_by != null).length;
  const avg = (xs: typeof t) => { const v = xs.map((x) => x.metric).filter((m): m is number => m != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  // The target over consecutive groups of learn.review_every merged tickets, oldest first.
  const trend: Digest["trend"] = [];
  for (let i = 0; i < merged.length; i += every) {
    const g = merged.slice(i, i + every);
    trend.push({ tickets: `#${g[0].id}–#${g.at(-1)!.id}`, value: round(avg(g)), n: g.length });
  }
  // Outcomes by setting value: every key a ticket ran with, or learn.tunable names; a
  // ticket without it ran on the file's value.
  const keys = [...new Set([...(learn.tunable ?? []), ...t.flatMap((x) => Object.keys(x.on))])].sort();
  const settings: Digest["settings"] = keys.flatMap((key) => {
    const by = Map.groupBy(t, (x) => (key in x.on ? JSON.stringify(x.on[key]) : "(file)"));
    return [...by].map(([value, xs]) => {
      const m = xs.filter((x) => x.state === "merged");
      return { key, value, tickets: xs.length, merged: m.length, reverted: m.filter((x) => x.reverted_by != null).length, target: round(avg(m)) };
    });
  });
  const overrides = (db.query("SELECT id, key, value, reason, created_at FROM overrides WHERE undone_at IS NULL ORDER BY id").all() as any[])
    .map((o) => ({ id: o.id, key: o.key, value: o.value, since: String(o.created_at).slice(0, 10), reason: o.reason }));
  const lessons = db.query("SELECT id, area, text, hits FROM lessons WHERE retired_at IS NULL AND dup_of IS NULL ORDER BY hits DESC, id LIMIT 15").all() as Digest["lessons"];
  // A comment that came back on more than one ticket, by its words.
  const comments = db.query("SELECT ticket, body FROM comments").all() as { ticket: number; body: string }[];
  const groups = Map.groupBy(comments, (c) => normal(c.body).slice(0, 120));
  const repeated = [...groups].filter(([k, cs]) => k && new Set(cs.map((c) => c.ticket)).size >= 2)
    .map(([, cs]) => ({ text: cs[0].body.trim().replace(/\s+/g, " ").slice(0, 200), times: cs.length, tickets: new Set(cs.map((c) => c.ticket)).size }))
    .sort((a, b) => b.tickets - a.tickets || b.times - a.times).slice(0, 10);
  const open = (db.query("SELECT id, title, trigger_name FROM tickets WHERE blueprint = 'factory' AND state NOT IN ('merged', 'closed') ORDER BY id").all() as any[])
    .map((r) => ({ id: r.id, title: r.title, from: r.trigger_name === "learner" ? "learner" : "you" }));
  return {
    target,
    tickets: { finished: t.length, merged: merged.length, reverted, revert_rate: merged.length ? round(reverted / merged.length)! : 0 },
    trend, settings, overrides, lessons, repeated_comments: repeated, open_requests: open,
  };
}

// ---- the call and its answer ----

const FORMAT = [
  "Answer in exactly this format and nothing else. For each change you propose, two lines:",
  "PROPOSAL: <the change, in one sentence>",
  "WHY: <the evidence from the digest, in one line: the metric, before and after, the ticket count, the override or lesson id>",
  `At most ${MAX_PROPOSALS} proposals. When nothing is worth proposing, answer with the single line NONE.`,
];

export const learnerPrompt = (role: string, d: Digest) => [role.trim(), "", ...FORMAT, "", "The digest (JSON):", JSON.stringify(d)].join("\n");

export type LearnerProposal = { change: string; why: string };

// Strict: PROPOSAL lines each followed by a WHY line, or NONE. A proposal without its WHY is
// dropped; an answer with neither a whole proposal nor NONE is unreadable (null).
export function parseProposals(out: string): LearnerProposal[] | null {
  const lines = out.split("\n").map((l) => l.trim().replace(/^[-*>\s`]+/, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  const got: LearnerProposal[] = [];
  let none = false;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].match(/^proposal\s*:\s*(.+)$/i);
    if (p) {
      const w = lines[i + 1]?.match(/^why\s*:\s*(.+)$/i);
      if (w) { got.push({ change: p[1].trim().slice(0, 300), why: w[1].trim().slice(0, 1000) }); i++; }
      continue;
    }
    if (/^none\.?$/i.test(lines[i])) none = true;
  }
  if (got.length) return got.slice(0, MAX_PROPOSALS);
  return none ? [] : null;
}

// claude -p --output-format json gives the answer and its usage; anything else is read as
// plain text, with tokens estimated from its length so the budget still counts it.
function readAnswer(out: string, prompt: string) {
  try {
    const j = JSON.parse(out);
    if (j && typeof j === "object" && typeof j.result === "string") {
      const u = j.usage ?? {};
      return { text: j.result as string, input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null, error: j.is_error === true };
    }
  } catch {}
  return { text: out, input: Math.ceil(prompt.length / 4), output: Math.ceil(out.length / 4), usd: null, error: false };
}

// An open request that already asks for this, from anyone.
function alreadyAsked(db: Database, text: string) {
  const n = normal(text);
  const open = db.query("SELECT title FROM tickets WHERE blueprint = 'factory' AND state NOT IN ('merged', 'closed')").all() as { title: string }[];
  return open.some((r) => normal(r.title) === n);
}

export type LearnerResult = { ran: boolean; why: string; status?: "done" | "failed" | "unreadable"; filed: { id: number; title: string }[]; skipped: string[] };

// One learner run, when it's due and nothing holds it (`force` skips the schedule, never the
// holds). The call runs outside any transaction; the run's record and its requests land in one.
export function runLearner(db: Database, o: { dir: string; repo: string; slug: string; run: Run; now: string; force?: boolean; commit?: (fn: () => void) => void }): LearnerResult {
  const now = new Date(o.now);
  const due = learnerDue(db, o.repo, now);
  if (!due.due && !o.force) return { ran: false, why: due.why, filed: [], skipped: [] };
  const held = learnerHold(db, o.repo, now);
  if (held) return { ran: false, why: held, filed: [], skipped: [] };
  const agent = loadAgent(o.repo, "learner");
  if (!agent) throw new Error("no learner agent: neither ~/.factory/agents/learner.md nor the shipped agents/learner.md is there");
  const digest = learnerDigest(db, o.repo);
  const notes = openAsks(db, "learner"); // factory ask learner: read now, handled once the run answers
  // The neighbour map first (stable, cached), then its role, the digest and any notes for it.
  const prompt = [factoryMap(db), learnerPrompt(agent.prompt as string, digest), notesSection(notes)].filter(Boolean).join("\n\n");
  const hold = learnerHold(db, o.repo, now, Math.ceil(prompt.length / 4));
  if (hold) return { ran: false, why: hold, filed: [], skipped: [] };
  const model = pinModel(typeof agent.model === "string" ? agent.model : "sonnet")!;
  let a = { text: "", input: 0, output: 0, usd: null as number | null, error: true }, code = 0, why: string | null = null;
  try {
    const r = o.run(["claude", "-p", "--model", model, "--output-format", "json", prompt]);
    code = r.code;
    a = readAnswer(r.out, prompt);
    if (code !== 0 || a.error) why = `exit ${code}: ${a.text.split("\n")[0].slice(0, 160)}`;
  } catch (e) { why = (e as Error).message.slice(0, 160); a.input = Math.ceil(prompt.length / 4); }
  const proposals = why ? null : parseProposals(a.text);
  const status = why ? "failed" : proposals ? "done" : "unreadable";
  const out: LearnerResult = { ran: true, why: why ?? (proposals ? due.why : "unreadable answer"), status, filed: [], skipped: [] };
  (o.commit ?? ((fn) => db.transaction(fn)()))(() => {
    const id = Number(db.query("INSERT INTO learner_runs (started_at, ended_at, model, status, why, merged, tokens_in, tokens_out, usd, proposals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(o.now, new Date().toISOString(), model, status, status === "done" ? null : out.why, mergedWork(db), a.input, a.output, a.usd, proposals?.length ?? 0).lastInsertRowid);
    for (const p of proposals ?? []) {
      const key = `suggest:${normal(p.change)}`;
      if (filed(db, key) || alreadyAsked(db, p.change)) { out.skipped.push(p.change); continue; }
      const evidence = [
        `- ${p.why}`,
        `- From learner run #${id} on ${o.now.slice(0, 10)} (${model}), over the newest ${digest.tickets.finished} finished tickets; learn.target: ${digest.target}.`,
      ].join("\n");
      out.filed.push(file(db, { keys: [key], text: p.change, evidence, dir: o.dir, slug: o.slug, run: o.run, now: o.now }));
    }
    if (status === "done") takeNotes(db, "learner", o.now);
    db.query("UPDATE learner_runs SET filed = ? WHERE id = ?").run(out.filed.length ? out.filed.map((f) => f.id).join(",") : null, id);
  });
  return out;
}
