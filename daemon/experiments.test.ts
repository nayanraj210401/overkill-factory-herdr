// Bandit tuning (experiments.ts): arms chosen at a ticket's start and fixed for its run, outcomes
// on merge, the quality floor, the holds, and the winner becoming an override. Nothing real runs.
import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { activeOverrides, setOverride, undoOverride } from "./learn.ts";
import { finishPr, type Run } from "./runner.ts";
import { promoteOverrides } from "./learner.ts";
import { MODELS } from "./models.ts";
import { tokensToday } from "./budget.ts";
import { armStats, chooseArm, floorOf, learningMetrics, MIN_TRIES, recordOutcome, seeded, sizeOf, startExperiments, type ArmStats } from "./experiments.ts";
import { validateMetrics } from "../lib/metrics.js";

const HOME0 = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = HOME0; });
const NOW = "2026-11-22T12:00:00.000Z";
const H = MODELS.haiku, S = MODELS.sonnet, O = MODELS.opus;
const KEY = "agents.builder.model";

function setup(learn = "  warmup_tickets: 0\n", extra = "") {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\ndefaults:\n  model: sonnet\nlearn:\n  target: cost_per_pr\n  tunable: [${KEY}]\n${learn}${extra}`);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let id = 0;
  const add = (o: { blueprint?: string; budget?: number } = {}) => {
    const t = ++id;
    db.query("INSERT INTO tickets (id, title, state, blueprint, budget_in, settings, updated_at) VALUES (?, 'x', 'running', ?, ?, '{}', ?)").run(t, o.blueprint ?? "feature", o.budget ?? 3_000_000, NOW);
    return t;
  };
  const start = (t: number, rng?: () => number) => startExperiments(db, { repo, id: t, now: NOW, rng: rng && (() => rng) });
  const settings = (t: number) => JSON.parse((db.query("SELECT settings FROM tickets WHERE id = ?").get(t) as { settings: string }).settings);
  // A ticket's finish: its cost, whether a check failed on the way, then the merge.
  const finish = (t: number, o: { usd: number; failed?: boolean; state?: "merged" | "closed" }) => {
    db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, ?, ?, 'm', 1000, 0, 0, 0, 10, ?)").run(`m${t}`, t, NOW, o.usd);
    if (o.failed) db.query("INSERT INTO evidence (ticket, check_name, result, at) VALUES (?, 'tests', 'FAIL', ?)").run(t, NOW);
    db.query("UPDATE tickets SET state = ? WHERE id = ?").run(o.state ?? "merged", t);
    return recordOutcome(db, { repo, id: t, state: o.state ?? "merged", now: NOW });
  };
  // One whole ticket on a forced arm (the rng is ignored while arms are being tried).
  const run = (value: string, o: { usd: number; failed?: boolean }) => {
    const t = add();
    start(t);
    db.query("UPDATE experiment_pulls SET value = ?, explored = ? WHERE ticket = ?").run(JSON.stringify(value), value === S ? 0 : 1, t);
    return { t, shift: finish(t, o) };
  };
  return { db, dir, repo, add, start, settings, finish, run };
}

const arm = (value: unknown, n: number, mean: number | null, o: Partial<ArmStats> = {}): ArmStats => ({ value, pulls: n, pending: 0, n, mean, first_try: 1, revert_rate: 0, ...o });

test("the choice: arms are tried round robin first, then a seeded draw decides explore or exploit, the same every time", () => {
  expect(chooseArm([arm(S, 0, null), arm(H, 0, null), arm(O, 0, null)], S, seeded(1))).toEqual({ value: S, mode: "try", epsilon: null });
  // Running tickets count: the arm with the fewest outcomes and pending tickets goes next.
  expect(chooseArm([arm(S, 1, 2), arm(H, 0, null, { pending: 1 }), arm(O, 0, null)], S, seeded(1)).value).toBe(O);
  const ready = [arm(S, 10, 2), arm(H, 10, 1), arm(O, 10, 4)];
  const draws = (seed: number) => { const r = seeded(seed); return Array.from({ length: 40 }, () => chooseArm(ready, S, r)); };
  expect(draws(7)).toEqual(draws(7));
  expect(draws(7)).not.toEqual(draws(8));
  const all = draws(7);
  expect(all[0].epsilon).toBe(+(1 / Math.sqrt(30)).toFixed(3));
  expect(all.filter((c) => c.mode === "exploit").every((c) => c.value === H)).toBe(true);
  expect(all.some((c) => c.mode === "explore")).toBe(true);
  // Exploit below ε, explore above it: a fixed draw settles it.
  expect(chooseArm(ready, S, () => 0.99)).toEqual({ value: H, mode: "exploit", epsilon: 0.183 });
  expect(chooseArm(ready, S, () => 0.01).mode).toBe("explore");
  // ε decays with the outcomes, down to its floor.
  expect(chooseArm([arm(S, 500, 2), arm(H, 500, 1)], S, () => 0.99).epsilon).toBe(0.05);
});

test("the quality floor beats cost: a cheaper arm that fails checks more often or is reverted more is never chosen and can't win", () => {
  const base = arm(S, 5, 3, { first_try: 0.8 });
  expect(floorOf(arm(H, 5, 1, { first_try: 0.6 }), base)).toBe("below");
  expect(floorOf(arm(H, 5, 1, { revert_rate: 0.2 }), base)).toBe("below");
  expect(floorOf(arm(H, 5, 1, { first_try: 0.8 }), base)).toBe("ok");
  expect(floorOf(arm(H, MIN_TRIES - 1, 1, { first_try: 0 }), base)).toBe("unknown");
  const stats = [base, arm(H, 5, 0.5, { first_try: 0.4 })];
  for (let i = 0; i < 50; i++) expect(chooseArm(stats, S, seeded(i)).value).toBe(S);

  // End to end: haiku is far cheaper but its tickets fail a check first; sonnet stays in force.
  const s = setup("  warmup_tickets: 0\n", "  arms:\n    agents.builder.model: [haiku]\n");
  for (let i = 0; i < 3; i++) { s.run(S, { usd: 3 }); s.run(H, { usd: 0.5, failed: true }); }
  expect(activeOverrides(s.db)).toEqual([]);
  const m = learningMetrics(s.db, s.repo, new Date(NOW));
  expect(m.experiments[0].arms.map((a) => [a.value, a.n, a.mean, a.first_try, a.floor])).toEqual([[S, 3, 3, 1, "ok"], [H, 3, 0.5, 0, "below"]]);
  expect(m.experiments[0].decided).toBe(true);
  expect(m.experiments[0].winner).toBe(S);
  // The next ticket runs on sonnet whatever the draw.
  const t = s.add();
  s.start(t, () => 0);
  expect(s.settings(t)).toEqual({ [KEY]: S });
});

test("warmup and learn.pause_above hold experiments: the ticket runs on its snapshot, and the decision says why", () => {
  const s = setup("  warmup_tickets: 2\n  pause_above: 50%\n", "budget:\n  per_day: { input: 10000, output: 1000 }\n");
  const a = s.add();
  expect(s.start(a)).toEqual([]);
  expect(s.settings(a)).toEqual({});
  expect(s.db.query("SELECT COUNT(*) AS n FROM experiment_pulls").get()).toEqual({ n: 0 });
  const why = (t: number) => s.db.query("SELECT what, why FROM decisions WHERE ticket = ? AND who = 'learner'").get(t) as { what: string; why: string };
  expect(why(a).what).toBe("no experiments: the ticket runs on the settings in force");
  expect(why(a).why).toContain("warming up: 0 of learn.warmup_tickets 2");
  // Two merged: warmup is over, but the day's budget is past 50%.
  for (const t of [s.add(), s.add()]) s.finish(t, { usd: 1 });
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('big', 2, ?, 'm', 6000, 0, 0, 0, 1, 0)").run(NOW);
  const b = s.add();
  expect(s.start(b)).toEqual([]);
  expect(why(b).why).toContain("the day's budget is at");
  // Under the line again: the experiment runs.
  s.db.query("DELETE FROM usage WHERE message_id = 'big'").run();
  const c = s.add();
  expect(s.start(c)).toEqual([{ key: KEY, value: S, mode: "try" }]);
  expect(why(c).what).toBe(`experiment: ${KEY} = ${S} (try)`);
  expect(why(c).why).toContain("context feature/m; in force " + S);
});

test("budget.learning: tickets on a value other than the one in force spend from it, and once it's spent experiments stop", () => {
  const s = setup("  warmup_tickets: 0\n", "budget:\n  learning: 5k/1M\n");
  const a = s.add();
  s.start(a, () => 0);
  s.db.query("UPDATE experiment_pulls SET value = ?, explored = 1 WHERE ticket = ?").run(JSON.stringify(H), a);
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('x', ?, ?, 'm', 6000, 0, 0, 0, 1, 0)").run(a, NOW);
  const b = s.add();
  expect(s.start(b)).toEqual([]);
  const m = learningMetrics(s.db, s.repo, new Date(NOW));
  expect(m.hold).toContain("budget.learning is spent");
  expect(m.budget).toEqual({ spent: { input: 6000, output: 1 }, cap: { input: 5000, output: 1_000_000 } });
  // The day's total counts those tokens once: they are work usage that learning pays for.
  expect(tokensToday(s.db, new Date(NOW))).toEqual({ input: 6000, output: 1 });
});

test("a ticket's settings are fixed at its start: a shift while it runs, or a restart, doesn't change them", () => {
  const s = setup();
  const a = s.add();
  s.start(a, () => 0.5);
  const before = s.settings(a);
  expect(before).toEqual({ [KEY]: S });
  setOverride(s.db, { key: KEY, value: H, tunable: [KEY], now: NOW });
  expect(s.start(a)).toEqual([]); // a restart keeps its arm
  expect(s.settings(a)).toEqual(before);
  // Contexts are the blueprint and the size bucket.
  expect([sizeOf(1_000_000, 3_000_000), sizeOf(3_000_000, 3_000_000), sizeOf(9_000_000, 3_000_000)]).toEqual(["s", "m", "l"]);
  const b = s.add({ blueprint: "bugfix", budget: 900_000 });
  s.start(b);
  expect((s.db.query("SELECT context FROM experiment_pulls WHERE ticket = ?").get(b) as { context: string }).context).toBe("bugfix/s");
  // A factory request is never an experiment.
  const r = s.add({ blueprint: "factory" });
  expect(s.start(r)).toEqual([]);
});

test("the outcome is recorded when the PR merges (through finishPr): the target, first try, and a revert found later", () => {
  const s = setup();
  const t = s.add();
  s.start(t);
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('u', ?, ?, 'm', 1, 0, 0, 0, 1, 2.5)").run(t, NOW);
  const run: Run = (argv) => ({ code: 0, out: argv.join(" ") });
  finishPr(s.db, { repo: s.repo, id: t, run, now: NOW, state: "merged", why: "on GitHub", who: "daemon" });
  expect(s.db.query("SELECT outcome, target, metric, first_try, outcome_at FROM experiment_pulls WHERE ticket = ?").get(t))
    .toEqual({ outcome: "merged", target: "cost_per_pr", metric: 2.5, first_try: 1, outcome_at: NOW });
  s.db.query("UPDATE tickets SET reverted_by = 99 WHERE id = ?").run(t);
  expect(armStats(s.db, KEY, "feature/m", "cost_per_pr", [S])[0]).toMatchObject({ n: 1, mean: 2.5, revert_rate: 1 });
  // A closed ticket's outcome has no metric and doesn't count.
  const c = s.add();
  s.start(c);
  s.finish(c, { usd: 9, state: "closed" });
  expect(s.db.query("SELECT outcome, metric FROM experiment_pulls WHERE ticket = ?").get(c)).toEqual({ outcome: "closed", metric: null });
});

test("the winner becomes an override, with a shift and a decision; promotion follows; your undo is respected", () => {
  const s = setup("  warmup_tickets: 0\n  promote_after: 2\n", "  arms:\n    agents.builder.model: [haiku]\n");
  let shift: unknown[] = [];
  for (let i = 0; i < 3; i++) { s.run(S, { usd: 3 }); shift = s.run(H, { usd: 1 }).shift; }
  expect(shift).toEqual([{ key: KEY, from: S, to: H, override: 1 }]);
  expect(activeOverrides(s.db).map((o) => [o.key, o.value])).toEqual([[KEY, H]]);
  expect(activeOverrides(s.db)[0].reason).toContain("experiment: cost_per_pr in feature/m");
  expect(s.db.query("SELECT what FROM decisions WHERE who = 'learner' AND ticket IS NULL").all()).toEqual([{ what: `shifted ${KEY} to ${H} (override #1)` }]);
  const m = learningMetrics(s.db, s.repo, new Date(NOW));
  expect(m.shifts).toEqual([expect.objectContaining({ at: NOW, key: KEY, context: "feature/m", from: S, to: H, override: 1 })]);
  expect(m.overrides).toEqual([expect.objectContaining({ id: 1, key: KEY, value: H, from_experiment: true })]);
  expect(m.experiments[0]).toMatchObject({ current: H, file: S, winner: H, outcomes: 6 });
  expect(validateMetrics({ ranges: {}, learning: m })).toEqual([]);
  // Tickets that held it count toward promotion, which files the maintainer request.
  s.db.query("UPDATE tickets SET settings = ? WHERE state = 'merged'").run(JSON.stringify({ [KEY]: H }));
  const filed = promoteOverrides(s.db, { dir: s.dir, repo: s.repo, slug: "acme/api", run: () => ({ code: 1, out: "stubbed" }), now: NOW });
  expect(filed[0].title).toContain(`Make ${KEY} = "${H}" permanent`);
  // Sonnet now loses on cost again (it's haiku that is in force): no shift back while haiku wins.
  expect(s.run(S, { usd: 5 }).shift).toEqual([]);
  // You undo the override; sonnet is in force again, and the learner won't move it back to haiku.
  undoOverride(s.db, KEY, "2026-11-22T13:00:00.000Z");
  expect(s.run(H, { usd: 0.5 }).shift).toEqual([]);
  expect(activeOverrides(s.db)).toEqual([]);
});
