// Builds status.json (the contract in lib/status.js) from SQLite rows. The
// window reads only this file, so the daemon stays the one source of truth.
import type { Database } from "bun:sqlite";
import { renameSync, writeFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { getMeta, leadRepo, listRepos, mergeOrder } from "./db.ts";
import { interactionsBefore, planMeters, revertRate } from "./metrics.ts";
import { budgetCap, digest } from "./away.ts";
import { budgetUse, dayCap, startHold } from "./budget.ts";
import { setupField } from "./setup.ts";
import { activeOverrides, fileValue } from "./learn.ts";
import { loadAgent, readFactory } from "./runner.ts";

type Row = Record<string, any>;

const HEARTBEAT_MS = 15_000;

const prOf = (r: Row) => (r.pr_number == null ? null : { number: r.pr_number, watched: !!r.pr_watched, checked_at: r.pr_checked_at });

export function ticketOf(r: Row, repos?: Row[], cap?: { input: number; output: number } | null) {
  return {
    id: r.id, title: r.title, state: r.state, blueprint: r.blueprint,
    stage: r.stage, detail: r.detail, updated_at: r.updated_at,
    tokens: { input: r.tokens_in, output: r.tokens_out },
    budget: { input: r.budget_in, output: r.budget_out },
    usd: r.usd, where: r.location,
    warning: r.state === "running" && budgetUse(r as any, cap).frac >= 0.8 ? `${Math.round(budgetUse(r as any, cap).frac * 100)}% of its token budget used` : null,
    pr: prOf(r),
    ...(repos ? { repos: repos.map((x) => ({ slug: x.repo, lead: !!x.lead, pr: prOf(x), worktree: x.worktree ?? null, branch: x.branch ?? null,
      merged_at: x.merged_at ?? null, merge: mergeOrder(repos as any).indexOf(x) + 1 })) } : {}),
    needs: r.needs_kind ? { kind: r.needs_kind, text: r.needs_text ?? "" } : null,
    blocked_by: r.blocked_by,
    terminal: r.terminal ?? null,
    session: r.sessions || null, // "session 3 of #412": the sessions started for it so far
  };
}

// Tuned settings, each beside the value the files give (null when it can't be read).
function overridesOf(db: Database, repo: string | undefined) {
  return activeOverrides(db).map((o) => {
    let file: unknown = null;
    try { file = repo ? fileValue(o.key, readFactory(repo), (n) => loadAgent(repo, n)) : null; } catch { /* a bad file shows no value */ }
    return { key: o.key, value: o.value, file, reason: o.reason, at: o.at };
  });
}

export function buildStatus(db: Database, now = new Date()) {
  // A ticket's terminal: its latest session still open (the window's `e` opens it).
  // Each ticket's repos, lead first; one that hasn't started works in the factory's lead repo.
  const lead = leadRepo(db);
  const work = Map.groupBy(db.query("SELECT * FROM ticket_repos ORDER BY ticket, lead DESC, repo").all() as Row[], (r) => r.ticket);
  const reposOf = (id: number) => work.get(id) ?? (lead ? [{ repo: lead.slug, lead: 1 }] : undefined);
  const tickets = (db.query(`SELECT t.*, (SELECT terminal FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1) AS terminal,
    (SELECT COUNT(*) FROM sessions s WHERE s.ticket = t.id AND s.agent != 'cloud') AS sessions
    FROM ticket_lead t ORDER BY t.id`).all() as Row[]).map((r) => ticketOf(r, reposOf(r.id), lead ? budgetCap(db, lead.path) : null));
  const setup = lead ? setupField(db, lead.path) : null;
  const hold = lead ? startHold(db, lead.path, now) : null;
  const perDay = lead ? dayCap(lead.path) : null;
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
    factory: { name: getMeta(db, "name") ?? "factory", repo: lead?.slug ?? "unknown", ...(lead ? { repos: listRepos(db).map((r) => r.slug) } : {}), daemon: now.getTime() - beat < HEARTBEAT_MS },
    plan: { ...planMeters(db, now), hold },
    today: {
      time_to_pr_min: Math.round(avg(prs.filter((p) => p.began).map((p) => (Date.parse(p.at) - Date.parse(p.began!)) / 60000))),
      cost_per_pr_usd: +avg(prs.map((p) => p.usd ?? 0)).toFixed(2),
      interactions_per_pr: +avg(prs.map((p) => interactionsBefore(db, p.ticket, p.at))).toFixed(1),
      revert_rate: revertRate(db, now),
      usd: +(used.usd ?? 0).toFixed(4),
      tokens: { input: used.i ?? 0, output: used.o ?? 0 },
      budget: { input: perDay?.input ?? Number(getMeta(db, "budget_day_in") ?? 40e6), output: perDay?.output ?? Number(getMeta(db, "budget_day_out") ?? 2e6) },
    },
    away: digest(db, now.toISOString()),
    // No .factory/ yet: Home shows the setup checklist instead.
    ...(setup ? { setup } : {}),
    overrides: overridesOf(db, lead?.path),
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
