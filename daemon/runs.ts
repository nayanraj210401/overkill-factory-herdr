// runs.json, beside status.json: every agent session the factory started, newest
// first, for the Tickets page's Runs view. A benchmark run (bench_runs) joins them as
// kind benchmark, with no ticket and a negative id so it never matches a session's.
// Maintenance runs aren't recorded yet; the file's contract already has room for them.
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { existsSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRuns } from "../lib/runs.js";
import { transcriptDir } from "./usage.ts";

export const RUNS_CAP = 200;

type Row = { id: number; ticket: number; title: string | null; stage: string; argv: string; started_at: string; ended_at: string | null;
  tokens_in: number; tokens_out: number; cwd: string | null; usd: number | null; used_model: string | null };
type Files = Map<string, { path: string; born: number }[]>;

// Claude Code names each session's file by a new id, created when the session starts:
// a session's transcript is the first file born in its folder from then until the next
// session there began. Another harness keeps its transcripts elsewhere: none here.
function transcriptOf(r: Row, harness: string, nextStart: string | undefined, files: Files) {
  if (harness !== "claude" || !r.cwd) return null;
  const from = Date.parse(r.started_at) - 5000;
  const to = nextStart ? Date.parse(nextStart) - 5000 : Infinity;
  // Claude names the folder after its cwd as it sees it, which may be the real path.
  const dirs = [...new Set([r.cwd, existsSync(r.cwd) ? realpathSync(r.cwd) : r.cwd].map(transcriptDir))];
  const hits = dirs.flatMap((d) => {
    if (!files.has(d)) files.set(d, existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(".jsonl")).map((n) => ({ path: join(d, n), born: statSync(join(d, n)).birthtimeMs })) : []);
    return files.get(d)!;
  }).filter((f) => f.born >= from && f.born < to).sort((a, b) => a.born - b.born);
  return hits[0]?.path ?? null;
}

export function buildRuns(db: Database, now = new Date()) {
  const rows = db.query(`SELECT s.id, s.ticket, t.title, s.stage, s.argv, s.started_at, s.ended_at, s.tokens_in, s.tokens_out, s.cwd,
      (SELECT SUM(usd) FROM usage u WHERE u.session = s.id) AS usd,
      (SELECT model FROM usage u WHERE u.session = s.id GROUP BY model ORDER BY SUM(output) DESC LIMIT 1) AS used_model
    FROM sessions s JOIN tickets t ON t.id = s.ticket ORDER BY s.started_at DESC, s.id DESC LIMIT ?`).all(RUNS_CAP) as Row[];
  const files: Files = new Map();
  const runs = rows.map((r) => {
    const argv = JSON.parse(r.argv) as string[];
    const harness = argv[0] ?? "unknown";
    const flag = argv.indexOf("--model");
    // Rows are newest first: the last one above this in the same folder started next.
    const next = rows.slice(0, rows.indexOf(r)).filter((o) => o.cwd === r.cwd).at(-1);
    return {
      id: r.id, ticket: r.ticket, title: r.title ?? "",
      kind: r.stage === "groom" ? "grooming" : r.stage === "cloud" ? "cloud" : "stage",
      stage: r.stage, harness, model: r.used_model ?? (flag >= 0 ? argv[flag + 1] ?? null : null),
      started_at: r.started_at, ended_at: r.ended_at,
      duration_s: r.ended_at ? Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000) : null,
      tokens_in: r.tokens_in, tokens_out: r.tokens_out, usd: r.usd == null ? null : +r.usd.toFixed(4),
      transcript: transcriptOf(r, harness, next?.started_at, files),
    };
  });
  const bench = (db.query(`SELECT r.*, b.suite, b.target FROM bench_runs r JOIN bench_batches b ON b.id = r.batch WHERE r.status != 'skipped' ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).all(RUNS_CAP) as any[]).map((r) => ({
    id: -r.id, ticket: null, title: `${r.suite} · #${r.task} · ${r.variant}`, kind: "benchmark", stage: r.target, harness: r.harness ?? "unknown", model: r.model,
    started_at: r.started_at, ended_at: r.ended_at,
    duration_s: r.ended_at ? Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000) : null,
    tokens_in: r.tokens_in, tokens_out: r.tokens_out, usd: +r.usd.toFixed(4), transcript: r.transcript,
  }));
  const all = [...runs, ...bench].sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : b.id - a.id)).slice(0, RUNS_CAP);
  return { generated_at: now.toISOString(), runs: all };
}

export function writeRuns(db: Database, path: string, now = new Date()) {
  const doc = buildRuns(db, now);
  const errors = validateRuns(doc);
  if (errors.length) throw new Error(`runs.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(path, JSON.stringify(doc) + "\n");
  return doc;
}
