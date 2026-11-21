// Builds status.json (the contract in lib/status.js) from SQLite rows. The
// window reads only this file, so the daemon stays the one source of truth.
import type { Database } from "bun:sqlite";
import { renameSync, writeFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { getMeta } from "./db.ts";

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
  const touched = tickets.filter((t) => t.updated_at.startsWith(today));
  const beat = Date.parse(getMeta(db, "heartbeat") ?? "") || 0;
  return {
    version: 1,
    generated_at: now.toISOString(),
    source: "daemon",
    factory: { name: getMeta(db, "name") ?? "factory", repo: getMeta(db, "repo") ?? "unknown", daemon: now.getTime() - beat < HEARTBEAT_MS },
    // Plan windows and per-PR numbers arrive with session recording (D4) and PRs (D5).
    plan: { window_5h: 0, week: 0 },
    today: {
      time_to_pr_min: 0, cost_per_pr_usd: 0, interactions_per_pr: 0, revert_rate: 0,
      usd: touched.reduce((n, t) => n + t.usd, 0),
      tokens: { input: touched.reduce((n, t) => n + t.tokens.input, 0), output: touched.reduce((n, t) => n + t.tokens.output, 0) },
      budget: { input: Number(getMeta(db, "budget_day_in") ?? 40e6), output: Number(getMeta(db, "budget_day_out") ?? 2e6) },
    },
    to_review: 0,
    rules_failing: 0,
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
