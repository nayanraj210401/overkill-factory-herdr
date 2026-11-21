// blueprints.json, beside status.json: each blueprint's stages as the Blueprint page
// draws them, with how many times each ran in the last 7 days (retries count again).
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgent, loadBlueprint } from "./runner.ts";
import { validateBlueprints } from "../lib/blueprints.js";

export const DAYS = 7;

export function buildBlueprints(db: Database | null, repo: string, now = new Date()) {
  const dir = join(repo, ".factory", "blueprints");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort() : [];
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
  const runs = (name: string) => Object.fromEntries((db?.query(`SELECT lower(s.name) AS stage, COUNT(*) AS n FROM stages s JOIN tickets t ON t.id = s.ticket
      WHERE t.blueprint = ? AND s.started_at >= ? GROUP BY lower(s.name)`).all(name, since) as { stage: string; n: number }[] ?? []).map((r) => [r.stage, r.n]));
  return {
    days: DAYS,
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
  writeFileSync(`${path}.tmp`, JSON.stringify(doc, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
  return doc;
}
