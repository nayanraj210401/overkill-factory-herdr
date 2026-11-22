// Agents are neighbours (plan: The agents): any agent, or you, asks another with
// `factory ask <agent> "<text>" [--why "<evidence>"]`. The daemon routes it by the target's
// territory and records every hand-off in `asks`, with its origin and target:
//   maintainer          a maintainer request (maintainer.ts), as `factory request` files it
//   overwatch           a note in Needs you, typed into the live Overwatch terminal when one runs
//   learner, babysitter a note queued for the agent's next run
// Repo agents work one stage of one ticket and aren't asked directly: Overwatch routes that work.
import type { Database } from "bun:sqlite";
import { FACTORY_AGENTS, isFactoryAgent, type FactoryAgent } from "./agents.ts";
import { request, type Kind } from "./maintainer.ts";
import type { Run } from "./runner.ts";

export type Ask = { id: number; from: string; to: FactoryAgent; text: string; why: string | null; about: number | null; request: number | null; at: string; delivered_at: string | null; done_at: string | null };
const row = (r: any): Ask => ({ id: r.id, from: r.from_agent, to: r.to_agent, text: r.text, why: r.why, about: r.about, request: r.request, at: r.at, delivered_at: r.delivered_at, done_at: r.done_at });

// The asker: --from, else the agent this session runs as (FACTORY_AGENT, set by withFactory), else you.
export const askerOf = (flag: string | null | undefined, env = process.env) => flag || env.FACTORY_AGENT || "you";

export type AskResult = { kind: "request"; ask: Ask; id: number; title: string; requestKind: Kind; repo: string } | { kind: "note"; ask: Ask; delivered: boolean };

export function ask(db: Database, o: {
  to: string; text: string; why?: string | null; from: string; about?: number | null;
  slug: string; dir: string; run: Run; now: string; overwatch?: () => string | null; name?: string;
  requestKind?: Kind; target?: string; // for the maintainer: the request's kind and repo (maintainer.ts)
}): AskResult {
  const to = o.to.trim().toLowerCase();
  const text = o.text.trim().replace(/\s+/g, " ");
  if (!isFactoryAgent(to)) throw new Error(`ask whom? ${FACTORY_AGENTS.join(", ")}. Repo agents work one stage of one ticket: ask overwatch to route work to one`);
  if (!text) throw new Error(`say what you need: factory ask ${to} "<text>" [--why "<evidence>"]`);
  if (o.from === to) throw new Error(`${to} can't ask itself`);
  if (to === "maintainer") {
    const r = request(db, { text, repo: o.slug, run: o.run, now: o.now, from: o.from, evidence: o.why ?? undefined, dir: o.dir, about: o.about, kind: o.requestKind, target: o.target });
    return { kind: "request", ask: row(db.query("SELECT * FROM asks WHERE request = ?").get(r.id)), id: r.id, title: r.title, requestKind: r.kind, repo: r.repo };
  }
  const id = Number(db.query("INSERT INTO asks (from_agent, to_agent, text, why, about, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(o.from, to, text, o.why ?? null, o.about ?? null, o.now).lastInsertRowid);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(o.about ?? null, o.from, `asked ${to}: ${text}`.slice(0, 200), o.why ?? null, o.now);
  const delivered = to === "overwatch" && o.overwatch ? deliverToOverwatch(db, { run: o.run, now: o.now, terminal: o.overwatch, name: o.name }) > 0 : false;
  return { kind: "note", ask: row(db.query("SELECT * FROM asks WHERE id = ?").get(id)), delivered };
}

// Open notes (not maintainer requests, which are tickets), oldest first; to one agent, or all.
export function openAsks(db: Database, to?: string): Ask[] {
  return (db.query(`SELECT * FROM asks WHERE done_at IS NULL AND request IS NULL ${to ? "AND to_agent = ?" : ""} ORDER BY id`).all(...(to ? [to] : [])) as any[]).map(row);
}

export function doneAsk(db: Database, id: number, now: string) {
  const r = db.query("UPDATE asks SET done_at = ? WHERE id = ? AND done_at IS NULL AND request IS NULL").run(now, id);
  if (!r.changes) throw new Error(`no open note #${id}; factory asks lists them`);
}

// One note as the agent reads it: who asked, about what, and how to close it.
export function noteText(a: Ask, name?: string) {
  const from = a.from === "you" ? "the person" : a.from;
  return `Note #${a.id} from ${from}${a.about ? ` about #${a.about}` : ""}: ${a.text}${a.why ? ` (evidence: ${a.why})` : ""}. When it's handled: factory asks done ${a.id}${name ? ` --name ${name}` : ""}`;
}

// The learner's or babysitter's run: the notes waiting for it. Its runs are one-shot answers, so
// a note the run read is handled (delivered and done); read them with openAsks first, and take
// them once the run has answered.
export function takeNotes(db: Database, to: "learner" | "babysitter", now: string) {
  const notes = openAsks(db, to);
  for (const a of notes) db.query("UPDATE asks SET delivered_at = ?, done_at = ? WHERE id = ?").run(now, now, a.id);
  return notes;
}

// Notes to the babysitter. One about a ticket goes into that ticket's next fix-round brief and is
// done once the round has used it (`used` keeps the round, so a rewritten brief still has it).
// A general one (no ticket) goes into the judge's prompt for its next JUDGE_NOTE_RUNS judgements,
// or until it is closed.
export const JUDGE_NOTE_RUNS = 5;
export const roundNotes = (db: Database, ticket: number, round: number): Ask[] =>
  (db.query("SELECT * FROM asks WHERE to_agent = 'babysitter' AND request IS NULL AND about = ? AND (done_at IS NULL OR used = ?) ORDER BY id").all(ticket, round) as any[]).map(row);
export function useRoundNotes(db: Database, notes: Ask[], round: number, now: string) {
  for (const a of notes) db.query("UPDATE asks SET delivered_at = COALESCE(delivered_at, ?), done_at = COALESCE(done_at, ?), used = ? WHERE id = ?").run(now, now, round, a.id);
}
export const judgeNotes = (db: Database): Ask[] =>
  (db.query("SELECT * FROM asks WHERE to_agent = 'babysitter' AND request IS NULL AND about IS NULL AND done_at IS NULL ORDER BY id DESC LIMIT 3").all() as any[]).map(row).reverse();
// Counts `n` judgements against the notes given to them; a note that has had its share is done.
export function usedJudgeNotes(db: Database, notes: Ask[], n: number, now: string) {
  if (!n) return;
  for (const a of notes) db.query("UPDATE asks SET delivered_at = COALESCE(delivered_at, ?), used = used + ?, done_at = CASE WHEN used + ? >= ? THEN ? ELSE done_at END WHERE id = ?").run(now, n, n, JUDGE_NOTE_RUNS, now, a.id);
}
// Handled notes to one agent, newest first, for `factory asks <agent>`.
export const doneAsks = (db: Database, to: string, limit = 10): Ask[] =>
  (db.query("SELECT * FROM asks WHERE done_at IS NOT NULL AND request IS NULL AND to_agent = ? ORDER BY id DESC LIMIT ?").all(to, limit) as any[]).map(row);

// The notes, as a run's prompt carries them; "" with none.
export const notesSection = (notes: Ask[]) => notes.length
  ? ["Notes other agents left you (answer one with a proposal when the digest supports it; otherwise leave it):", ...notes.map((a) => `- Note #${a.id} from ${a.from === "you" ? "the person" : a.from}: ${a.text}${a.why ? ` (evidence: ${a.why})` : ""}`)].join("\n")
  : "";

// Notes to Overwatch: typed into its live terminal, once each. A terminal that's gone, or a
// send that fails, leaves the note for the next tick; it is in Needs you either way.
export function deliverToOverwatch(db: Database, o: { run: Run; now: string; terminal: () => string | null; name?: string }) {
  const waiting = openAsks(db, "overwatch").filter((a) => !a.delivered_at);
  if (!waiting.length) return 0;
  const terminal = o.terminal();
  if (!terminal) return 0;
  let n = 0;
  for (const a of waiting) {
    if (o.run(["hc", "send", terminal, noteText(a, o.name)]).code !== 0) break;
    db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(o.now, a.id);
    n++;
  }
  return n;
}
