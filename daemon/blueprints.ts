// blueprints.json, beside status.json: each blueprint's stages as the Blueprint page
// draws them, with how many times each ran in the last 7 days (retries count again).
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBlueprint } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { validateBlueprints } from "../lib/blueprints.js";

export const DAYS = 7;

const FINISHED = ["merged", "closed"];

// A blueprint as the page draws it: the same fields whether it is current or a draft.
function shape(repo: string, name: string, counted: Record<string, number> = {}) {
  const b = loadBlueprint(repo, name) as any;
  return {
    start: b.start as string, orchestrator: (b.orchestrator ?? null) as string | null,
    stages: Object.entries(b.stages as Record<string, any>).map(([id, s]) => ({
      id, agent: s.agent ?? null, role: s.agent ? loadAgent(repo, s.agent)?.role ?? null : null, check: s.check ?? null,
      next: s.next ?? [], on_fail: s.on_fail ?? null, gate: s.gate ?? "auto", requires: s.requires ?? null, runs: counted[id] ?? 0,
    })),
  };
}

// Blueprints a pending maintainer request changes: each ticket on the factory blueprint
// that hasn't finished and whose worktree's .factory/blueprints differs from the repo's.
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
      if (existsSync(mine) && readFileSync(mine, "utf8") === text) return [];
      try { return [{ ticket: t.id, title: t.title, name, error: null as string | null, ...shape(t.worktree, name) }]; }
      catch (e) { return [{ ticket: t.id, title: t.title, name, error: (e as Error).message, start: null, orchestrator: null, stages: [] }]; }
    });
  });
}

export function buildBlueprints(db: Database | null, repo: string, now = new Date()) {
  const dir = join(repo, ".factory", "blueprints");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
  const runs = (name: string) => Object.fromEntries((db?.query(`SELECT lower(s.name) AS stage, COUNT(*) AS n FROM stages s JOIN tickets t ON t.id = s.ticket
      WHERE t.blueprint = ? AND s.started_at >= ? GROUP BY lower(s.name)`).all(name, since) as { stage: string; n: number }[] ?? []).map((r) => [r.stage, r.n]));
  return {
    days: DAYS,
    drafts: buildDrafts(db, repo),
    blueprints: names.map((name) => {
      try {
        const b = loadBlueprint(repo, name) as any;
        const counted = runs(name);
        return {
          name, start: b.start, orchestrator: b.orchestrator ?? null, error: null, grooming_runs: counted.groom ?? 0,
          stages: Object.entries(b.stages as Record<string, any>).map(([id, s]) => ({
            id, agent: s.agent ?? null, role: s.agent ? loadAgent(repo, s.agent)?.role ?? null : null, check: s.check ?? null,
            next: s.next ?? [], on_fail: s.on_fail ?? null, gate: s.gate ?? "auto", requires: s.requires ?? null, runs: counted[id] ?? 0,
          })),
        };
      } catch (e) {
        return { name, start: null, orchestrator: null, error: (e as Error).message, grooming_runs: 0, stages: [] };
      }
    }),
  };
}

export function writeBlueprints(db: Database, repo: string, path: string, now = new Date()) {
  const doc = buildBlueprints(db, repo, now);
  const errors = validateBlueprints(doc);
  if (errors.length) throw new Error(`blueprints.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(path, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}
