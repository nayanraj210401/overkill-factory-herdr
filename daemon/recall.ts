// Ticket memory, layer 2 (plan: Ticket memory): every linked Claude Code transcript, cut into
// chunks (a user turn, an assistant's text, a tool call with its result), redacted, and indexed
// with FTS5 in transcript_chunks. A session is indexed when it ends; the daemon's tick catches
// the rest (a transcript still being written when its session ended, sessions from before this).
// `factory recall` searches the chunks and the journal (journal.ts) together. Chunks of a ticket
// merged or closed long ago are pruned; the journal never is.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { SECRETS } from "./guard.ts";
import { ftsQuery } from "./memory.ts";

export const TOOL_CAP = 2000; // characters kept of a tool call's input, and of its result: the head and tail
export const TEXT_CAP = 8000; // and of a user or assistant turn
export const CHUNK_DAYS = 30; // chunks kept after a ticket merges or closes (factory.yaml memory.chunk_days)
const RECENT_MS = 86_400_000; // an ended session's transcript is re-checked for a day: Claude may still be writing it

export type Role = "user" | "assistant" | "tool";
export type Chunk = { line: number; role: Role; text: string; at: string | null };

// Secrets, each replaced by a marker that says what was there. The hard-stop list's patterns
// (guard.ts SECRETS) run last, so whatever it would block is never indexed either.
const NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_.-]*)?(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL)[A-Za-z0-9_]*`;
const REDACT: [RegExp, string | ((...m: string[]) => string)][] = [
  [/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g, "[redacted: private key]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_, w) => `${w} [redacted]`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted: JWT]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted: AWS key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted: GitHub token]"],
  [/\bsk-[A-Za-z0-9_-]{20,}|\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted: API key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g, "[redacted: Slack token]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[redacted: Google API key]"],
  // A line shaped like a .env entry or a YAML key (`export API_KEY=…`, `password: …`), a shell
  // assignment before a command (`GITHUB_TOKEN=… gh …`), and a quoted JSON key ("client_secret": "…").
  [new RegExp(String.raw`^(\s*(?:export\s+)?${NAME}\s*=\s*)("[^"\n]*"|'[^'\n]*'|\S+)`, "gim"), (_, k) => `${k}[redacted]`],
  [new RegExp(String.raw`^(\s*${NAME}\s*:\s*)\S.*$`, "gim"), (_, k) => `${k}[redacted]`],
  [new RegExp(String.raw`(^|[\s;&|(])((?:[A-Z_][A-Z0-9_]*)?(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*=)("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)`, "g"), (_, pre, k) => `${pre}${k}[redacted]`],
  [new RegExp(String.raw`(["']${NAME}["']\s*:\s*)("[^"\n]+"|'[^'\n]+')`, "gi"), (_, k) => `${k}"[redacted]"`],
  ...SECRETS.map(([re, what]): [RegExp, string] => [new RegExp(re.source, "g"), `[redacted: ${what}]`]),
];

export function redact(text: string) {
  return REDACT.reduce((t, [re, to]) => t.replace(re, to as any), text);
}

// The head and tail of a long text, saying how much was cut.
export function trim(text: string, cap: number) {
  const t = text.trim();
  if (t.length <= cap) return t;
  const half = Math.floor(cap / 2);
  return `${t.slice(0, half)}\n… [${t.length - 2 * half} characters cut] …\n${t.slice(-half)}`;
}

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : typeof b === "string" ? b : "")).filter(Boolean).join("\n") : "";

// What a tool was asked: each argument on its own line, so a .env written by Write is still lines.
const inputOf = (input: Record<string, unknown> | undefined) =>
  Object.entries(input ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");

// One chunk per user turn, assistant text and tool call (its result joined to it), each with
// its 1-based line in the JSONL. Thinking, meta lines (skill bodies, hook output) and Claude
// Code's bookkeeping lines are left out. Every text is redacted before it is trimmed.
export function chunkTranscript(jsonl: string): Chunk[] {
  const chunks: Chunk[] = [];
  const calls = new Map<string, { chunk: Chunk; head: string }>();
  jsonl.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    let e: any;
    try { e = JSON.parse(raw); } catch { return; } // a line still being written
    if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || !e.message) return;
    const line = i + 1, at = e.timestamp ?? null;
    const add = (role: Role, text: string, cap: number) => {
      const t = trim(redact(text), cap);
      if (!t) return null;
      const c = { line, role, text: t, at };
      chunks.push(c);
      return c;
    };
    const content = e.message.content;
    if (e.type === "user") {
      if (typeof content === "string") { add("user", content, TEXT_CAP); return; }
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === "text") add("user", b.text ?? "", TEXT_CAP);
        else if (b?.type === "tool_result") {
          const call = calls.get(b.tool_use_id);
          const result = trim(redact(textOf(b.content)), TOOL_CAP);
          if (call) call.chunk.text = `${call.head}\n→ ${b.is_error ? "error: " : ""}${result}`;
          else if (result) add("tool", `→ ${result}`, TOOL_CAP);
        }
      }
      return;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === "text") add("assistant", b.text ?? "", TEXT_CAP);
      else if (b?.type === "tool_use") {
        const c = add("tool", `${b.name}\n${trim(redact(inputOf(b.input)), TOOL_CAP)}`, TOOL_CAP * 2);
        if (c && b.id) calls.set(b.id, { chunk: c, head: c.text });
      }
    }
  });
  return chunks;
}

type SessionRow = { id: number; ticket: number; transcript: string | null; chunked_size: number | null };

// One session's chunks, from its transcript as it is now. A transcript that isn't there (the
// session ended before its first turn, or Claude Code cleaned it up) is skipped, quietly. The
// same file indexed again changes nothing; a grown one replaces the session's chunks.
export function indexSession(db: Database, id: number): "indexed" | "unchanged" | "missing" | "none" {
  const s = db.query("SELECT id, ticket, transcript, chunked_size FROM sessions WHERE id = ?").get(id) as SessionRow | null;
  if (!s?.transcript) return "none";
  if (!existsSync(s.transcript)) {
    if (s.chunked_size == null) db.query("UPDATE sessions SET chunked_size = -1 WHERE id = ?").run(id);
    return "missing";
  }
  const text = readFileSync(s.transcript, "utf8");
  const size = Buffer.byteLength(text);
  if (s.chunked_size === size) return "unchanged";
  const put = db.query("INSERT INTO transcript_chunks (session, ticket, line, role, text, at) VALUES (?, ?, ?, ?, ?, ?)");
  const chunks = chunkTranscript(text);
  db.transaction(() => {
    db.query("DELETE FROM transcript_chunks WHERE session = ?").run(id);
    for (const c of chunks) put.run(id, s.ticket, c.line, c.role, c.text, c.at);
    db.query("UPDATE sessions SET chunked_size = ? WHERE id = ?").run(size, id);
  })();
  return "indexed";
}

// The settled tickets whose chunks are past keeping: merged or closed more than `days` ago.
const settledSql = `SELECT id FROM tickets WHERE state IN ('merged', 'closed') AND updated_at < ?`;
const cutoff = (now: string, days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

// The daemon's tick: every ended session with a transcript that was never indexed, and those
// ended in the last day whose file has grown since. A ticket past pruning isn't indexed again.
export function indexTranscripts(db: Database, o: { now: string; days?: number }) {
  const rows = db.query(`SELECT id FROM sessions WHERE transcript IS NOT NULL AND ended_at IS NOT NULL
      AND (chunked_size IS NULL OR ended_at >= ?) AND ticket NOT IN (${settledSql}) ORDER BY id`)
    .all(new Date(Date.parse(o.now) - RECENT_MS).toISOString(), cutoff(o.now, o.days ?? CHUNK_DAYS)) as { id: number }[];
  let n = 0;
  for (const r of rows) {
    const s = db.query("SELECT transcript, chunked_size FROM sessions WHERE id = ?").get(r.id) as SessionRow;
    if (s.chunked_size != null && s.chunked_size >= 0 && existsSync(s.transcript!) && statSync(s.transcript!).size === s.chunked_size) continue;
    if (indexSession(db, r.id) === "indexed") n++;
  }
  return n;
}

// Chunks of tickets merged or closed more than `days` ago. The journal is kept forever.
export function pruneChunks(db: Database, o: { now: string; days?: number }) {
  const before = db.query("SELECT COUNT(*) AS n FROM transcript_chunks").get() as { n: number };
  db.query(`DELETE FROM transcript_chunks WHERE ticket IN (${settledSql})`).run(cutoff(o.now, o.days ?? CHUNK_DAYS));
  return before.n - (db.query("SELECT COUNT(*) AS n FROM transcript_chunks").get() as { n: number }).n;
}

export type Hit = { ticket: number; source: "journal" | "transcript"; kind: string; snippet: string; ref: string | null; at: string | null; rank: number };

// The journal and the transcript chunks searched together (words OR'd, as `factory journal
// --search` does), best bm25 first; one ticket's, or every ticket's.
export function recallHits(db: Database, o: { query: string; ticket?: number; limit?: number }): Hit[] {
  const q = ftsQuery(o.query);
  if (!q) return [];
  const limit = o.limit ?? 20;
  const one = o.ticket != null;
  const args = one ? [q, o.ticket!, limit] : [q, limit];
  const journal = db.query(`SELECT e.ticket, 'journal' AS source, e.kind, snippet(ticket_events_fts, 0, '[', ']', '…', 16) AS snippet,
      e.ref, e.at, bm25(ticket_events_fts) AS rank FROM ticket_events_fts JOIN ticket_events e ON e.id = ticket_events_fts.rowid
    WHERE ticket_events_fts MATCH ?${one ? " AND e.ticket = ?" : ""} ORDER BY rank, e.id LIMIT ?`).all(...args) as Hit[];
  const chunks = db.query(`SELECT c.ticket, 'transcript' AS source, c.role AS kind, snippet(transcript_chunks_fts, 0, '[', ']', '…', 16) AS snippet,
      'transcript:' || s.transcript || '#L' || c.line AS ref, c.at, bm25(transcript_chunks_fts) AS rank
    FROM transcript_chunks_fts JOIN transcript_chunks c ON c.id = transcript_chunks_fts.rowid JOIN sessions s ON s.id = c.session
    WHERE transcript_chunks_fts MATCH ?${one ? " AND c.ticket = ?" : ""} ORDER BY rank, c.id LIMIT ?`).all(...args) as Hit[];
  return [...journal, ...chunks].sort((a, b) => a.rank - b.rank).slice(0, limit);
}

export const hitLine = (h: Hit) =>
  `#${h.ticket}  ${h.kind.padEnd(13)} ${h.snippet.replace(/\s+/g, " ")}${h.ref ? `  [${h.ref}]` : ""}`;
