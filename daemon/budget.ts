// Budget caps (plan: Budgets). Three things stop new work: the day's token cap
// (budget.per_day), the 5-hour plan window passing plan.pause_at, and a ticket
// reaching its own budget. Running tickets finish their stage; only starts are held.
import { Database as DB, type Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getMeta } from "./db.ts";
import { compact, parseTokens } from "../lib/model.js";
import { loadBlueprint, readFactory } from "./runner.ts";
import { planKnown, planMeters } from "./metrics.ts";
import { readAccount } from "./account.ts";

type Tokens = { input: number; output: number };
const HOUR = 3_600_000;

const tokens = (v: unknown) => (typeof v === "number" ? v : parseTokens(String(v ?? "")));

// "40M", "2M" under input and output; a missing or unreadable half is no cap.
const capOf = (v: any): Tokens | null => {
  const input = tokens(v?.input);
  const output = tokens(v?.output);
  return input || output ? { input: input || Infinity, output: output || Infinity } : null;
};

const section = (repo: string, key: "budget" | "plan"): any => (readFactory(repo) as any)[key] ?? {};

export const dayCap = (repo: string) => capOf(section(repo, "budget").per_day);

export const headroom = (repo: string) => Number(section(repo, "budget").headroom) || 1.5;

// The account's day cap (~/.factory/config.yaml budget.per_day), over every factory.
export const accountDayCap = () => capOf(readAccount().budget?.per_day);

// plan.pause_at as a fraction: "85%", or 0.85. factory.yaml's, else the account's.
export function pauseAt(repo: string) {
  const v = section(repo, "plan").pause_at ?? readAccount().plan?.pause_at;
  if (v == null) return null;
  const n = parseFloat(String(v));
  if (!(n > 0)) return null;
  return String(v).includes("%") || n > 1 ? n / 100 : n;
}

// What learning spent today (UTC day): learner runs, benchmark runs and experiments (the
// tokens of tickets on a value other than the one in force, experiments.ts), the one total
// budget.learning caps. An old database lacks a table: nothing.
const LEARNING_TABLES = ["learner_runs", "bench_runs", "experiment_spend"];
// Experiment tickets' tokens are in usage already; the day's total mustn't count them twice.
const IN_USAGE = ["experiment_spend"];
export function learningUsage(db: Database, now: Date, tables = LEARNING_TABLES): Tokens {
  const day = now.toISOString().slice(0, 10);
  let input = 0, output = 0;
  for (const t of tables) {
    try {
      const r = db.query(`SELECT SUM(tokens_in) AS i, SUM(tokens_out) AS o FROM ${t} WHERE started_at >= ?`).get(day) as { i: number | null; o: number | null };
      input += r.i ?? 0; output += r.o ?? 0;
    } catch { /* not there yet */ }
  }
  return { input, output };
}

// Today's tokens: this factory's, or with every set, all the factories beside it under FACTORY_HOME.
export function tokensToday(db: Database, now: Date, every = false): Tokens {
  const q = "SELECT SUM(input + cache_write_5m + cache_write_1h) AS i, SUM(output) AS o FROM usage WHERE at >= ?";
  const day = now.toISOString().slice(0, 10);
  // Learning (the learner's calls, benchmarks) counts too: budget.learning is a share of the day.
  const one = (d: Database) => {
    const r = d.query(q).get(day) as { i: number | null; o: number | null };
    const l = learningUsage(d, now, LEARNING_TABLES.filter((t) => !IN_USAGE.includes(t)));
    return { i: (r.i ?? 0) + l.input, o: (r.o ?? 0) + l.output };
  };
  const rows = [one(db)];
  if (every) {
    const mine = db.filename ? resolve(db.filename) : null;
    const home = mine ? dirname(dirname(mine)) : null;
    for (const name of home && existsSync(home) ? readdirSync(home) : []) {
      const file = join(home!, name, "factory.db");
      if (file === mine || !existsSync(file)) continue;
      const other = new DB(file, { readonly: true });
      try { rows.push(one(other)); } catch { /* an old or locked database counts as nothing */ } finally { other.close(); }
    }
  }
  return { input: rows.reduce((n, r) => n + (r.i ?? 0), 0), output: rows.reduce((n, r) => n + (r.o ?? 0), 0) };
}

// Why nothing new starts right now, in words for the status bar; null when starting is fine.
export function startHold(db: Database, repo: string, now: Date): string | null {
  const cap = dayCap(repo);
  if (cap) {
    const used = tokensToday(db, now);
    if (used.input >= cap.input) return `daily budget reached (${compact(used.input)}/${compact(cap.input)} in)`;
    if (used.output >= cap.output) return `daily budget reached (${compact(used.output)}/${compact(cap.output)} out)`;
  }
  const all = accountDayCap();
  if (all) {
    const used = tokensToday(db, now, true);
    if (used.input >= all.input) return `account's daily budget reached (${compact(used.input)}/${compact(all.input)} in, every factory)`;
    if (used.output >= all.output) return `account's daily budget reached (${compact(used.output)}/${compact(all.output)} out, every factory)`;
  }
  const at = pauseAt(repo);
  // No reading and no limits set means no window data: the guard is off.
  if (at != null && planKnown(db)) {
    const w = planMeters(db, now).window_5h;
    if (w >= at) {
      const reset = estimatedReset(db, now);
      const hhmm = reset ? `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}` : null;
      return `5-hour window at ${Math.round(w * 100)}%${hhmm ? `, resets ${hhmm}` : ""}`;
    }
  }
  return null;
}

// The estimate's 5-hour reset: five hours after the window's first message (this factory's
// usage, as the estimated meters count it); null with nothing sent in the last five hours.
export function estimatedReset(db: Database, now: Date): Date | null {
  const first = (db.query("SELECT MIN(at) AS at FROM usage WHERE at >= ?").get(new Date(now.getTime() - 5 * HOUR).toISOString()) as { at: string | null }).at;
  return first ? new Date(Date.parse(first) + 5 * HOUR) : null;
}

// How far a ticket is through its budget: the larger of input and output.
export function budgetUse(t: { tokens_in: number; tokens_out: number; budget_in: number; budget_out: number }, cap?: Tokens | null) {
  const bin = Math.min(t.budget_in, cap?.input ?? Infinity);
  const bout = Math.min(t.budget_out, cap?.output ?? Infinity);
  const frac = Math.max(bin > 0 ? t.tokens_in / bin : 0, bout > 0 ? t.tokens_out / bout : 0);
  return { frac, text: `${compact(t.tokens_in)}/${compact(bin)} in, ${compact(t.tokens_out)}/${compact(bout)} out` };
}

// Grooming's estimate (plan: Budgets). With fewer than MIN_HISTORY merged tickets on the
// blueprint there is nothing to estimate from, so budget.per_ticket stands. With enough, the
// budget is the p80 of those tickets, input and output apart, times headroom. Either way it
// never drops below the floor: budget.floor (default 50%) of per_ticket, or a minimum per
// stage run (a per: slice stage counts SLICE_RUNS runs), whichever is larger.
export const MIN_HISTORY = 5;
export const SLICE_RUNS = 3;
export const STAGE_MIN: Tokens = { input: 150_000, output: 8_000 };
const FLOOR_SHARE = 0.5;

// budget.floor as a share: "50%" or 0.5.
export function floorShare(repo: string) {
  const v = section(repo, "budget").floor;
  const n = parseFloat(String(v));
  if (v == null || !(n >= 0)) return FLOOR_SHARE;
  return String(v).includes("%") || n > 1 ? n / 100 : n;
}

// The value p of the way up the sorted list, interpolating between neighbours.
export function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
}

function stageRuns(repo: string, blueprint: string) {
  try {
    const stages = Object.values(loadBlueprint(repo, blueprint).stages);
    return stages.reduce((n, s) => n + (s.per === "slice" ? SLICE_RUNS : 1), 0);
  } catch { return 0; }
}

export type Estimate = Tokens & { why: string };

export function estimateBudget(db: Database, repo: string, blueprint: string): Estimate | null {
  const rows = db.query("SELECT tokens_in AS i, tokens_out AS o FROM tickets WHERE state = 'merged' AND blueprint = ? AND tokens_in > 0")
    .all(blueprint) as { i: number; o: number }[];
  const own = capOf(section(repo, "budget").per_ticket);
  const base = own && Number.isFinite(own.input) && Number.isFinite(own.output) ? own : null;
  const share = floorShare(repo);
  const runs = stageRuns(repo, blueprint);
  const floor: Tokens = {
    input: Math.max((base?.input ?? 0) * share, STAGE_MIN.input * runs),
    output: Math.max((base?.output ?? 0) * share, STAGE_MIN.output * runs),
  };
  const lift = (t: Tokens) => ({ input: Math.round(Math.max(t.input, floor.input)), output: Math.round(Math.max(t.output, floor.output)) });
  const fl = `floor ${compact(floor.input)} in, ${compact(floor.output)} out`;
  if (rows.length < MIN_HISTORY) {
    const n = rows.length;
    const why = `only ${n} past ${blueprint} ticket${n === 1 ? "" : "s"}, need ${MIN_HISTORY}`;
    if (!base) return runs ? { ...lift({ input: 0, output: 0 }), why: `${why}; no budget.per_ticket, ${fl}` } : null;
    return { ...lift(base), why: `default: ${why}` };
  }
  const h = headroom(repo);
  const est = { input: percentile(rows.map((r) => r.i), 0.8) * h, output: percentile(rows.map((r) => r.o), 0.8) * h };
  const got = lift(est);
  const lifted = got.input > Math.round(est.input) || got.output > Math.round(est.output);
  return { ...got, why: `p80 of ${rows.length} past ${blueprint} tickets × ${h}${lifted ? `, ${fl}` : ""}` };
}

// review.round_budget: what one review round may use, as a share of the ticket's budget
// ("25%") or absolute tokens ("200k" is input, "200k/20k" is input/output). No key, no cap.
export function roundCap(repo: string, t: { budget_in: number; budget_out: number }): Tokens | null {
  const v = ((readFactory(repo) as any).review ?? {}).round_budget;
  if (v == null || v === "") return null;
  const text = String(v).trim();
  if (text.endsWith("%")) {
    const pct = parseFloat(text);
    return pct > 0 ? { input: (t.budget_in * pct) / 100, output: (t.budget_out * pct) / 100 } : null;
  }
  const [input, output] = text.split("/").map((x) => parseTokens(x.trim()));
  return input || output ? { input: input || Infinity, output: output || Infinity } : null;
}

// How far the ticket's open review round is through its cap; null with no open round or no cap.
export function roundUse(db: Database, repo: string, t: { id: number; tokens_in: number; tokens_out: number; budget_in: number; budget_out: number }) {
  const cap = roundCap(repo, t);
  const r = db.query("SELECT round, tokens_in, tokens_out FROM review_rounds WHERE ticket = ? AND closed_at IS NULL ORDER BY round DESC LIMIT 1").get(t.id) as { round: number; tokens_in: number; tokens_out: number } | null;
  if (!cap || !r) return null;
  return { round: r.round, ...budgetUse({ tokens_in: t.tokens_in - r.tokens_in, tokens_out: t.tokens_out - r.tokens_out, budget_in: cap.input, budget_out: cap.output }) };
}
