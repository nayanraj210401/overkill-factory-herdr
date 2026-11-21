// Builds status.json (the contract in lib/status.js) from SQLite rows. The
// window reads only this file, so the daemon stays the one source of truth.
import type { Database } from "bun:sqlite";
import { renameSync, writeFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { getMeta } from "./db.ts";
import { interactionsBefore, planMeters, revertRate } from "./metrics.ts";
import { digest } from "./away.ts";

type Row = Record<string, any>;

const HEARTBEAT_MS = 15_000;

export function ticketOf(r: Row) {
  return {
    id: r.id, title: r.title, state: r.state, blueprint: r.blueprint,
    stage: r.stage, detail: r.detail, updated_at: r.updated_at,
    tokens: { input: r.tokens_in, output: r.tokens_out },
    budget: { input: r.budget_in, output: r.budget_out },
    usd: r.usd, where: r.location,
    pr: r.pr_number == null ? null : { number: r.pr_number, watched: !!r.pr_watched, checked_at: r.pr_checked_at },
    needs: r.needs_kind ? { kind: r.needs_kind, text: r.needs_text ?? "" } : null,
    blocked_by: r.blocked_by,
    terminal: r.terminal ?? null,
  };
}

export function buildStatus(db: Database, now = new Date()) {
  // A ticket's terminal: its latest session still open (the window's `e` opens it).
  const tickets = (db.query(`SELECT t.*, (SELECT terminal FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1) AS terminal
    FROM tickets t ORDER BY t.id`).all() as Row[]).map(ticketOf);
  const today = now.toISOString().slice(0, 10);
  const used = db.query("SELECT SUM(input + cache_write_5m + cache_write_1h) AS i, SUM(output) AS o, SUM(usd) AS usd FROM usage WHERE at >= ?").get(today) as any;
  // PRs opened today: what each cost, and how long from the ticket's first stage to the PR.
  const prs = db.query(`SELECT d.ticket, d.at, (SELECT SUM(usd) FROM usage u WHERE u.ticket = d.ticket) AS usd,
      (SELECT MIN(started_at) FROM stages s WHERE s.ticket = d.ticket) AS began
    FROM decisions d WHERE d.who = 'daemon' AND d.what LIKE 'opened PR #%' AND d.at >= ?`).all(today) as { ticket: number; at: string; usd: number | null; began: string | null }[];
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const beat = Date.parse(getMeta(db, "heartbeat") ?? "") || 0;
  return {
    version: 1,
    generated_at: now.toISOString(),
    source: "daemon",
    factory: { name: getMeta(db, "name") ?? "factory", repo: getMeta(db, "repo") ?? "unknown", daemon: now.getTime() - beat < HEARTBEAT_MS },
    plan: planMeters(db, now),
    today: {
      time_to_pr_min: Math.round(avg(prs.filter((p) => p.began).map((p) => (Date.parse(p.at) - Date.parse(p.began!)) / 60000))),
      cost_per_pr_usd: +avg(prs.map((p) => p.usd ?? 0)).toFixed(2),
      interactions_per_pr: +avg(prs.map((p) => interactionsBefore(db, p.ticket, p.at))).toFixed(1),
      revert_rate: revertRate(db, now),
      usd: +(used.usd ?? 0).toFixed(4),
      tokens: { input: used.i ?? 0, output: used.o ?? 0 },
      budget: { input: Number(getMeta(db, "budget_day_in") ?? 40e6), output: Number(getMeta(db, "budget_day_out") ?? 2e6) },
    },
    away: digest(db, now.toISOString()),
    to_review: 0,
    rules_failing: tickets.filter((t) => t.state === "running" && t.stage === "pr" && / ready rules · /.test(t.detail ?? "")).length,
    tickets,
  };
}

// Atomic: the window's watcher never sees a half-written file.
export function writeStatus(db: Database, path: string, now = new Date()) {
  const status = buildStatus(db, now);
  const errors = validateStatus(status);
  if (errors.length) throw new Error(`status.json would break the contract:\n${errors.join("\n")}`);
  writeFileSync(`${path}.tmp`, JSON.stringify(status, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
  return status;
}
