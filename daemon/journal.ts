// Ticket memory, layer 1 (plan: Ticket memory): each ticket's journal, one append-only row per
// thing that happened to it, written by the daemon at the moment it knows (a stage entered, a
// session started with the transcript it writes, a question and its answer, a check's result, a
// send-back's note, the PR, the merge), with full-text search. `ref` points back at the source:
// `transcript:<path>`, `decision:<id>`, `ask:<id>`, `session:<id>`, `evidence:<id>`, a commit.
// Agent memory (memory.ts) is cross-ticket learning; this is one ticket's history.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { transcriptDir } from "./usage.ts";
import { ftsQuery } from "./memory.ts";

export const MAX_EVENT = 2000; // characters kept of an event's text
export const STATUS_EVENTS = 8; // the newest events per ticket in status.json
export const STATUS_TEXT = 200; // characters of each there

export type Event = { id: number; ticket: number; session: number | null; kind: string; text: string; ref: string | null; at: string };
export type NewEvent = { ticket: number | null | undefined; session?: number | null; kind: string; text: string; ref?: string | null; at: string };

const cap = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// One event. Nothing about no ticket (an ask about none) is journaled.
export function journal(db: Database, e: NewEvent) {
  if (e.ticket == null || !e.text.trim()) return;
  db.query("INSERT INTO ticket_events (ticket, session, kind, text, ref, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.ticket, e.session ?? null, e.kind, cap(e.text, MAX_EVENT), e.ref ?? null, e.at);
}

// Ends a ticket's open sessions (or one), each with a session-end event saying why.
export function endSessions(db: Database, o: { ticket: number; at: string; why: string; id?: number }) {
  const open = db.query(`SELECT id, stage, agent FROM sessions WHERE ticket = ? AND ended_at IS NULL${o.id != null ? " AND id = ?" : ""}`)
    .all(...(o.id != null ? [o.ticket, o.id] : [o.ticket])) as { id: number; stage: string; agent: string | null }[];
  for (const s of open) {
    db.query("UPDATE sessions SET ended_at = ? WHERE id = ?").run(o.at, s.id);
    journal(db, { ticket: o.ticket, session: s.id, kind: "session-end", text: `${s.stage} session ended${s.agent ? ` (${s.agent})` : ""}: ${o.why}`, ref: `session:${s.id}`, at: o.at });
  }
}

// The transcript Claude Code writes for a session started in `cwd` with --session-id `id`. It
// names the folder after the cwd as it sees it, the real path.
export function transcriptPath(cwd: string, id: string) {
  const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return join(transcriptDir(real), `${id}.jsonl`);
}

// A Claude session gets a known id, so its row can name its transcript. The flag goes just before
// the brief, which stays last. Any other harness is left as it is.
export function claudeSession(argv: string[], cwd: string | null | undefined) {
  if (argv[0] !== "claude" || !cwd) return { argv, id: null, transcript: null };
  const id = randomUUID();
  return { argv: [...argv.slice(0, -1), "--session-id", id, ...argv.slice(-1)], id, transcript: transcriptPath(cwd, id) };
}

// The session row just inserted, journaled with where its transcript will be.
export function journalSessionStart(db: Database, o: { ticket: number; session: number; stage: string; agent: string | null; transcript: string | null; at: string; why?: string }) {
  const n = (db.query("SELECT COUNT(*) AS n FROM sessions WHERE ticket = ? AND stage = ?").get(o.ticket, o.stage) as { n: number }).n;
  journal(db, { ticket: o.ticket, session: o.session, kind: "session-start",
    text: `${o.stage} session ${n} started${o.agent ? ` (${o.agent})` : ""}${o.why ? `: ${o.why}` : ""}`,
    ref: o.transcript ? `transcript:${o.transcript}` : `session:${o.session}`, at: o.at });
}

// The ticket's events in order; with a query, the closest by full-text rank.
export function ticketEvents(db: Database, ticket: number, o: { query?: string; limit?: number } = {}): Event[] {
  if (o.query != null) {
    const q = ftsQuery(o.query);
    if (!q) return [];
    return db.query(`SELECT e.* FROM ticket_events_fts f JOIN ticket_events e ON e.id = f.rowid
      WHERE ticket_events_fts MATCH ? AND e.ticket = ? ORDER BY bm25(ticket_events_fts), e.id LIMIT ?`).all(q, ticket, o.limit ?? 20) as Event[];
  }
  return db.query("SELECT * FROM ticket_events WHERE ticket = ? ORDER BY at, id").all(ticket) as Event[];
}

// status.json's `events`: each ticket's newest few, oldest first, text cut short.
export function recentEvents(db: Database, n = STATUS_EVENTS) {
  const rows = db.query(`SELECT ticket, kind, text, at FROM (
      SELECT ticket, kind, text, at, id, ROW_NUMBER() OVER (PARTITION BY ticket ORDER BY at DESC, id DESC) AS k FROM ticket_events
    ) WHERE k <= ? ORDER BY ticket, at, id`).all(n) as { ticket: number; kind: string; text: string; at: string }[];
  return Map.groupBy(rows.map((r) => ({ ticket: r.ticket, kind: r.kind, text: cap(r.text.replace(/\s+/g, " "), STATUS_TEXT), at: r.at })), (r) => r.ticket);
}

export const eventLine = (e: Pick<Event, "kind" | "text" | "at" | "ref">) =>
  `${e.at.slice(0, 16).replace("T", " ")}  ${e.kind.padEnd(13)} ${e.text.replace(/\s+/g, " ")}${e.ref ? `  [${e.ref}]` : ""}`;

// A decision row's kind, for the backfill (live code journals its own kinds).
export function decisionKind(what: string) {
  const rules: [RegExp, string][] = [
    [/^(added |joined from |filed:|split from #)/, "created"], [/^split/, "split"], [/^groomed/, "groomed"],
    [/blocked by #|unblocked$/, "blocked"], [/^(pulled back|scope changed|the issue was edited)/, "lifecycle"], [/^paused/, "pause"], [/^(resumed|kept it; back in the queue)/, "resume"],
    [/^sent PR #\d+ back/, "send-back"], [/^review comments on PR/, "review"], [/^(opened|updated) PR/, "pr"], [/^merged/, "merged"],
    [/^(closed|dropped)/, "closed"], [/^answered/, "answer"], [/^talking it through/, "talk"], [/^asked the session for a handoff|^started session/, "handoff"],
    [/^asked (Q\d|\d+ questions?)/, "question"], [/^asked /, "ask"], [/waiting on you in the terminal/, "attention"], [/^check broken/, "check"],
    [/^(moved to the cloud|brought back from the cloud)/, "cloud"], [/^hard stop/, "parked"],
  ];
  return rules.find(([re]) => re.test(what))?.[1] ?? "decision";
}

// Migration 36: a journal for every ticket from before it, out of what the database kept
// (decisions, stages, sessions, checks, verdicts, questions, asks). Idempotent: a ticket that
// has events already is left alone. Old sessions have no known transcript: their ref is the session.
export function backfillJournal(db: Database) {
  const ids = (db.query("SELECT id FROM tickets t WHERE NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket = t.id) ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  const all = <T>(sql: string, id: number) => db.query(sql).all(id) as T[];
  let n = 0;
  for (const id of ids) {
    const t = db.query("SELECT title, updated_at, parent, blueprint, groomed_at FROM tickets WHERE id = ?").get(id) as { title: string; updated_at: string; parent: number | null; blueprint: string; groomed_at: string | null };
    const ev: (NewEvent & { order: number })[] = [];
    const add = (e: NewEvent) => ev.push({ ...e, ticket: id, order: ev.length });
    const decisions = all<{ id: number; who: string; what: string; why: string | null; at: string }>("SELECT id, who, what, why, at FROM decisions WHERE ticket = ? ORDER BY id", id);
    for (const d of decisions) add({ ticket: id, kind: decisionKind(d.what), text: `${d.who}: ${d.what}${d.why ? ` (${d.why})` : ""}`, ref: `decision:${d.id}`, at: d.at });
    for (const s of all<{ name: string; started_at: string }>("SELECT name, started_at FROM stages WHERE ticket = ? ORDER BY id", id))
      add({ ticket: id, kind: "stage", text: `entered ${s.name}`, at: s.started_at }); // its detail is the stage's last, not how it began
    for (const s of all<{ id: number; stage: string; agent: string | null; started_at: string; ended_at: string | null; transcript: string | null }>("SELECT id, stage, agent, started_at, ended_at, transcript FROM sessions WHERE ticket = ? ORDER BY id", id)) {
      add({ ticket: id, session: s.id, kind: "session-start", text: `${s.stage} session started${s.agent ? ` (${s.agent})` : ""}`, ref: s.transcript ? `transcript:${s.transcript}` : `session:${s.id}`, at: s.started_at });
      if (s.ended_at) add({ ticket: id, session: s.id, kind: "session-end", text: `${s.stage} session ended${s.agent ? ` (${s.agent})` : ""}`, ref: `session:${s.id}`, at: s.ended_at });
    }
    for (const c of all<{ id: number; check_name: string; result: string; detail: string | null; at: string }>("SELECT id, check_name, result, detail, at FROM evidence WHERE ticket = ? ORDER BY id", id))
      add({ ticket: id, kind: "check", text: `${c.check_name} ${c.result}${c.detail ? `: ${c.detail}` : ""}`, ref: `evidence:${c.id}`, at: c.at });
    for (const v of all<{ session: number | null; kind: string; voter: string; result: string; detail: string | null; at: string }>("SELECT session, kind, voter, result, detail, at FROM verdicts WHERE ticket = ? ORDER BY id", id))
      add({ ticket: id, session: v.session, kind: "verdict", text: `${v.kind} ${v.result} from ${v.voter}${v.detail ? `: ${v.detail}` : ""}`, at: v.at });
    for (const q of all<{ n: number; kind: string; text: string; asked_at: string; answer: string | null; answered_by: string | null; answered_at: string | null }>("SELECT * FROM questions WHERE ticket = ? ORDER BY n", id)) {
      add({ ticket: id, kind: "question", text: `Q${q.n} (${q.kind}): ${q.text}`, ref: `question:${q.n}`, at: q.asked_at });
      if (q.answer != null && q.answered_at) add({ ticket: id, kind: "answer", text: `A${q.n} from ${q.answered_by ?? "someone"}: ${q.answer}`, ref: `question:${q.n}`, at: q.answered_at });
    }
    for (const a of all<{ id: number; from_agent: string; to_agent: string; text: string; why: string | null; at: string }>("SELECT id, from_agent, to_agent, text, why, at FROM asks WHERE about = ? ORDER BY id", id))
      add({ ticket: id, kind: "ask", text: `${a.from_agent} asked ${a.to_agent}: ${a.text}${a.why ? ` (${a.why})` : ""}`, ref: `ask:${a.id}`, at: a.at });
    if (!ev.some((e) => e.kind === "created")) {
      const first = ev.map((e) => e.at).sort()[0] ?? t.updated_at;
      add({ ticket: id, kind: "created", text: `${t.title}${t.parent != null ? ` (part of #${t.parent})` : ""}`, at: first });
    }
    // Rows of one instant in the order the daemon writes them: a session ends, its checks run, the next stage starts.
    const rank = (k: string) => ["created", "session-end", "check", "verdict"].indexOf(k) + 1 || (k === "stage" ? 6 : k === "session-start" ? 7 : 5);
    ev.sort((a, b) => a.at.localeCompare(b.at) || rank(a.kind) - rank(b.kind) || a.order - b.order);
    for (const e of ev) journal(db, e);
    n += ev.length;
  }
  return n;
}
