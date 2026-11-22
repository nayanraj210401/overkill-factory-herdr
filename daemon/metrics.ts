// The numbers Home and the status bar show that aren't plain sums: the plan meters,
// human interactions per PR, and the revert rate.
import type { Database } from "bun:sqlite";
import { getMeta, leadRepo, setMeta } from "./db.ts";
import { agreementMetrics } from "./agreement.ts";
import type { Run } from "./runner.ts";
import { planFile, readPlan, usedNow } from "./planline.ts";
import { readAccount } from "./account.ts";
import { parseTokens } from "../lib/model.js";

const HOUR = 3_600_000;

// The plan meters. First choice: Claude Code's own reading of your account's 5-hour and
// weekly windows, which every factory agent's status line saves to <FACTORY_HOME>/plan.json
// (daemon/planline.ts); a window past its reset reads 0. Without one, the old estimate:
// this factory's tokens in the last 5 hours and 7 days against the limits
// `factory plan 20M 400M` keeps in meta (your sessions outside the factory unseen).
export function planMeters(db: Database, now: Date) {
  const r = readPlan(planFile());
  const five = usedNow(r?.five_hour, now);
  const week = usedNow(r?.seven_day, now);
  const est = estimatedMeters(db, now);
  const source = five != null ? "claude" : limitsSet(db) ? "estimate" : "none";
  return { window_5h: five ?? est.window_5h, week: week ?? est.week, source, as_of: source === "claude" ? r!.at : null };
}

// Whether the meters have anything to go on: a reading, or limits set by hand.
export const planKnown = (db: Database) => Boolean(readPlan(planFile())?.five_hour) || limitsSet(db);

// Limits for the estimate: `factory plan` (this factory), else config.yaml's plan.limits (the account).
const tokenCount = (v: unknown) => (typeof v === "number" ? v : parseTokens(String(v ?? ""))) || 0;
const limitsSet = (db: Database) => Number(getMeta(db, "plan_5h") ?? 0) > 0 || tokenCount(readAccount().plan?.limits?.five_hour) > 0;

function estimatedMeters(db: Database, now: Date) {
  const used = (ms: number) => (db.query("SELECT SUM(input + cache_write_5m + cache_write_1h + output) AS n FROM usage WHERE at >= ?")
    .get(new Date(now.getTime() - ms).toISOString()) as { n: number | null }).n ?? 0;
  const own = readAccount().plan?.limits;
  const fallback: Record<string, unknown> = { plan_5h: own?.five_hour, plan_week: own?.week };
  const frac = (key: string, ms: number) => {
    const limit = Number(getMeta(db, key) ?? 0) || tokenCount(fallback[key]);
    return limit > 0 ? +(used(ms) / limit).toFixed(3) : 0;
  };
  return { window_5h: frac("plan_5h", 5 * HOUR), week: frac("plan_week", 7 * 24 * HOUR) };
}

// Times you stepped in before a ticket's PR opened: answers, budgets, pauses, send-backs.
// Adding the ticket and merging it are the expected touchpoints, so they don't count.
export function interactionsBefore(db: Database, ticket: number, at: string) {
  return (db.query(`SELECT COUNT(*) AS n FROM decisions WHERE ticket = ? AND who = 'you' AND at <= ?
      AND what NOT LIKE 'added %' AND what NOT LIKE 'merged PR %'`).get(ticket, at) as { n: number }).n;
}

// Of the factory PRs merged in the last 30 days, the share a later merged PR reverted.
export function revertRate(db: Database, now: Date) {
  const since = new Date(now.getTime() - 30 * 24 * HOUR).toISOString();
  const r = db.query(`SELECT COUNT(*) AS merged, SUM(t.reverted_by IS NOT NULL) AS reverted FROM tickets t
    WHERE t.state = 'merged' AND EXISTS (SELECT 1 FROM decisions d WHERE d.ticket = t.id AND d.what LIKE 'merged PR %' AND d.at >= ?)`)
    .get(since) as { merged: number; reverted: number | null };
  return r.merged ? +((r.reverted ?? 0) / r.merged).toFixed(3) : 0;
}

// GitHub's Revert button opens a PR titled `Revert "…"` whose body says
// "Reverts owner/repo#123". The daemon looks every 10 minutes.
export function findReverts(db: Database, o: { repo: string; run: Run; now: string }) {
  const merged = db.query("SELECT id, pr_number FROM ticket_lead WHERE state = 'merged' AND pr_number IS NOT NULL AND reverted_by IS NULL").all() as { id: number; pr_number: number }[];
  if (!merged.length || o.repo === "unknown") return [];
  const r = o.run(["gh", "pr", "list", "--repo", o.repo, "--state", "merged", "--search", "Revert in:title", "--json", "number,body", "--limit", "100"]);
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.out.slice(0, 200)}`);
  const reverts = JSON.parse(r.out) as { number: number; body: string }[];
  const found: number[] = [];
  for (const t of merged) {
    const by = reverts.find((p) => new RegExp(`\\bReverts\\s+${o.repo.replace(/[.]/g, "\\.")}#${t.pr_number}\\b`, "i").test(p.body ?? ""));
    if (!by) continue;
    db.query("UPDATE tickets SET reverted_by = ? WHERE id = ?").run(by.number, t.id);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(t.id, `PR #${t.pr_number} was reverted by #${by.number}`, o.now);
    found.push(t.id);
  }
  return found;
}

export function setPlan(db: Database, fiveHour: number, week: number) {
  setMeta(db, "plan_5h", String(fiveHour));
  setMeta(db, "plan_week", String(week));
}

// metrics.json, beside status.json: the Metrics page's numbers for the last 7 and 30
// days, each against the period before it. Pickup is a ticket's first stage.
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 2) => +n.toFixed(d);

function period(db: Database, from: Date, to: Date) {
  const [a, b] = [from.toISOString(), to.toISOString()];
  const opened = db.query(`SELECT d.ticket, d.at, (SELECT MIN(started_at) FROM stages s WHERE s.ticket = d.ticket) AS began,
      (SELECT COALESCE(SUM(usd), 0) FROM usage u WHERE u.ticket = d.ticket) AS usd
    FROM decisions d WHERE d.who = 'daemon' AND d.what LIKE 'opened PR #%' AND d.at >= ? AND d.at < ?`).all(a, b) as { ticket: number; at: string; began: string | null; usd: number }[];
  const merged = db.query(`SELECT d.ticket, d.at, (SELECT MIN(started_at) FROM stages s WHERE s.ticket = d.ticket) AS began,
      (SELECT MIN(at) FROM decisions o WHERE o.ticket = d.ticket AND o.who = 'daemon' AND o.what LIKE 'opened PR #%') AS pr_at,
      t.blueprint, t.reverted_by, t.retries
    FROM decisions d JOIN tickets t ON t.id = d.ticket WHERE d.who = 'you' AND d.what LIKE 'merged PR %' AND d.at >= ? AND d.at < ?`).all(a, b) as
    { ticket: number; at: string; began: string | null; pr_at: string | null; blueprint: string; reverted_by: number | null; retries: number }[];
  const mins = (x: string | null, y: string | null) => (x && y ? (Date.parse(y) - Date.parse(x)) / 60000 : null);
  const some = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
  return {
    opened, merged,
    time_to_pr_min: Math.round(median(some(opened.map((o) => mins(o.began, o.at))))),
    cost_per_pr_usd: round(mean(opened.map((o) => o.usd))),
    interactions_per_pr: round(mean(opened.map((o) => interactionsBefore(db, o.ticket, o.at))), 1),
    revert_rate: merged.length ? round(merged.filter((m) => m.reverted_by != null).length / merged.length, 3) : 0,
    cycle: {
      pickup_to_pr_min: Math.round(median(some(merged.map((m) => mins(m.began, m.pr_at))))),
      pr_to_merge_min: Math.round(median(some(merged.map((m) => mins(m.pr_at, m.at))))),
      pickup_to_merge_min: Math.round(median(some(merged.map((m) => mins(m.began, m.at))))),
    },
  };
}

// Spend per day split by a key (an agent, a model): one series per key, a day without spend 0.
function spendSeries(db: Database, keyExpr: string, from: Date, dates: string[]) {
  const rows = db.query(`SELECT ${keyExpr} AS k, substr(u.at, 1, 10) AS day, SUM(u.usd) AS usd FROM usage u LEFT JOIN sessions s ON s.id = u.session
    WHERE u.at >= ? GROUP BY k, day`).all(from.toISOString()) as { k: string; day: string; usd: number }[];
  return [...new Set(rows.map((r) => r.k))].sort().map((k) => ({ name: k, values: dates.map((d) => round(rows.find((r) => r.k === k && r.day === d)?.usd ?? 0)) }));
}

// tokenCap: the day's input-token cap (budget.per_day), drawn as a level on the tokens chart.
export function buildMetrics(db: Database, now = new Date(), tokenCap: number | null = null) {
  const day = 86_400_000;
  const ranges: Record<string, unknown> = {};
  for (const days of [7, 30]) {
    const from = new Date(now.getTime() - days * day);
    const cur = period(db, from, now);
    const prev = period(db, new Date(from.getTime() - days * day), from);
    const dates = Array.from({ length: days }, (_, i) => new Date(from.getTime() + (i + 1) * day).toISOString().slice(0, 10));
    const onDay = (at: string) => at.slice(0, 10);
    const spend = db.query(`SELECT substr(u.at, 1, 10) AS day, SUM(u.usd) AS usd FROM usage u WHERE u.at >= ? GROUP BY day`).all(from.toISOString()) as { day: string; usd: number }[];
    const tokens = db.query(`SELECT substr(at, 1, 10) AS day, SUM(input + cache_write_5m + cache_write_1h) AS n FROM usage WHERE at >= ? GROUP BY day`).all(from.toISOString()) as { day: string; n: number }[];
    const byStage = db.query(`SELECT COALESCE(s.stage, 'other') AS k, SUM(u.usd) AS usd FROM usage u LEFT JOIN sessions s ON s.id = u.session WHERE u.at >= ? GROUP BY k ORDER BY usd DESC`).all(from.toISOString()) as { k: string; usd: number }[];
    const byModel = db.query(`SELECT model AS k, SUM(usd) AS usd FROM usage WHERE at >= ? GROUP BY k ORDER BY usd DESC`).all(from.toISOString()) as { k: string; usd: number }[];
    const blueprints = [...new Set(cur.merged.map((m) => m.blueprint))].sort();
    ranges[String(days)] = {
      headline: {
        time_to_pr_min: [cur.time_to_pr_min, prev.time_to_pr_min], cost_per_pr_usd: [cur.cost_per_pr_usd, prev.cost_per_pr_usd],
        interactions_per_pr: [cur.interactions_per_pr, prev.interactions_per_pr], revert_rate: [cur.revert_rate, prev.revert_rate],
      },
      prs_opened: cur.opened.length, prs_merged: cur.merged.length,
      cycle: cur.cycle,
      merged_per_day: dates.map((d) => cur.merged.filter((m) => onDay(m.at) === d).length),
      opened_per_day: dates.map((d) => cur.opened.filter((o) => onDay(o.at) === d).length),
      // Per day, null where there was nothing to measure: the chart's line breaks there.
      time_to_pr_per_day: dates.map((d) => {
        const ms = cur.opened.filter((o) => onDay(o.at) === d && o.began).map((o) => (Date.parse(o.at) - Date.parse(o.began!)) / 60000);
        return ms.length ? Math.round(median(ms)) : null;
      }),
      revert_rate_per_day: dates.map((d) => {
        const ms = cur.merged.filter((m) => onDay(m.at) === d);
        return ms.length ? round(ms.filter((m) => m.reverted_by != null).length / ms.length, 3) : null;
      }),
      first_try_per_day: dates.map((d) => {
        const ms = cur.merged.filter((m) => onDay(m.at) === d);
        return ms.length ? round(ms.filter((m) => !m.retries).length / ms.length, 3) : null;
      }),
      tokens_in_per_day: dates.map((d) => tokens.find((t) => t.day === d)?.n ?? 0),
      tokens_in_cap: tokenCap && Number.isFinite(tokenCap) ? tokenCap : null,
      usd_by_agent_per_day: spendSeries(db, "COALESCE(s.agent, s.stage, 'other')", from, dates),
      usd_by_model_per_day: spendSeries(db, "u.model", from, dates),
      interactions_per_day: dates.map((d) => {
        const o = cur.opened.filter((x) => onDay(x.at) === d);
        return o.length ? round(mean(o.map((x) => interactionsBefore(db, x.ticket, x.at))), 1) : null;
      }),
      days: dates,
      usd_per_day: dates.map((d) => round(spend.find((s) => s.day === d)?.usd ?? 0)),
      usd_by_stage: byStage.map((r) => ({ name: r.k, usd: round(r.usd) })),
      usd_by_model: byModel.map((r) => ({ name: r.k, usd: round(r.usd) })),
      quality: blueprints.map((b) => {
        const ms = cur.merged.filter((m) => m.blueprint === b);
        return { blueprint: b, merged: ms.length, reverted: ms.filter((m) => m.reverted_by != null).length, retries_per_ticket: round(mean(ms.map((m) => m.retries)), 1) };
      }),
    };
  }
  // The babysitter's agreement with you: not per range, it is the latest benchmark run.
  return { generated_at: now.toISOString(), ranges, agreement: agreementMetrics(db, leadRepo(db)?.path ?? null) };
}
