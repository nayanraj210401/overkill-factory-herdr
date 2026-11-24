// Builds status.json (the contract in lib/status.js) from SQLite rows. The
// window reads only this file, so the daemon stays the one source of truth.
import { claudeChoice } from "./claude-bin.ts";
import { v2UI } from "./account.ts";
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStatus } from "../lib/status.js";
import { getMeta, leadRepo, listRepos, mergeOrder } from "./db.ts";
import { interactionsBefore, planMeters, revertRate } from "./metrics.ts";
import { budgetCap, digest } from "./away.ts";
import { budgetUse, dayCap, startHold } from "./budget.ts";
import { setupField } from "./setup.ts";
import { activeOverrides, fileValue } from "./learn.ts";
import { isLastGate, loadBlueprint, readFactory } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { askTarget, openAsks } from "./ask.ts";
import { healthOf } from "./health.ts";
import { trackedFactory, UNTRACK } from "./local.ts";
import { recentEvents } from "./journal.ts";

type Row = Record<string, any>;

const HEARTBEAT_MS = 15_000;

// Repos whose git tracks .factory/ (local.ts), for Home's warning. git runs at most once a minute per repo.
const trackedSeen = new Map<string, { at: number; n: number }>();
function trackedRepos(repos: { slug: string; path: string }[], now: number) {
  return repos.flatMap((r) => {
    let c = trackedSeen.get(r.path);
    if (!c || now - c.at > 60_000) trackedSeen.set(r.path, (c = { at: now, n: existsSync(r.path) ? trackedFactory(r.path).length : 0 }));
    return c.n ? [{ repo: r.slug, files: c.n, fix: UNTRACK }] : [];
  });
}

// A ticket's PR in one repo. The state is what GitHub last said, unless the ticket's own end settles it:
// merged is merged, and a closed ticket's PR is closed. The url is built, never asked of gh.
export const prOf = (r: Row, slug: string, ticket: string) => (r.pr_number == null ? null : {
  number: r.pr_number, watched: !!r.pr_watched, checked_at: r.pr_checked_at,
  url: `https://github.com/${slug}/pull/${r.pr_number}`,
  state: ticket === "merged" || r.merged_at ? "merged" : ticket === "closed" ? "closed" : r.pr_state ?? "open",
});

export function ticketOf(r: Row, repos?: Row[], cap?: { input: number; output: number } | null) {
  return {
    id: r.id, title: r.title, state: r.state, blueprint: r.blueprint,
    stage: r.stage, detail: r.detail, updated_at: r.updated_at,
    tokens: { input: r.tokens_in, output: r.tokens_out },
    budget: { input: r.budget_in, output: r.budget_out },
    usd: r.usd, where: r.location,
    warning: r.state === "running" && budgetUse(r as any, cap).frac >= 0.8 ? `${Math.round(budgetUse(r as any, cap).frac * 100)}% of its token budget used` : null,
    pr: prOf({ ...r, ...repos?.find((x) => x.lead) }, r.repo ?? repos?.find((x) => x.lead)?.repo, r.state),
    ...(repos ? { repos: repos.map((x) => ({ slug: x.repo, lead: !!x.lead, pr: prOf(x, x.repo, r.state), worktree: x.worktree ?? null, branch: x.branch ?? null,
      merged_at: x.merged_at ?? null, merge: mergeOrder(repos as any).indexOf(x) + 1 })) } : {}),
    needs: r.needs_kind ? { kind: r.needs_kind, text: r.needs_text ?? "" } : null,
    blocked_by: r.blocked_by,
    // Stopped by the plan limit (planlimit.ts): when its fresh session starts.
    ...(r.resume_at ? { resume_at: r.resume_at } : {}),
    terminal: r.terminal ?? null,
    session: r.sessions || null, // "session 3 of #412": the live agent's session in its stage; null with no live agent
    // The sidebar's Working row (lib/sidebar.js): when the current stage began, the live agent's name, and the
    // slice it builds ("slice 2 of 3", from the stage's detail: runner.ts startStage). Only when there is one.
    ...(r.stage_started_at ? { stage_started_at: r.stage_started_at } : {}),
    ...(r.agent && r.agent !== "cloud" ? { agent: r.agent } : {}),
    ...sliceOf(r.stage_detail),
  };
}

const sliceOf = (detail: string | null | undefined) => {
  const m = (detail ?? "").match(/\bslice (\d+) of (\d+)\b/);
  return m ? { slice: { n: Number(m[1]), of: Number(m[2]) } } : {};
};

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
  const open = Map.groupBy(db.query("SELECT ticket, n, kind, text FROM questions WHERE answer IS NULL ORDER BY ticket, n").all() as Row[], (q) => q.ticket);
  const questionsOf = (id: number) => (open.get(id) ?? []).map((q) => ({ n: q.n, kind: q.kind, text: q.text }));
  // Each ticket's files shared on claude.ai (artifacts.ts), for the Ticket page's links.
  const shared = Map.groupBy(db.query("SELECT ticket, file, url, kind, published_at FROM ticket_artifacts ORDER BY ticket, file").all() as Row[], (a) => a.ticket);
  // Each ticket's newest journal events (journal.ts), for the Ticket page's Activity. A ticket settled
  // more than a week ago goes without, so the file doesn't grow with the factory's history.
  const events = recentEvents(db);
  const settledBefore = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const tickets = (db.query(`SELECT t.*, (SELECT terminal FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1) AS terminal,
    -- the live agent's session number within its stage: a handoff starts the next one in the same stage
    (SELECT COUNT(*) FROM sessions s, (SELECT stage FROM sessions l WHERE l.ticket = t.id AND l.ended_at IS NULL AND l.agent IS NOT 'cloud' ORDER BY l.id DESC LIMIT 1) live
       WHERE s.ticket = t.id AND s.stage = live.stage AND s.agent IS NOT 'cloud') AS sessions,
    (SELECT agent FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1) AS agent,
    (SELECT started_at FROM stages st WHERE st.ticket = t.id AND st.ended_at IS NULL ORDER BY st.id DESC LIMIT 1) AS stage_started_at,
    (SELECT detail FROM stages st WHERE st.ticket = t.id AND st.ended_at IS NULL ORDER BY st.id DESC LIMIT 1) AS stage_detail
    FROM ticket_lead t ORDER BY t.id`).all() as Row[]).map((r) => ({
    ...ticketOf(r, reposOf(r.id), lead ? budgetCap(db, lead.path) : null),
    // The open questions of a ticket in grooming, or parked on one (u talks it through), numbered as the `A1:` answers are.
    ...((r.state === "grooming" || r.state === "parked") && open.has(r.id) ? { questions: questionsOf(r.id) } : {}),
    ...(shared.has(r.id) ? { artifacts: shared.get(r.id)!.map((a) => ({ file: a.file, url: a.url, kind: a.kind, at: a.published_at })) } : {}),
    ...(events.has(r.id) && !(["merged", "closed"].includes(r.state) && r.updated_at < settledBefore)
      ? { events: events.get(r.id)!.map((e) => ({ kind: e.kind, text: e.text, at: e.at })) } : {}),
  }));
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
  const auto = autoGates(db, lead?.path);
  const beat = Date.parse(getMeta(db, "heartbeat") ?? "") || 0;
  const health = healthOf(db);
  return {
    version: 1,
    generated_at: now.toISOString(),
    source: "daemon",
    factory: { name: getMeta(db, "name") ?? "factory", repo: lead?.slug ?? "unknown", ...(lead ? { path: lead.path } : {}), ...(lead ? { repos: listRepos(db).map((r) => r.slug) } : {}), daemon: now.getTime() - beat < HEARTBEAT_MS },
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
    // Which pages the mods draw (lib/model.js v2UI): V2_UI in factory.yaml, else config.yaml.
    ui: { v2: v2UI(lead ? readFactory(lead.path) : {}) },
    ...(auto.length ? { auto_gates: auto } : {}),
    // Each repo's last full-suite run (health.ts), for Home.
    ...(health.length ? { health } : {}),
    // Repos that track .factory/ in git: Home says so, with the command to stop (local.ts).
    ...(() => { const x = trackedRepos(listRepos(db), now.getTime()); return x.length ? { tracked_factory: x } : {}; })(),
    // No .factory/ yet: Home shows the setup checklist instead.
    ...(setup ? { setup } : {}),
    // Which claude the sessions run, for Config (claude-bin.ts); tests never look one up.
    ...(process.env.FACTORY_TEST_SANDBOX ? {} : { claude: (() => { try { return claudeChoice(); } catch (e) { return { error: (e as Error).message, found: [] }; } })() }),
    overrides: overridesOf(db, lead?.path),
    // Open notes between agents (factory ask): to Overwatch they show in Needs you; all on Config's Pending changes.
    asks: openAsks(db).map((a) => ({ id: a.id, from: a.from, to: askTarget(a), text: a.text, why: a.why, ticket: a.about, at: a.at, delivered: !!a.delivered_at })),
    to_review: 0,
    rules_failing: tickets.filter((t) => t.state === "running" && t.stage === "pr" && / ready rules · /.test(t.detail ?? "")).length,
    tickets,
  };
}

// Blueprints whose ready PRs merge themselves (a last gate set to auto), each with its record:
// merged tickets and how many of them a later PR reverted, over the last 30 days.
export function autoGates(db: Database, repo?: string) {
  if (!repo) return [];
  const dir = join(repo, ".factory", "blueprints");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return names.flatMap((name) => {
    try {
      const b = loadBlueprint(repo, name);
      if (!Object.values(b.stages).some((s) => s.gate === "auto" && !s.agent && isLastGate(s))) return [];
    } catch { return []; }
    const r = db.query(`SELECT COUNT(*) AS merged, SUM(t.reverted_by IS NOT NULL) AS reverted FROM tickets t WHERE t.blueprint = ? AND t.state = 'merged'
      AND EXISTS (SELECT 1 FROM decisions d WHERE d.ticket = t.id AND d.what LIKE 'merged PR %' AND d.at >= ?)`).get(name, since) as { merged: number; reverted: number | null };
    return [{ blueprint: name, merged: r.merged, reverted: r.reverted ?? 0, revert_rate: r.merged ? +((r.reverted ?? 0) / r.merged).toFixed(3) : 0 }];
  });
}

// Atomic: the window's watcher never sees a half-written file.
export function writeStatus(db: Database, path: string, now = new Date()) {
  const status = buildStatus(db, now);
  const errors = validateStatus(status);
  if (errors.length) throw new Error(`status.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(path, JSON.stringify(status, null, 2) + "\n");
  return status;
}
