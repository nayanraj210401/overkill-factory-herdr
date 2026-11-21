// Token recording. Claude Code writes every session's usage to
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<its cwd, non-alphanumerics as ->/*.jsonl
// (sub-agents in <session>/subagents/). Each ticket has its own worktree, so its
// agents' transcripts sit in their own folder: read them, one row per message.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// $ per million tokens (claude-api reference, checked 2026-11-21). Cache writes are
// 1.25x input (5-minute TTL) and 2x (1-hour). Haiku 5.5's cache-read rate isn't
// listed there; it uses the usual 0.1x. A model not here costs 0 and is logged.
export const PRICES: Record<string, { input: number; output: number; read: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, read: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, read: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, read: 0.01 },
};

export type Use = { id: string; at: string; model: string; input: number; w5m: number; w1h: number; read: number; output: number };

export const transcriptDir = (cwd: string) =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"));

export function usd(u: Use) {
  const p = PRICES[u.model.replace(/-\d{8}$/, "")];
  if (!p) return 0;
  return (u.input * p.input + u.w5m * p.input * 1.25 + u.w1h * p.input * 2 + u.read * p.read + u.output * p.output) / 1e6;
}

// One entry per message: Claude Code repeats a message's usage on each of its content
// blocks, and the last copy is final.
export function parseTranscript(text: string): Use[] {
  const byId = new Map<string, Use>();
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a line still being written
    const m = e.message;
    if (e.type !== "assistant" || !m?.id || !m.usage || m.model === "<synthetic>") continue;
    const u = m.usage;
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    byId.set(m.id, {
      id: m.id, at: e.timestamp, model: m.model, input: u.input_tokens ?? 0,
      // Old records have only the total: count it as 5-minute writes.
      w5m: w5m + w1h === 0 ? (u.cache_creation_input_tokens ?? 0) : w5m, w1h,
      read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0,
    });
  }
  return [...byId.values()];
}

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? jsonl(join(dir, d.name)) : d.name.endsWith(".jsonl") ? [join(dir, d.name)] : []);
}

// The daemon rescans every tick; a transcript that hasn't changed isn't read again.
const seen = new Map<string, string>();

// Records new usage for every ticket with a worktree, then its totals. Idempotent:
// rows are keyed by message id, so a rescan updates rather than double counts.
export function recordUsage(db: Database, log: (s: string) => void = () => {}) {
  const tickets = db.query("SELECT id, worktree FROM tickets WHERE worktree IS NOT NULL").all() as { id: number; worktree: string }[];
  const put = db.query(`INSERT INTO usage (message_id, ticket, session, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
    output = excluded.output, input = excluded.input, cache_write_5m = excluded.cache_write_5m,
    cache_write_1h = excluded.cache_write_1h, cache_read = excluded.cache_read, usd = excluded.usd`);
  // The stage session a message belongs to: the latest one started before it.
  const sessionAt = db.query("SELECT id FROM sessions WHERE ticket = ? AND started_at <= ? ORDER BY started_at DESC, id DESC LIMIT 1");
  const unpriced = new Set<string>();
  for (const t of tickets) {
    let changed = false;
    // Claude names the folder after its cwd as it sees it, which may be the real path.
    const real = existsSync(t.worktree) ? realpathSync(t.worktree) : t.worktree;
    for (const file of [...new Set([t.worktree, real])].flatMap((w) => jsonl(transcriptDir(w)))) {
      const st = statSync(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (seen.get(file) === stamp) continue;
      seen.set(file, stamp);
      changed = true;
      for (const u of parseTranscript(readFileSync(file, "utf8"))) {
        if (!PRICES[u.model.replace(/-\d{8}$/, "")]) unpriced.add(u.model);
        const s = sessionAt.get(t.id, u.at) as { id: number } | null;
        put.run(u.id, t.id, s?.id ?? null, u.at, u.model, u.input, u.w5m, u.w1h, u.read, u.output, usd(u));
      }
    }
    if (changed) totals(db, t.id);
  }
  for (const m of unpriced) log(`factory: no price for ${m}; its usage counts as $0`);
}

// "Tokens in" is what the budget limits: fresh input plus cache writes. Cache reads
// are the session re-reading its own context; they count in dollars only.
function totals(db: Database, id: number) {
  const sum = "SUM(input + cache_write_5m + cache_write_1h) AS i, SUM(output) AS o";
  for (const s of db.query(`SELECT session, ${sum} FROM usage WHERE ticket = ? AND session IS NOT NULL GROUP BY session`).all(id) as any[])
    db.query("UPDATE sessions SET tokens_in = ?, tokens_out = ? WHERE id = ?").run(s.i, s.o, s.session);
  const t = db.query(`SELECT ${sum}, SUM(usd) AS usd FROM usage WHERE ticket = ?`).get(id) as any;
  db.query("UPDATE tickets SET tokens_in = ?, tokens_out = ?, usd = ? WHERE id = ?").run(t.i ?? 0, t.o ?? 0, t.usd ?? 0, id);
}
