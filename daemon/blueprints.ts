// blueprints.json, beside status.json: each blueprint's stages as the Blueprint page
// draws them, with how many times each ran in the last 7 days (retries count again).
// A stage that names a shared step (steps.ts) shows the step's fields, and its name as `step`.
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBlueprint } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { validateBlueprints } from "../lib/blueprints.js";
import { stageOutcomes, stageHistory, blueprintStats } from "../lib/blueprint-v2.js";
import { stepFile, loadStep } from "./steps.ts";

export const DAYS = 7;

const FINISHED = ["merged", "closed"];

// A blueprint as the page draws it: the same fields whether it is current or a draft.
function shape(repo: string, name: string, counted: Record<string, number> = {}) {
  const b = loadBlueprint(repo, name) as any;
  return {
    start: b.start as string, orchestrator: (b.orchestrator ?? null) as string | null, description: (b.description ?? null) as string | null,
    stages: Object.entries(b.stages as Record<string, any>).map(([id, s]) => ({
      id, step: s.step ?? null, agent: s.agent ?? null, role: s.agent ? loadAgent(repo, s.agent)?.role ?? null : null, check: s.check ?? null,
      next: s.next ?? [], on_fail: s.on_fail ?? null, gate: s.gate ?? "auto", requires: s.requires ?? null, output: s.output ?? null, runs: counted[id] ?? 0,
    })),
  };
}

// Blueprints a pending maintainer request changes: each ticket on the factory blueprint
// that hasn't finished and whose worktree's .factory/blueprints (or a step one names) differs from the repo's.
// The page draws each beside the current one (lib/blueprints.js marks the differences).
export function buildDrafts(db: Database | null, repo: string) {
  const tickets = (db?.query(`SELECT id, title, worktree FROM ticket_lead WHERE blueprint = 'factory' AND worktree IS NOT NULL AND state NOT IN (${FINISHED.map(() => "?").join(",")}) ORDER BY id`).all(...FINISHED) as { id: number; title: string; worktree: string }[] | undefined) ?? [];
  return tickets.flatMap((t) => {
    const dir = join(t.worktree, ".factory", "blueprints");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().flatMap((f) => {
      const name = f.slice(0, -5);
      const mine = join(repo, ".factory", "blueprints", f);
      const text = readFileSync(join(dir, f), "utf8");
      // Same file and same shared steps: nothing pending. A changed step changes every blueprint naming it.
      if (existsSync(mine) && readFileSync(mine, "utf8") === text && sameStages(repo, t.worktree, name)) return [];
      try { return [{ ticket: t.id, title: t.title, name, error: null as string | null, ...shape(t.worktree, name) }]; }
      catch (e) { return [{ ticket: t.id, title: t.title, name, error: (e as Error).message, start: null, orchestrator: null, stages: [] }]; }
    });
  });
}

function sameStages(a: string, b: string, name: string) {
  try { return JSON.stringify(loadBlueprint(a, name).stages) === JSON.stringify(loadBlueprint(b, name).stages); } catch { return false; }
}

// How far back the V2 page's per-stage history looks for a stage's last 10 runs.
const HISTORY_DAYS = 90;

type Row = { ticket: number; title: string; stage: string; started_at: string; ended_at: string | null; state: string; needs_text: string | null };

// The V2 page's numbers for one blueprint (lib/blueprint-v2.js works them out): per stage its
// last 10 runs, pass/fail and median time in the window, recent runs; for the blueprint its
// stats strip. From the stage rows of its tickets, the asks, the PRs opened and the spend.
function history(db: Database | null, name: string, stages: { id: string; on_fail: string | null }[], since: string, now: Date) {
  const from = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  const rows = (db?.query(`SELECT s.ticket, t.title, lower(s.name) AS stage, s.started_at, s.ended_at, t.state, t.needs_text FROM stages s JOIN tickets t ON t.id = s.ticket
      WHERE t.blueprint = ? AND s.started_at >= ? ORDER BY s.ticket, s.started_at, s.id`).all(name, from) as Row[] | undefined) ?? [];
  const runs = stageOutcomes(rows, stages);
  const ids = [...new Set(rows.map((r) => r.ticket))];
  const tickets: Record<number, { ask_at: string | null; pr_at: string | null; usd: number }> = {};
  for (const id of ids) {
    const t = db!.query(`SELECT (SELECT MIN(at) FROM decisions WHERE ticket = ?1 AND who = 'you' AND what LIKE 'added %') AS ask,
        (SELECT MIN(started_at) FROM stages WHERE ticket = ?1) AS began,
        (SELECT MIN(at) FROM decisions WHERE ticket = ?1 AND who = 'daemon' AND what LIKE 'opened PR #%') AS pr_at,
        (SELECT COALESCE(SUM(usd), 0) FROM usage WHERE ticket = ?1) AS usd`).get(id) as { ask: string | null; began: string | null; pr_at: string | null; usd: number };
    tickets[id] = { ask_at: t.ask ?? t.began, pr_at: t.pr_at, usd: t.usd };
  }
  return {
    stats: blueprintStats(runs, tickets, since),
    stage: (id: string) => stageHistory(runs, id, since),
  };
}

// Each step a blueprint names: the file it loads from, its description and what it leaves.
function stepsOf(repo: string, names: string[]) {
  const out: Record<string, { file: string | null; label: string | null; description: string | null; output: string | null }> = {};
  for (const n of names) {
    const at = stepFile(repo, n);
    let step: Record<string, unknown> | null = null;
    try { step = loadStep(repo, n); } catch {}
    out[n] = { file: at?.file ?? null, label: at?.label ?? null, description: (step?.description as string) ?? null, output: (step?.output as string) ?? null };
  }
  return out;
}

export function buildBlueprints(db: Database | null, repo: string, now = new Date()) {
  const dir = join(repo, ".factory", "blueprints");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
  const runs = (name: string) => Object.fromEntries((db?.query(`SELECT lower(s.name) AS stage, COUNT(*) AS n FROM stages s JOIN tickets t ON t.id = s.ticket
      WHERE t.blueprint = ? AND s.started_at >= ? GROUP BY lower(s.name)`).all(name, since) as { stage: string; n: number }[] ?? []).map((r) => [r.stage, r.n]));
  const blueprints = names.map((name) => {
    try {
      const counted = runs(name);
      const b = shape(repo, name, counted);
      const h = history(db, name, b.stages, since, now);
      return { name, ...b, error: null, grooming_runs: counted.groom ?? 0, stats: h.stats, grooming: h.stage("groom"),
        stages: b.stages.map((s) => ({ ...s, ...h.stage(s.id) })) };
    } catch (e) {
      return { name, start: null, orchestrator: null, description: null, error: (e as Error).message, grooming_runs: 0, stages: [] };
    }
  });
  const named = [...new Set(blueprints.flatMap((b) => b.stages.map((s: any) => s.step).filter(Boolean)))].sort() as string[];
  return { days: DAYS, drafts: buildDrafts(db, repo), steps: stepsOf(repo, named), blueprints };
}

export function writeBlueprints(db: Database, repo: string, path: string, now = new Date()) {
  const doc = buildBlueprints(db, repo, now);
  const errors = validateBlueprints(doc);
  if (errors.length) throw new Error(`blueprints.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(path, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}
