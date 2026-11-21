// The numbers Home and the status bar show that aren't plain sums: the plan meters,
// human interactions per PR, and the revert rate.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import type { Run } from "./runner.ts";

const HOUR = 3_600_000;

// Your plan's limits are yours, not the repo's: `factory plan 20M 400M` keeps them in
// meta. The meters count tokens in and out that this factory's agents used in the
// last 5 hours and 7 days; your own sessions outside the factory aren't seen.
export function planMeters(db: Database, now: Date) {
  const used = (ms: number) => (db.query("SELECT SUM(input + cache_write_5m + cache_write_1h + output) AS n FROM usage WHERE at >= ?")
    .get(new Date(now.getTime() - ms).toISOString()) as { n: number | null }).n ?? 0;
  const frac = (key: string, ms: number) => {
    const limit = Number(getMeta(db, key) ?? 0);
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
  const merged = db.query("SELECT id, pr_number FROM tickets WHERE state = 'merged' AND pr_number IS NOT NULL AND reverted_by IS NULL").all() as { id: number; pr_number: number }[];
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
