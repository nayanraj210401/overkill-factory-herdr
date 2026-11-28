// Ticket memory, layer 3 (plan: Ticket memory): each ticket's digest. After a session ends or
// hands off, Haiku rewrites it from the digest before, the journal events since (journal.ts) and
// the new transcript chunks (recall.ts), all redacted. It is kept on the ticket, written to
// TICKET-MEMORY.md in each worktree (which stays local, like .factory/), and goes in every brief.
// It runs on the daemon's tick, never inside the code that ends a session: a failed or held call
// costs the ticket nothing but a `digest-failed` event, and the next end tries again.
import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journal } from "./journal.ts";
import { redact, TEXT_CAP, trim } from "./recall.ts";
import { MODELS } from "./models.ts";
import { startHold } from "./budget.ts";
import { fullWindows } from "./planlimit.ts";
import { planFile, readPlan } from "./planline.ts";
import { totals, usd } from "./usage.ts";
import { ticketRepos } from "./db.ts";
import { excludeLocal } from "./local.ts";
import type { Run } from "./runner.ts";

export const MODEL = MODELS.haiku;
export const DIGEST_TOKENS = 1500; // what the model is told to stay under
export const DIGEST_CAP = 8000; // characters kept (about 2000 tokens); past it the digest is cut
export const EVENTS_CAP = 30_000; // characters of journal events in one prompt
export const CHUNKS_CAP = 60_000; // and of transcript chunks
export const FILE = "TICKET-MEMORY.md";
const RECENT_MS = 2 * 86_400_000; // an end older than this doesn't start a digest (no backfill of old tickets)
const ENDS = ["session-end", "handoff"];
const OWN = ["digest", "digest-failed", "digest-edit"]; // the digest's own events aren't its input
// A chunk's share of the prompt: the person's words first, then what the agent said, then its tools.
const PER_ROLE: Record<string, { cap: number; rank: number }> = { user: { cap: 3000, rank: 0 }, assistant: { cap: 1500, rank: 1 }, tool: { cap: 600, rank: 2 } };

export const SECTIONS = ["Decisions and why", "The person's answers", "Tried and failed", "Open questions", "Current state"];

// `edited`: when the person last saved this digest by hand (setDigest), else null.
export type Digest = { text: string; at: string; event: number | null; from: number; edited: string | null };

// The ticket's digest, else the one it starts from: its parent's (a re-request or a split's part), up the chain.
export function digestOf(db: Database, id: number): Digest | null {
  const seen = new Set<number>();
  for (let at: number | null = id; at != null && !seen.has(at); ) {
    seen.add(at);
    const t = db.query("SELECT digest, digest_at, digest_event, digest_edited_at, parent FROM tickets WHERE id = ?").get(at) as { digest: string | null; digest_at: string | null; digest_event: number | null; digest_edited_at: string | null; parent: number | null } | null;
    if (!t) return null;
    if (t.digest) return { text: t.digest, at: t.digest_at ?? "", event: at === id ? t.digest_event : null, from: at, edited: t.digest_edited_at };
    at = t.parent;
  }
  return null;
}

// The digest as the person last saved it by hand, which every later rewrite keeps. Its own ticket's only.
export function userDigest(db: Database, id: number): { text: string; at: string } | null {
  const t = db.query("SELECT digest_user, digest_edited_at FROM tickets WHERE id = ?").get(id) as { digest_user: string | null; digest_edited_at: string | null } | null;
  return t?.digest_user ? { text: t.digest_user, at: t.digest_edited_at ?? "" } : null;
}

// What every brief carries: the digest and where to look for more. "" when there is none.
export function digestBlock(db: Database, id: number) {
  const d = digestOf(db, id);
  if (!d) return "";
  const head = d.from === id
    ? `#${id}'s memory so far, which the factory rewrites from its journal and transcripts after each session (${FILE} in the worktree has the newest). For detail run \`factory recall ${id} "words"\`.`
    : `#${id} carries on from #${d.from}. This is #${d.from}'s memory; #${id}'s own replaces it after its first session. For detail run \`factory recall ${d.from} "words"\` for #${d.from}'s history, or \`factory recall ${id} "words"\` for this ticket's.`;
  return `${head}\n\n${d.text.trim()}`;
}

// The tickets whose digest is due: a session ended or handed off since the digest was last
// written, and since its last failure (a failure waits for the next end), in the last two days.
export function digestsDue(db: Database, now: string): number[] {
  const since = new Date(Date.parse(now) - RECENT_MS).toISOString();
  const rows = db.query(`SELECT t.id, MAX(e.id) AS last FROM tickets t JOIN ticket_events e ON e.ticket = t.id
      WHERE e.kind IN (${ENDS.map(() => "?").join(", ")}) AND e.at >= ? AND e.id > COALESCE(t.digest_event, 0)
        AND e.id > COALESCE((SELECT MAX(f.id) FROM ticket_events f WHERE f.ticket = t.id AND f.kind = 'digest-failed'), 0)
      GROUP BY t.id ORDER BY last`).all(...ENDS, since) as { id: number }[];
  return rows.map((r) => r.id);
}

type ChunkRow = { id: number; session: number; role: string; text: string; argv: string };

// Each session's brief is its first user turn: it holds the digest already, so it isn't input.
const isBrief = (c: ChunkRow) => {
  if (c.role !== "user") return false;
  try { return trim(redact(String(JSON.parse(c.argv).at(-1) ?? "")), TEXT_CAP) === c.text; } catch { return false; }
};

// The newest that fit in `cap`, by rank (lower first), back in their order.
function fit<T extends { id: number; text: string }>(rows: T[], cap: number, rank: (r: T) => number) {
  const keep = new Set<number>();
  let used = 0;
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b) || b.id - a.id)) {
    if (used + r.text.length > cap) continue;
    keep.add(r.id);
    used += r.text.length;
  }
  return { kept: rows.filter((r) => keep.has(r.id)), dropped: rows.length - keep.size };
}

// `edited`: the person's own version (setDigest), which the rewrite must keep; a rebuild keeps it too.
export type Input = { id: number; title: string; previous: Digest | null; edited: { text: string; at: string } | null; events: string[]; chunks: string[]; dropped: number; event: number; chunk: number };

// What the next digest is written from. `rebuild`: the whole journal and every chunk, from the parent's digest (if any).
export function digestInput(db: Database, id: number, o: { rebuild?: boolean } = {}): Input {
  const t = db.query("SELECT title, digest_event, digest_chunk FROM tickets WHERE id = ?").get(id) as { title: string; digest_event: number | null; digest_chunk: number | null } | null;
  if (!t) throw new Error(`no ticket ${id}`);
  const fromEvent = o.rebuild ? 0 : t.digest_event ?? 0, fromChunk = o.rebuild ? 0 : t.digest_chunk ?? 0;
  const previous = o.rebuild ? (() => { const p = (db.query("SELECT parent FROM tickets WHERE id = ?").get(id) as { parent: number | null }).parent; return p != null ? digestOf(db, p) : null; })() : digestOf(db, id);
  const evs = db.query(`SELECT id, kind, text, at FROM ticket_events WHERE ticket = ? AND id > ? AND kind NOT IN (${OWN.map(() => "?").join(", ")}) ORDER BY id`)
    .all(id, fromEvent, ...OWN) as { id: number; kind: string; text: string; at: string }[];
  const events = fit(evs.map((e) => ({ id: e.id, text: `${e.at.slice(0, 16).replace("T", " ")} ${e.kind}: ${redact(e.text.replace(/\s+/g, " "))}` })), EVENTS_CAP, () => 0);
  const rows = (db.query(`SELECT c.id, c.session, c.role, c.text, s.argv FROM transcript_chunks c JOIN sessions s ON s.id = c.session
      WHERE c.ticket = ? AND c.id > ? ORDER BY c.id`).all(id, fromChunk) as ChunkRow[]).filter((c) => !isBrief(c));
  const chunks = fit(rows.map((c) => ({ id: c.id, role: c.role, text: `[${c.role}] ${trim(redact(c.text), PER_ROLE[c.role]?.cap ?? 600)}` })), CHUNKS_CAP, (c) => PER_ROLE[c.role]?.rank ?? 2);
  const maxOf = (sql: string) => (db.query(sql).get(id) as { m: number | null }).m ?? 0;
  return {
    id, title: t.title, previous, edited: userDigest(db, id),
    events: events.kept.map((e) => e.text), chunks: chunks.kept.map((c) => c.text), dropped: events.dropped + chunks.dropped,
    event: Math.max(fromEvent, maxOf("SELECT MAX(id) AS m FROM ticket_events WHERE ticket = ?")),
    chunk: Math.max(fromChunk, maxOf("SELECT MAX(id) AS m FROM transcript_chunks WHERE ticket = ?")),
  };
}

// What the prompt says about the person's own edit: their version wins over everything below it.
export const EDITED_RULE = "The person edited this digest by hand. Their version (\"# The person's edited digest\" below) is authoritative: keep every correction they made, in their words, and never put back a fact, bullet or line they removed, even if the journal, the transcripts or the digest before still say it. Change their text only to add what happened after their edit, or where something newer below plainly supersedes it.";

// The prompt: the rules and the cap, then the digest before, the person's edit, the events and the
// excerpts. Every part is redacted again here, so nothing reaches the model that the index wouldn't keep.
export function digestPrompt(i: Input) {
  const prev = i.previous ? redact(i.previous.text) : "";
  const same = i.edited != null && i.previous != null && i.previous.from === i.id && i.edited.text.trim() === i.previous.text.trim();
  const edited = i.edited ? `# The person's edited digest (saved ${i.edited.at.slice(0, 16).replace("T", " ")}; authoritative)\n\n${redact(i.edited.text)}` : null;
  return [
    `You keep the memory of ticket #${i.id}: ${i.title}. The agents that work on it read this digest at the start of every session, so it must say what a newcomer needs and nothing else.`,
    `Rewrite the digest so it is true after what happened since it was written. Keep what still matters from it, drop what is superseded, and add what is new.`,
    `Stay under ${DIGEST_TOKENS} tokens (about ${DIGEST_TOKENS * 4} characters); the factory cuts anything past ${DIGEST_CAP} characters.`,
    `Use exactly these headings, in this order, each with short bullets, or "- none":`,
    ...SECTIONS.map((s) => `## ${s}`),
    `Under "The person's answers", quote each of the person's answers verbatim, in quotation marks, with the question it answered. Never paraphrase them, and keep every one the digest before quoted unless the person changed it.`,
    `Under "Tried and failed", say what was tried, how it failed, and why, so no one tries it again.`,
    `Text marked [redacted: …] was a secret: keep the marker and never guess what it was.`,
    ...(i.edited ? [EDITED_RULE] : []),
    `Answer with the digest only, starting at its first heading.`,
    "",
    same ? `# The digest before\n\nIt is the person's edited digest, below.` : i.previous ? `# The digest before${i.previous.from !== i.id ? ` (#${i.previous.from}'s: this ticket carries on from it)` : ""}\n\n${prev}` : "# The digest before\n\nNone yet: this is the first.",
    ...(edited ? ["", edited] : []),
    "",
    `# Journal events since\n\n${i.events.join("\n") || "none"}`,
    "",
    `# Transcript excerpts since (redacted; the person's words are [user])\n\n${i.chunks.join("\n\n") || "none"}${i.dropped ? `\n\n(${i.dropped} older or lesser excerpts and events left out for room.)` : ""}`,
  ].join("\n");
}

// The model's answer, from its first heading, cut at the cap; null when no heading is there.
export function parseDigest(out: string) {
  const at = out.search(/^##[ \t]/m);
  if (at < 0) return null;
  const text = out.slice(at).trim();
  const named = SECTIONS.filter((s) => text.toLowerCase().includes(`## ${s.toLowerCase()}`)).length;
  if (named < 3) return null;
  if (text.length <= DIGEST_CAP) return text;
  const cut = text.slice(0, DIGEST_CAP);
  return `${cut.slice(0, Math.max(cut.lastIndexOf("\n"), DIGEST_CAP / 2)).trimEnd()}\n\n(cut at the digest's cap of ${DIGEST_CAP} characters)`;
}

type Answer = { text: string; input: number; w5m: number; read: number; output: number; usd: number | null };

// claude -p --output-format json: the answer and what it cost. Anything else is a failure.
function ask(run: Run, prompt: string, cwd?: string): Answer {
  const r = run(["claude", "-p", "--model", MODEL, "--output-format", "json", prompt], cwd);
  let j: any = null;
  try { j = JSON.parse(r.out); } catch {}
  if (r.code !== 0 || !j || typeof j.result !== "string" || j.is_error === true)
    throw new Error(`exit ${r.code}: ${String(j?.result ?? r.out).split("\n")[0].slice(0, 160)}`);
  const u = j.usage ?? {};
  return { text: j.result, input: u.input_tokens ?? 0, w5m: u.cache_creation_input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null };
}

// Why no digest call goes out now: the day's budgets and plan.pause_at (budget.ts startHold),
// and a plan window at its limit (planlimit.ts). null when it may.
export function digestHold(db: Database, repo: string, now: string) {
  const held = startHold(db, repo, new Date(now));
  if (held) return held;
  const full = fullWindows(readPlan(planFile()), new Date(now));
  return full.length ? `the ${full[0] === "five_hour" ? "5-hour" : "weekly"} plan window is at its limit` : null;
}

// TICKET-MEMORY.md in each of the ticket's worktrees, beside the code. Only where the repo's
// exclude file keeps it out of git (local.ts): it never reaches a commit or a PR.
export function writeMemoryFile(db: Database, id: number) {
  const d = digestOf(db, id);
  if (!d) return [];
  const t = db.query("SELECT title FROM tickets WHERE id = ?").get(id) as { title: string };
  const text = `# Ticket memory: #${id} ${t.title}\n\nThe factory rewrites this file after each session (${MODEL}${d.at ? `, last at ${d.at.slice(0, 16).replace("T", " ")}` : ""}${d.from !== id ? `; carried on from #${d.from}` : ""}${d.edited && d.from === id ? `; the person's edits of ${d.edited.slice(0, 16).replace("T", " ")} are kept` : ""}). Don't edit this file: fix the digest on the Ticket page's Memory tab, or with \`factory digest ${id} --set <file>\`. For detail run \`factory recall ${id} "words"\`.\n\n${d.text.trim()}\n`;
  const wrote: string[] = [];
  for (const r of ticketRepos(db, id)) {
    if (!r.worktree || !existsSync(r.worktree) || !excludeLocal(r.path)) continue;
    writeFileSync(join(r.worktree, FILE), text);
    wrote.push(join(r.worktree, FILE));
  }
  return wrote;
}

// The person's own digest (the Ticket page's Memory tab, `factory digest <id> --set`): stored as the
// digest and as their version, which every later rewrite keeps (digestPrompt), journaled as
// `digest-edit`, and written to TICKET-MEMORY.md. It covers no new events, so digest_event stays.
export function setDigest(db: Database, o: { id: number; text: string; now: string; commit?: (fn: () => void) => void }) {
  const text = o.text.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("the digest is empty: write what the agents should know, or rebuild it (--rebuild)");
  if (text.length > DIGEST_CAP) throw new Error(`the digest is ${text.length} characters; it may have at most ${DIGEST_CAP}`);
  if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(o.id)) throw new Error(`no ticket ${o.id}`);
  const before = digestOf(db, o.id);
  (o.commit ?? ((fn) => db.transaction(fn)()))(() => {
    db.query("UPDATE tickets SET digest = ?, digest_at = ?, digest_user = ?, digest_edited_at = ? WHERE id = ?").run(text, o.now, text, o.now, o.id);
    const was = !before ? "it had none" : before.from !== o.id ? `it carried #${before.from}'s` : `it had ${before.text.length}`;
    journal(db, { ticket: o.id, kind: "digest-edit", text: `you edited the digest (${text.length} characters; ${was}); later rewrites keep your corrections`, ref: `file:${FILE}`, at: o.now });
  });
  return { chars: text.length, files: writeMemoryFile(db, o.id) };
}

export type DigestResult ={ ok: true; chars: number; usd: number; tokens: number; files: string[] } | { ok: false; why: string; held?: boolean };

// One digest: read its input, ask Haiku (outside any transaction), then store it, its cost (a usage
// row, so the ticket's spend and the day's budget count it) and the file. A failure is journaled as
// `digest-failed` and logged; a hold (budget, plan limit) is neither, and the next tick looks again.
// `run` is the only way out to Claude: tests pass their own.
export function runDigest(db: Database, o: { id: number; repo: string; run: Run; now: string; cwd?: string; rebuild?: boolean; commit?: (fn: () => void) => void; log?: (s: string) => void }): DigestResult {
  const commit = o.commit ?? ((fn) => db.transaction(fn)());
  const held = digestHold(db, o.repo, o.now);
  if (held) return { ok: false, why: held, held: true };
  const input = digestInput(db, o.id, { rebuild: o.rebuild });
  let a: Answer | null = null, why: string | null = null, text: string | null = null;
  try {
    a = ask(o.run, digestPrompt(input), o.cwd);
    text = parseDigest(a.text);
    if (!text) why = "unreadable answer: none of the digest's headings";
  } catch (e) { why = (e as Error).message.slice(0, 200); }
  const cost = a ? a.usd ?? usd({ id: "", at: o.now, model: MODEL, input: a.input, w5m: a.w5m, w1h: 0, read: a.read, output: a.output }) : 0;
  commit(() => {
    if (a) {
      db.query(`INSERT OR REPLACE INTO usage (message_id, ticket, session, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?)`).run(`digest:${o.id}:${o.now}`, o.id, o.now, MODEL, a.input, a.w5m, a.read, a.output, cost);
      totals(db, o.id);
    }
    if (why || !text) {
      journal(db, { ticket: o.id, kind: "digest-failed", text: `the digest wasn't rewritten (${MODEL}): ${why}; the next session end tries again`, at: o.now });
      return;
    }
    db.query("UPDATE tickets SET digest = ?, digest_at = ?, digest_event = ?, digest_chunk = ? WHERE id = ?").run(text, o.now, input.event, input.chunk, o.id);
    journal(db, { ticket: o.id, kind: "digest", text: `digest ${o.rebuild ? "rebuilt" : "rewritten"} (${MODEL}, ${text.length} characters, $${cost.toFixed(4)})`, ref: `file:${FILE}`, at: o.now });
  });
  if (why || !text) {
    o.log?.(`factory: #${o.id}: the digest failed: ${why}`);
    return { ok: false, why: why! };
  }
  let files: string[] = [];
  try { files = writeMemoryFile(db, o.id); } catch (e) { o.log?.(`factory: #${o.id}: writing ${FILE}: ${(e as Error).message}`); }
  return { ok: true, chars: text.length, usd: cost, tokens: a!.input + a!.w5m + a!.output, files };
}

// The daemon's tick: the oldest due digest, one per tick, so a tick stays short.
export function runDueDigest(db: Database, o: { repo: string; run: Run; now: string; cwd?: string; commit?: (fn: () => void) => void; log?: (s: string) => void }) {
  const id = digestsDue(db, o.now)[0];
  if (id == null) return null;
  const r = runDigest(db, { ...o, id });
  if (r.ok) o.log?.(`factory: #${id}: digest rewritten (${r.chars} characters, $${r.usd.toFixed(4)})`);
  return { id, ...r };
}
