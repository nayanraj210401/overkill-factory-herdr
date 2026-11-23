// Agent memory (plan: Peer review → Agent memory). Lessons are rules the learner distilled;
// this is the dataset under them: one row per thing an agent did (a verdict, a stage's output,
// a review comment), what it saw and what it wrote, and the outcome once one is known. A brief
// pulls the closest rows, good and bad, as examples; the learner mines them for lessons.
import type { Database } from "bun:sqlite";

export const MAX_TEXT = 4000; // characters kept of a row's input and of its output
export const MEMORY_CAP = 5000; // rows kept per agent and repo (upkeep drops the rest)
export const BRIEF_ROWS = 5;
export const BRIEF_BYTES = 1500;

export type Memory = {
  id: number; agent: string; repo: string; kind: string; ticket: number | null; pr: number | null; ref: string | null;
  input: string; output: string; outcome: string | null; outcome_at: string | null; outcome_source: string | null; tokens: number | null; at: string;
};
export type NewMemory = { agent: string; repo: string; kind: string; ticket?: number | null; pr?: number | null; ref?: string | null; input?: string; output?: string; tokens?: number | null; at: string; outcome?: string | null; outcome_source?: string | null };

// Outcomes that say the work held up; any other outcome counts as a bad example.
const GOOD = new Set(["kept", "accepted", "merged", "agreed", "pass", "passed"]);
export const isGood = (outcome: string) => GOOD.has(outcome);

const cap = (s: string | undefined) => {
  const t = (s ?? "").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

export function remember(db: Database, m: NewMemory): number {
  if (!m.agent.trim() || !m.repo.trim() || !m.kind.trim()) throw new Error("a memory needs its agent, repo and kind");
  const r = db.query(`INSERT INTO memories (agent, repo, kind, ticket, pr, ref, input, output, outcome, outcome_at, outcome_source, tokens, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    m.agent.trim(), m.repo.trim(), m.kind.trim(), m.ticket ?? null, m.pr ?? null, m.ref ?? null, cap(m.input), cap(m.output),
    m.outcome ?? null, m.outcome ? m.at : null, m.outcome ? m.outcome_source ?? m.agent : null, m.tokens ?? null, m.at);
  return Number(r.lastInsertRowid);
}

export function setOutcome(db: Database, id: number, outcome: string, source: string, now: string) {
  if (!outcome.trim()) throw new Error("say the outcome: kept, edited, deleted, accepted, pushed-back, missed, merged, reverted, …");
  const r = db.query("UPDATE memories SET outcome = ?, outcome_source = ?, outcome_at = ? WHERE id = ?").run(outcome.trim(), source, now, id);
  if (r.changes === 0) throw new Error(`no memory ${id}`);
}

// Words of three letters or more, quoted, OR'd: the closest rows by bm25, not only rows with every word.
const ftsQuery = (q: string) => [...new Set(q.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].slice(0, 16).map((w) => `"${w}"`).join(" OR ");

export type Recall = { agent?: string | null; repo?: string | null; query?: string; limit?: number; kinds?: string[]; open?: number };

// The closest rows for an agent in a repo: rows with an outcome first, the best-ranked good one
// and the best-ranked bad one always among them when there are both, then at most `open` rows
// (default 1) whose outcome isn't known yet. No query: the newest rows.
export function recall(db: Database, o: Recall): Memory[] {
  const limit = Math.max(1, o.limit ?? BRIEF_ROWS);
  const where: string[] = [], args: (string | number)[] = [];
  if (o.agent) { where.push("m.agent = ?"); args.push(o.agent); }
  if (o.repo) { where.push("m.repo = ?"); args.push(o.repo); }
  if (o.kinds?.length) { where.push(`m.kind IN (${o.kinds.map(() => "?").join(", ")})`); args.push(...o.kinds); }
  const q = o.query ? ftsQuery(o.query) : "";
  if (o.query && !q) return []; // words too short to search for
  const pool = limit * 20;
  const rows = (q
    ? db.query(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ?${where.length ? ` AND ${where.join(" AND ")}` : ""} ORDER BY bm25(memories_fts), m.id DESC LIMIT ?`).all(q, ...args, pool)
    : db.query(`SELECT m.* FROM memories m${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY m.at DESC, m.id DESC LIMIT ?`).all(...args, pool)) as Memory[];
  const known = rows.filter((r) => r.outcome);
  const firstGood = known.find((r) => isGood(r.outcome!)), firstBad = known.find((r) => !isGood(r.outcome!));
  const picked = new Set<Memory>([firstGood, firstBad].filter((r): r is Memory => !!r).slice(0, limit));
  for (const r of known) { if (picked.size >= limit) break; picked.add(r); }
  const withOutcome = known.filter((r) => picked.has(r)); // back in rank order
  const open = rows.filter((r) => !r.outcome).slice(0, Math.min(o.open ?? 1, limit - withOutcome.length));
  return [...withOutcome, ...open];
}

// Newest first, whatever the outcome.
export function listMemories(db: Database, o: { agent?: string | null; repo?: string | null; kinds?: string[]; limit?: number }): Memory[] {
  const where: string[] = [], args: (string | number)[] = [];
  if (o.agent) { where.push("agent = ?"); args.push(o.agent); }
  if (o.repo) { where.push("repo = ?"); args.push(o.repo); }
  if (o.kinds?.length) { where.push(`kind IN (${o.kinds.map(() => "?").join(", ")})`); args.push(...o.kinds); }
  return db.query(`SELECT * FROM memories${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, o.limit ?? 20) as Memory[];
}

const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// One row as a brief line: its outcome, kind and ticket, what it saw and what it wrote.
export const memoryLine = (m: Memory) =>
  `- [${m.outcome ?? "no outcome yet"}] ${m.kind}${m.ticket != null ? ` #${m.ticket}` : ""}${m.ref ? ` ${m.ref}` : ""}: ${oneLine(m.input, 110)} → ${oneLine(m.output, 110)}`;

// The brief's "From your memory" lines: a few rows, bounded in bytes; "" when there are none.
export function memoryBlock(db: Database, o: { agent: string; repo: string; query: string }): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const m of recall(db, { agent: o.agent, repo: o.repo, query: o.query, limit: BRIEF_ROWS })) {
    const l = memoryLine(m);
    const n = Buffer.byteLength(l) + 1;
    if (bytes + n > BRIEF_BYTES) break;
    lines.push(l); bytes += n;
  }
  return lines.join("\n");
}

// Outcomes the daemon already knows, filled in (idempotent, run on the daemon's tick):
// - stage-output: merged, or reverted once a revert of the PR is found, or closed (dropped).
// - babysitter-verdict: agreed or overruled, against your verdict on the comment as the
//   agreement benchmark reads it (your label, else the verdict kept at merge unless the
//   babysitter applied it itself).
export function settleMemories(db: Database, now: string): number {
  let n = 0;
  const stages = db.query(`SELECT m.id, m.outcome, CASE WHEN t.reverted_by IS NOT NULL THEN 'reverted' WHEN t.state = 'merged' THEN 'merged' WHEN t.state = 'closed' THEN 'closed' END AS got
    FROM memories m JOIN tickets t ON t.id = m.ticket
    WHERE m.kind = 'stage-output' AND (m.outcome IS NULL OR m.outcome = 'merged') AND (t.state IN ('merged', 'closed'))`).all() as { id: number; outcome: string | null; got: string | null }[];
  const set = db.query("UPDATE memories SET outcome = ?, outcome_source = ?, outcome_at = ? WHERE id = ?");
  for (const s of stages) if (s.got && s.got !== s.outcome) { set.run(s.got, s.got === "reverted" ? "revert" : "ticket", now, s.id); n++; }
  const verdicts = db.query(`SELECT m.id, m.output, m.outcome, m.outcome_source,
      CASE WHEN c.label IS NOT NULL THEN c.label WHEN c.verdict IS NOT NULL AND t.state = 'merged' AND COALESCE(c.reason, '') NOT LIKE 'auto:%' THEN c.verdict END AS yours,
      CASE WHEN c.label IS NOT NULL THEN 'label' ELSE 'kept' END AS src
    FROM memories m JOIN comments c ON c.ticket = m.ticket AND m.ref = 'C' || c.n JOIN tickets t ON t.id = m.ticket
    WHERE m.kind = 'babysitter-verdict' AND c.insisted = 0`).all() as { id: number; output: string; outcome: string | null; outcome_source: string | null; yours: string | null; src: string }[];
  for (const v of verdicts) {
    if (!v.yours) continue;
    const said = v.output.match(/^[a-z]+/)?.[0];
    const got = said === v.yours ? "agreed" : "overruled";
    if (got !== v.outcome || v.src !== v.outcome_source) { set.run(got, v.src, now, v.id); n++; }
  }
  return n;
}

// Daily upkeep: each agent and repo keeps its newest `cap` rows; the oldest without an outcome
// go first, then the oldest with one.
export function pruneMemories(db: Database, cap = MEMORY_CAP): number {
  let n = 0;
  const over = db.query("SELECT agent, repo, COUNT(*) AS n FROM memories GROUP BY agent, repo HAVING COUNT(*) > ?").all(cap) as { agent: string; repo: string; n: number }[];
  for (const o of over) {
    db.query(`DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE agent = ? AND repo = ? ORDER BY outcome IS NOT NULL, at, id LIMIT ?)`).run(o.agent, o.repo, o.n - cap);
    n += o.n - cap; // .changes would count the search index's trigger rows too
  }
  return n;
}
