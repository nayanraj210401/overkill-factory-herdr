// Triggers (plan: triggers/<name>.yaml): what starts work. The daemon loop runs each
// trigger on its own clock: project_ready reads the Project queue, pr_review_comment
// runs the PR watcher, schedule starts a ticket every so often, manual is the `n` key.
// A trigger with `run: health` starts no ticket: it runs the full suite (health.ts), and
// its blueprint is the one a failure's ticket gets. The built-in ones below run unless a
// file in triggers/ has the same name or does the same job (the same `on`, or `run: health`).
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvery, validateFile } from "./validate.ts";

export type Trigger = {
  name: string;
  on: "manual" | "project_ready" | "pr_review_comment" | "schedule";
  blueprint: string;
  filter?: { repos?: string[]; labels?: string[] };
  concurrency?: number;
  every?: string;
  run?: "ticket" | "health";
  setup?: string[];
};

export const DEFAULT_TRIGGERS: Trigger[] = [
  { name: "queue", on: "project_ready", blueprint: "feature" },
  { name: "review-comments", on: "pr_review_comment", blueprint: "feature" },
  { name: "health", on: "schedule", every: "1d", run: "health", blueprint: "bugfix" },
];

export const isHealth = (t: Trigger) => t.run === "health";
const sameJob = (a: Trigger, b: Trigger) => a.name === b.name || (isHealth(a) ? isHealth(b) : !isHealth(b) && a.on === b.on);

// How often each kind polls GitHub; a schedule trigger has its own `every`.
export const POLL_MS = { project_ready: 180_000, pr_review_comment: 120_000 } as const;

export function intervalOf(t: Trigger): number | null {
  if (t.on === "schedule") return parseEvery(t.every);
  return t.on === "manual" ? null : POLL_MS[t.on];
}

// The folder's triggers, plus each built-in whose job no file does: a folder holding only
// review-comments.yaml still reads the queue and checks the repo's health. A file that
// fails validation is left out and named in `skipped`.
export function readTriggers(repo: string): { triggers: Trigger[]; skipped: string[] } {
  const dir = join(repo, ".factory", "triggers");
  if (!existsSync(dir)) return { triggers: DEFAULT_TRIGGERS, skipped: [] };
  const triggers: Trigger[] = [];
  const skipped: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const errors = validateFile(`triggers/${file}`, text);
    if (errors.length) { skipped.push(`${file}: ${errors[0]}`); continue; }
    triggers.push({ name: file.replace(/\.ya?ml$/, ""), ...(Bun.YAML.parse(text) as Omit<Trigger, "name">) });
  }
  return { triggers: [...triggers, ...DEFAULT_TRIGGERS.filter((d) => !triggers.some((t) => sameJob(d, t)))], skipped };
}

// Due when never run, or its interval has passed since the last stamp.
export const isDue = (last: string | null, nowMs: number, ms: number) => !last || nowMs - Date.parse(last) >= ms;

// A queue item passes when it is in one of filter.repos and carries one of filter.labels.
export function matchesFilter(filter: Trigger["filter"], item: { repo: string; labels?: string[] }) {
  const lower = (l: string[]) => l.map((s) => s.toLowerCase());
  if (filter?.repos && !lower(filter.repos).includes(item.repo.toLowerCase())) return false;
  if (filter?.labels && !lower(filter.labels).some((l) => lower(item.labels ?? []).includes(l))) return false;
  return true;
}

// Which waiting tickets may start: a trigger's concurrency leaves room for
// (cap - its running tickets) of its own; tickets from no capped trigger always may.
export function withinCaps<T extends { trigger: string | null }>(waiting: T[], running: Record<string, number>, caps: Record<string, number>): T[] {
  const used = { ...running };
  return waiting.filter((w) => {
    const cap = w.trigger ? caps[w.trigger] : undefined;
    if (cap === undefined) return true;
    if ((used[w.trigger!] ?? 0) >= cap) return false;
    used[w.trigger!] = (used[w.trigger!] ?? 0) + 1;
    return true;
  });
}

export const capsOf = (triggers: Trigger[]) =>
  Object.fromEntries(triggers.filter((t) => t.concurrency !== undefined).map((t) => [t.name, t.concurrency!]));

export function runningByTrigger(db: Database): Record<string, number> {
  const rows = db.query("SELECT trigger_name AS name, COUNT(*) AS n FROM tickets WHERE state = 'running' AND trigger_name IS NOT NULL GROUP BY trigger_name").all() as { name: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.n]));
}
