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

// Codex writes each session to <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl:
// a session_meta line (its id and cwd), turn_context lines (the model), and token_count
// events whose total_token_usage only grows. Each change in the total is one entry, so
// repeated events don't double count. Codex's input_tokens include the cached ones.
export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

export function parseCodex(text: string): { cwd: string | null; uses: Use[] } {
  let id = "";
  let cwd: string | null = null;
  let model = "codex";
  let prev = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let n = 0;
  const uses: Use[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"total_token_usage"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    if (e.type === "session_meta") { id = p.id ?? id; cwd = p.cwd ?? cwd; continue; }
    if (e.type === "turn_context") { model = p.model ?? model; cwd ??= p.cwd ?? null; continue; }
    const t = p.type === "token_count" ? p.info?.total_token_usage : null;
    if (!t || t.total_tokens === prev.total_tokens) continue;
    const d = (k: keyof typeof prev) => Math.max(0, (t[k] ?? 0) - prev[k]);
    uses.push({ id: `codex:${id}:${++n}`, at: e.timestamp, model, input: Math.max(0, d("input_tokens") - d("cached_input_tokens")), w5m: 0, w1h: 0, read: d("cached_input_tokens"), output: d("output_tokens") });
    prev = { input_tokens: t.input_tokens ?? 0, cached_input_tokens: t.cached_input_tokens ?? 0, output_tokens: t.output_tokens ?? 0, total_tokens: t.total_tokens };
  }
  return { cwd, uses };
}

// The day folders from a day before the first Codex session the factory started (its
// local date can trail the UTC one), so the rest of ~/.codex/sessions isn't walked.
function codexFiles(since: string) {
  const root = join(codexHome(), "sessions");
  const from = new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/");
  const days: string[] = [];
  for (const y of existsSync(root) ? readdirSync(root) : [])
    for (const m of readdirSync(join(root, y)))
      for (const d of readdirSync(join(root, y, m))) if (`${y}/${m}/${d}` >= from) days.push(join(root, y, m, d));
  return days.flatMap(jsonl);
}

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? jsonl(join(dir, d.name)) : d.name.endsWith(".jsonl") ? [join(dir, d.name)] : []);
}

// The daemon rescans every tick; a transcript that hasn't changed isn't read again.
const seen = new Map<string, string>();
const warned = new Set<string>();

// Records new usage for every folder a ticket's agents ran in (its worktree, and the
// ticket folder triage runs in), then its totals. Idempotent: rows are keyed by
// message id, so a rescan updates rather than double counts.
export function recordUsage(db: Database, log: (s: string) => void = () => {}) {
  const rows = db.query(`SELECT id, worktree AS dir FROM ticket_lead WHERE worktree IS NOT NULL
    UNION SELECT DISTINCT ticket, cwd FROM sessions WHERE cwd IS NOT NULL`).all() as { id: number; dir: string }[];
  const tickets = [...Map.groupBy(rows, (r) => r.id)].map(([id, rs]) => ({ id, dirs: rs.map((r) => r.dir) }));
  const put = db.query(`INSERT INTO usage (message_id, ticket, session, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
    output = excluded.output, input = excluded.input, cache_write_5m = excluded.cache_write_5m,
    cache_write_1h = excluded.cache_write_1h, cache_read = excluded.cache_read, usd = excluded.usd`);
  // The stage session a message belongs to: the latest one started before it.
  const sessionAt = db.query("SELECT id FROM sessions WHERE ticket = ? AND started_at <= ? ORDER BY started_at DESC, id DESC LIMIT 1");
  const unpriced = new Set<string>();
  const record = (ticket: number, u: Use) => {
    if (!PRICES[u.model.replace(/-\d{8}$/, "")]) unpriced.add(u.model);
    const s = sessionAt.get(ticket, u.at) as { id: number } | null;
    put.run(u.id, ticket, s?.id ?? null, u.at, u.model, u.input, u.w5m, u.w1h, u.read, u.output, usd(u));
  };
  const touched = new Set<number>();
  for (const t of tickets) {
    let changed = false;
    // Claude names the folder after its cwd as it sees it, which may be the real path.
    const dirs = t.dirs.flatMap((d) => [d, existsSync(d) ? realpathSync(d) : d]);
    for (const file of [...new Set(dirs)].flatMap((w) => jsonl(transcriptDir(w)))) {
      const st = statSync(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (seen.get(file) === stamp) continue;
      seen.set(file, stamp);
      changed = true;
      for (const u of parseTranscript(readFileSync(file, "utf8"))) record(t.id, u);
    }
    if (changed) touched.add(t.id);
  }
  // Codex sessions the factory started: matched to a ticket by the folder they ran in.
  const firstCodex = (db.query(`SELECT MIN(started_at) AS at FROM sessions WHERE argv LIKE '["codex"%'`).get() as { at: string | null }).at;
  if (firstCodex) {
    const owner = new Map(tickets.flatMap((t) => t.dirs.flatMap((d) => [d, existsSync(d) ? realpathSync(d) : d]).map((d) => [d, t.id] as const)));
    for (const file of codexFiles(firstCodex)) {
      const st = statSync(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (seen.get(file) === stamp) continue;
      seen.set(file, stamp);
      const { cwd, uses } = parseCodex(readFileSync(file, "utf8"));
      const ticket = cwd ? owner.get(cwd) : undefined;
      if (ticket == null) continue;
      for (const u of uses) record(ticket, u);
      touched.add(ticket);
    }
  }
  for (const id of touched) totals(db, id);
  // Once per model per daemon: a model with no price (Codex's, for one) would log every tick.
  for (const m of unpriced) if (!warned.has(m)) { warned.add(m); log(`factory: no price for ${m}; its usage counts as $0`); }
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
