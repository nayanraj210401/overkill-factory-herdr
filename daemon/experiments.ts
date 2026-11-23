// Bandit tuning (plan: Learning loop). For each setting in learn.tunable that has values to
// try, the daemon runs one experiment per context (the ticket's blueprint and size bucket):
//   - when a ticket starts, it picks one value (an arm) per setting, writes it into the ticket's
//     settings snapshot (fixed for the whole run) and logs the choice as a decision with its context;
//   - when the ticket merges, its value on learn.target and whether its checks passed first try
//     are recorded against that arm (a revert found later counts against it too);
//   - then, once every arm still in the running has MIN_TRIES outcomes, the arm with the lowest
//     mean becomes an override (learn.ts), and promotion to the maintainer (learner.ts) follows.
//
// The algorithm is epsilon-greedy with decay. Arms are first tried round robin until each has
// MIN_TRIES outcomes (counting tickets still running). After that a ticket explores a random arm
// with probability ε = max(EPS_MIN, 1/√N), N the outcomes in the context so far, and otherwise
// takes the best arm. The random draws come from a generator seeded by the ticket and the setting,
// so a choice can be replayed.
//
// The quality floor: the baseline is the value in force (the override, else the file's value).
// An arm whose share of tickets that passed every check on the first try is lower than the
// baseline's, or whose revert rate is higher, is below the floor once both have MIN_TRIES
// outcomes. It is never chosen again and can't win, however cheap it is.
//
// Experiments are held (the ticket runs on its snapshot alone, and the decision says why) during
// learn.warmup_tickets, while the 5-hour window or the day's budget is past learn.pause_above, and
// once budget.learning is spent. A ticket that runs on a value other than the one in force spends
// from budget.learning: its tokens count there (budget.ts learningUsage), beside the learner's and
// the benchmarks' runs.
import type { Database } from "bun:sqlite";
import { activeOverrides, fileValue, setOverride, undoOverride, type Lesson } from "./learn.ts";
import { learnerHold, learningCap, learningSpent, ticketMetric, WARMUP_TICKETS } from "./learner.ts";
import { loadAgent } from "./agents.ts";
import { readFactory } from "./runner.ts";
import { getMeta } from "./db.ts";
import { MODELS, pinModel } from "./models.ts";
import { parseTokens } from "../lib/model.js";

export const MIN_TRIES = 3;
export const EPS_MIN = 0.05;
const TARGET = "cost_per_pr";
type Value = unknown;
type Tokens = { input: number; output: number };

// ---- the arms ------------------------------------------------------------------------

// What a setting tries when learn.arms doesn't list its values: the three model tiers, three
// effort levels, three handoff thresholds (plan: What the learner learns). Anything else needs
// learn.arms.
export function defaultArms(key: string): Value[] {
  if (/(^|\.)model$/.test(key)) return [MODELS.haiku, MODELS.sonnet, MODELS.opus];
  if (/(^|\.)effort$/.test(key)) return ["low", "medium", "high"];
  if (key === "budget.handoff_at_context") return ["50%", "60%", "70%"];
  return [];
}

// A model alias and its exact ID are one arm.
const norm = (key: string, v: Value) => (/(^|\.)model$/.test(key) && typeof v === "string" ? pinModel(v) : v ?? null);
const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);
const uniq = (vs: Value[]) => vs.filter((v, i) => vs.findIndex((w) => same(v, w)) === i);

type Learn = { target?: string; tunable?: string[]; warmup_tickets?: number; arms?: Record<string, unknown> };
const learnOf = (repo: string) => (readFactory(repo).learn ?? {}) as Learn;

// The value in force for a key (the active override, else the file's) and the file's own.
export function inForce(db: Database, repo: string, key: string) {
  const file = norm(key, fileValue(key, readFactory(repo), (n) => loadAgent(repo, n)));
  const o = activeOverrides(db).find((x) => x.key === key);
  return { value: o ? norm(key, o.value) : file, file, override: !!o };
}

// The arms of one setting: the value in force first (the baseline), the file's, then the values
// to try. Fewer than two is no experiment.
export function armsFor(db: Database, repo: string, key: string): { arms: Value[]; base: Value; file: Value } {
  const listed = learnOf(repo).arms?.[key];
  const tries = Array.isArray(listed) ? listed : defaultArms(key);
  const f = inForce(db, repo, key);
  return { arms: uniq([f.value, f.file, ...tries.map((v) => norm(key, v))]), base: f.value, file: f.file };
}

// The ticket's size bucket: its groomed input budget against budget.per_ticket (3M by default).
export function sizeOf(budgetIn: number, perTicketIn: number) {
  const r = budgetIn / (perTicketIn || 3_000_000);
  return r <= 0.75 ? "s" : r <= 1.5 ? "m" : "l";
}
const perTicketIn = (repo: string) => {
  const v = ((readFactory(repo) as any).budget?.per_ticket ?? {}).input;
  return (typeof v === "number" ? v : parseTokens(String(v ?? ""))) || 3_000_000;
};

// ---- the statistics -----------------------------------------------------------------

export type ArmStats = { value: Value; pulls: number; pending: number; n: number; mean: number | null; first_try: number | null; revert_rate: number | null };
export type Floor = "ok" | "below" | "unknown";

export function armStats(db: Database, key: string, context: string, target: string, arms: Value[]): ArmStats[] {
  const rows = db.query(`SELECT p.value, p.outcome, p.target, p.metric, p.first_try, t.reverted_by FROM experiment_pulls p JOIN tickets t ON t.id = p.ticket
    WHERE p.key = ? AND p.context = ?`).all(key, context) as { value: string; outcome: string | null; target: string | null; metric: number | null; first_try: number | null; reverted_by: number | null }[];
  const seen = uniq([...arms, ...rows.map((r) => JSON.parse(r.value))]);
  return seen.map((value) => {
    const mine = rows.filter((r) => same(JSON.parse(r.value), value));
    const merged = mine.filter((r) => r.outcome === "merged" && r.target === target && r.metric != null);
    const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4) : null);
    return {
      value, pulls: mine.length, pending: mine.filter((r) => r.outcome == null).length, n: merged.length,
      mean: avg(merged.map((r) => r.metric!)),
      first_try: avg(merged.map((r) => r.first_try ?? 0)),
      revert_rate: avg(merged.map((r) => (r.reverted_by != null ? 1 : 0))),
    };
  });
}

// The quality floor, against the baseline's own record.
export function floorOf(a: ArmStats, base: ArmStats): Floor {
  if (same(a.value, base.value)) return "ok";
  if (a.n < MIN_TRIES || base.n < MIN_TRIES) return "unknown";
  return a.first_try! < base.first_try! || a.revert_rate! > base.revert_rate! ? "below" : "ok";
}

// The lowest mean among the arms above the floor, the baseline on a tie; null until each of them
// (and the baseline) has MIN_TRIES outcomes.
export function winnerOf(stats: ArmStats[], base: Value): { value: Value } | null {
  const b = stats.find((s) => same(s.value, base));
  if (!b || b.n < MIN_TRIES) return null;
  const live = stats.filter((s) => floorOf(s, b) !== "below");
  if (live.some((s) => s.n < MIN_TRIES)) return null;
  return { value: best(live, base) };
}
const best = (live: ArmStats[], base: Value) => live.reduce((w, s) => (s.mean! < w.mean! ? s : w), live.find((s) => same(s.value, base)) ?? live[0]).value;

// ---- the choice ---------------------------------------------------------------------

// mulberry32: small, fast and the same everywhere, so a seed replays a choice.
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
export const seedOf = (ticket: number, key: string) => hash(`${ticket}:${key}`);

export type Choice = { value: Value; mode: "try" | "explore" | "exploit"; epsilon: number | null };

// One arm for one ticket. Pure: the stats, the baseline and a random source in, the arm out.
export function chooseArm(stats: ArmStats[], base: Value, rng: () => number): Choice {
  const b = stats.find((s) => same(s.value, base)) ?? stats[0];
  const live = stats.filter((s) => floorOf(s, b) !== "below");
  const short = live.filter((s) => s.n + s.pending < MIN_TRIES);
  if (short.length) return { value: short.reduce((m, s) => (s.n + s.pending < m.n + m.pending ? s : m)).value, mode: "try", epsilon: null };
  const n = live.reduce((t, s) => t + s.n, 0);
  const epsilon = +Math.max(EPS_MIN, 1 / Math.sqrt(Math.max(n, 1))).toFixed(3);
  const scored = live.filter((s) => s.mean != null);
  if (rng() < epsilon || !scored.length) return { value: live[Math.floor(rng() * live.length)].value, mode: "explore", epsilon };
  return { value: best(scored, base), mode: "exploit", epsilon };
}

// ---- the holds and the learning budget ---------------------------------------------

// Why experiments are off right now, or null: the learner's holds (learner.ts) — warmup,
// learn.pause_above, and budget.learning (learningHold), which counts the tokens of tickets on a
// value other than the one in force (the experiment_spend view) beside learner and benchmark runs.
export const experimentHold = (db: Database, repo: string, now: Date) => learnerHold(db, repo, now);

// ---- a ticket's start and finish ----------------------------------------------------

const show = (v: Value) => (v == null ? "the file's value (unset)" : typeof v === "string" ? v : JSON.stringify(v));
const armLine = (s: ArmStats) => `${show(s.value)} ${s.n}/${s.pulls}${s.mean != null ? ` mean ${s.mean}` : ""}`;

// At a ticket's start, after its snapshot (learn.ts snapshotSettings): one arm per experimented
// setting, written into its settings. `rng` replaces the seeded generator (tests).
export function startExperiments(db: Database, o: { repo: string; id: number; now: string; rng?: (key: string) => () => number }) {
  const learn = learnOf(o.repo);
  const t = db.query("SELECT blueprint, budget_in, settings FROM tickets WHERE id = ?").get(o.id) as { blueprint: string; budget_in: number; settings: string | null } | null;
  if (!t || t.blueprint === "factory") return [];
  if (db.query("SELECT 1 FROM experiment_pulls WHERE ticket = ?").get(o.id)) return []; // a restart keeps its arms
  const keys = (learn.tunable ?? []).filter((k) => armsFor(db, o.repo, k).arms.length >= 2);
  if (!keys.length) return [];
  const say = (what: string, why: string) => db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'learner', ?, ?, ?)").run(o.id, what, why, o.now);
  const context = `${t.blueprint}/${sizeOf(t.budget_in, perTicketIn(o.repo))}`;
  const hold = experimentHold(db, o.repo, new Date(o.now));
  if (hold) { say("no experiments: the ticket runs on the settings in force", hold); return []; }
  const target = learn.target ?? TARGET;
  let on: Record<string, unknown> = {};
  try { on = JSON.parse(t.settings ?? "{}") ?? {}; } catch {}
  const out: { key: string; value: Value; mode: Choice["mode"] }[] = [];
  for (const key of keys) {
    const { arms, base } = armsFor(db, o.repo, key);
    const stats = armStats(db, key, context, target, arms).filter((s) => arms.some((a) => same(a, s.value)));
    const c = chooseArm(stats, base, o.rng?.(key) ?? seeded(seedOf(o.id, key)));
    if (c.value == null) delete on[key]; else on[key] = c.value;
    db.query("INSERT INTO experiment_pulls (ticket, key, context, value, explored, chosen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(o.id, key, context, JSON.stringify(c.value), same(c.value, base) ? 0 : 1, o.now);
    say(`experiment: ${key} = ${show(c.value)} (${c.mode})`,
      `context ${context}; in force ${show(base)}; ${learn.target ?? TARGET}; arms (merged/pulled): ${stats.map(armLine).join(", ")}${c.epsilon != null ? `; ε ${c.epsilon}` : ""}`);
    out.push({ key, value: c.value, mode: c.mode });
  }
  db.query("UPDATE tickets SET settings = ? WHERE id = ?").run(JSON.stringify(on), o.id);
  return out;
}

// An override for this key and value that you undid (not one a later override replaced, nor one a
// shift undid): the learner doesn't move the setting back there.
function undoneByYou(db: Database, key: string, value: Value) {
  const rows = db.query("SELECT value, undone_at FROM overrides WHERE key = ? AND undone_at IS NOT NULL").all(key) as { value: string; undone_at: string }[];
  return rows.some((r) => same(norm(key, JSON.parse(r.value)), value)
    && !db.query("SELECT 1 FROM overrides WHERE key = ? AND created_at = ?").get(key, r.undone_at)
    && !db.query("SELECT 1 FROM experiment_shifts WHERE key = ? AND at = ?").get(key, r.undone_at));
}

// After an outcome: the winner of the context with the most outcomes for this key becomes the
// value in force (an override, or the file's value again by undoing the override).
export function maybeShift(db: Database, o: { repo: string; key: string; context: string; now: string }) {
  const learn = learnOf(o.repo);
  if (!(learn.tunable ?? []).includes(o.key)) return null;
  const target = learn.target ?? TARGET;
  const top = db.query(`SELECT context, COUNT(*) AS n FROM experiment_pulls WHERE key = ? AND outcome = 'merged' AND target = ? GROUP BY context ORDER BY n DESC, context = ? DESC LIMIT 1`)
    .get(o.key, target, o.context) as { context: string } | null;
  if (top?.context !== o.context) return null;
  const { arms, base, file } = armsFor(db, o.repo, o.key);
  const stats = armStats(db, o.key, o.context, target, arms).filter((s) => arms.some((a) => same(a, s.value)));
  const won = winnerOf(stats, base);
  if (!won || same(won.value, base) || undoneByYou(db, o.key, won.value)) return null;
  const win = won.value;
  const w = stats.find((s) => same(s.value, win))!, b = stats.find((s) => same(s.value, base))!;
  const why = `${target} in ${o.context}: ${show(win)} ${w.mean} over ${w.n} tickets (first try ${w.first_try}, reverts ${w.revert_rate}) against ${show(base)} ${b.mean} over ${b.n} (first try ${b.first_try}, reverts ${b.revert_rate})`;
  let override: number | null = null;
  if (same(win, file) && inForce(db, o.repo, o.key).override) undoOverride(db, o.key, o.now);
  else {
    setOverride(db, { key: o.key, value: win, reason: `experiment: ${why}`, tunable: learn.tunable, now: o.now });
    override = (db.query("SELECT id FROM overrides WHERE key = ? AND undone_at IS NULL").get(o.key) as { id: number }).id;
  }
  db.query("INSERT INTO experiment_shifts (key, context, from_value, to_value, override, why, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.key, o.context, JSON.stringify(base), JSON.stringify(win), override, why, o.now);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (NULL, 'learner', ?, ?, ?)")
    .run(`shifted ${o.key} to ${show(win)}${override ? ` (override #${override})` : " (the file's value)"}`, why, o.now);
  return { key: o.key, from: base, to: win, override };
}

// When a ticket finishes (runner.ts finishPr): its outcome on each arm it ran, then any shift.
// Its checks passed first try when no check of it ever failed.
export function recordOutcome(db: Database, o: { repo: string; id: number; state: "merged" | "closed"; now: string }) {
  const pulls = db.query("SELECT key, context FROM experiment_pulls WHERE ticket = ? AND outcome IS NULL").all(o.id) as { key: string; context: string }[];
  if (!pulls.length) return [];
  const target = learnOf(o.repo).target ?? TARGET;
  const metric = o.state === "merged" ? ticketMetric(db, o.id, target) : null;
  const firstTry = db.query("SELECT 1 FROM evidence WHERE ticket = ? AND result = 'FAIL' LIMIT 1").get(o.id) ? 0 : 1;
  db.query("UPDATE experiment_pulls SET outcome = ?, target = ?, metric = ?, first_try = ?, outcome_at = ? WHERE ticket = ? AND outcome IS NULL")
    .run(o.state, target, metric, firstTry, o.now, o.id);
  if (o.state !== "merged") return [];
  return pulls.flatMap((p) => maybeShift(db, { repo: o.repo, key: p.key, context: p.context, now: o.now }) ?? []);
}

// ---- metrics.json's learning ---------------------------------------------------------

export type LearningMetrics = {
  target: string;
  hold: string | null;
  warmup: { merged: number; needed: number };
  budget: { spent: Tokens; cap: Tokens | null };
  experiments: { key: string; context: string; current: Value; file: Value; winner: Value | null; decided: boolean; epsilon: number | null; outcomes: number;
    arms: (ArmStats & { floor: Floor; in_force: boolean })[] }[];
  overrides: { id: number; key: string; value: Value; since: string; reason: string | null; from_experiment: boolean }[];
  shifts: { at: string; key: string; context: string; from: Value; to: Value; override: number | null; why: string }[];
  lessons: { id: number; area: string; text: string; source: string; hits: number; since: string }[];
  // The daily lesson upkeep: its last run and what it did, and how many lessons sit merged or retired now.
  upkeep: { last: { at: string; merged: number; retired: number } | null; merged: number; retired: number };
};

const tokens = (t: Tokens | null) => (t ? { input: Number.isFinite(t.input) ? Math.round(t.input) : 0, output: Number.isFinite(t.output) ? Math.round(t.output) : 0 } : null);

function lessonUpkeep(db: Database): LearningMetrics["upkeep"] {
  const last = JSON.parse(getMeta(db, "lessons_upkeep") ?? "null") as LearningMetrics["upkeep"]["last"];
  const n = (db.query("SELECT COUNT(dup_of) AS merged, COUNT(retired_at) AS retired FROM lessons").get() as { merged: number; retired: number });
  return { last, merged: n.merged, retired: n.retired };
}

// What the Metrics page's Learning tab reads: each experiment with its arms, counts, means and the
// floor; the value in force; the overrides; every shift with its time; and the lesson store (the
// active lessons, repeats left out, by area and then the most used).
export function learningMetrics(db: Database, repo: string, now = new Date()): LearningMetrics {
  const learn = learnOf(repo);
  const target = learn.target ?? TARGET;
  const merged = (db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged' AND blueprint != 'factory'").get() as { n: number }).n;
  const spent = learningSpent(db, now);
  const groups = db.query("SELECT DISTINCT key, context FROM experiment_pulls ORDER BY key, context").all() as { key: string; context: string }[];
  const experiments = groups.map(({ key, context }) => {
    const { arms, base, file } = armsFor(db, repo, key);
    const stats = armStats(db, key, context, target, arms);
    const bs = stats.find((s) => same(s.value, base)) ?? stats[0];
    const outcomes = stats.reduce((t, s) => t + s.n, 0);
    return {
      key, context, current: base, file, winner: winnerOf(stats, base)?.value ?? null, decided: !!winnerOf(stats, base), outcomes,
      epsilon: outcomes ? +Math.max(EPS_MIN, 1 / Math.sqrt(outcomes)).toFixed(3) : null,
      arms: stats.map((s) => ({ ...s, floor: floorOf(s, bs), in_force: same(s.value, base) })),
    };
  });
  const overrides = (db.query("SELECT id, key, value, reason, created_at FROM overrides WHERE undone_at IS NULL ORDER BY id").all() as any[])
    .map((r) => ({ id: r.id, key: r.key, value: JSON.parse(r.value), since: r.created_at, reason: r.reason, from_experiment: String(r.reason ?? "").startsWith("experiment:") }));
  const shifts = (db.query("SELECT * FROM experiment_shifts ORDER BY id").all() as any[])
    .map((r) => ({ at: r.at, key: r.key, context: r.context, from: JSON.parse(r.from_value ?? "null"), to: JSON.parse(r.to_value), override: r.override, why: r.why }));
  const lessons = (db.query("SELECT * FROM lessons WHERE retired_at IS NULL AND dup_of IS NULL ORDER BY area, hits DESC, id").all() as Lesson[])
    .map((l) => ({ id: l.id, area: l.area, text: l.text, source: l.source, hits: l.hits, since: l.created_at }));
  return {
    target, hold: experimentHold(db, repo, now),
    warmup: { merged, needed: learn.warmup_tickets ?? WARMUP_TICKETS },
    budget: { spent: tokens(spent)!, cap: tokens(learningCap(repo)) },
    experiments, overrides, shifts, lessons, upkeep: lessonUpkeep(db),
  };
}
