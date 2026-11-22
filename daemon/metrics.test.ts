import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { buildStatus } from "./status.ts";
import { buildMetrics, findReverts, setPlan } from "./metrics.ts";
import type { Run } from "./runner.ts";

const db0 = () => open(join(mkdtempSync(join(tmpdir(), "metrics-")), "factory.db"));
const use = (db: ReturnType<typeof open>, id: string, at: string, input: number, output: number) =>
  db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, 1, ?, 'm', ?, 0, 0, 999, ?, 0)").run(id, at, input, output);

test("plan meters: the last 5 hours' and 7 days' tokens against your limits; 0 until you set them", () => {
  const db = db0();
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (1, 'x', '2026-11-21T10:00:00Z')").run();
  const now = new Date("2026-11-21T12:00:00Z");
  use(db, "a", "2026-11-21T11:00:00Z", 1_000_000, 0);   // in the 5h window (cache reads don't count)
  use(db, "b", "2026-11-21T06:00:00Z", 2_000_000, 0);   // only in the week
  use(db, "c", "2026-11-10T00:00:00Z", 9_000_000, 0);   // neither
  expect(buildStatus(db, now).plan).toEqual({ window_5h: 0, week: 0, source: "none", as_of: null, hold: null });
  setPlan(db, 10_000_000, 30_000_000);
  expect(buildStatus(db, now).plan).toEqual({ window_5h: 0.1, week: 0.1, source: "estimate", as_of: null, hold: null });
});

test("interactions per PR count your steps before it opened; the revert rate counts reverted merges", () => {
  const db = db0();
  const now = new Date();
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60000).toISOString();
  setRepo(db, { slug: "acme/api", path: "/tmp", lead: true });
  for (const id of [1, 2]) { db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (?, 'x', 'merged', ?)").run(id, at(0)); setWork(db, id, { pr_number: 40 + id }); }
  const decide = (ticket: number, who: string, what: string, m: number) => db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(ticket, who, what, at(m));
  decide(1, "you", "added issue #1", 50); decide(1, "you", "answered Q1", 40); decide(1, "you", "set the budget to 5M", 30);
  decide(1, "daemon", "opened PR #41", 20); decide(1, "you", "sent PR #41 back", 10); decide(1, "you", "merged PR #41", 5);
  decide(2, "daemon", "opened PR #42", 20); decide(2, "you", "merged PR #42", 5);
  const today = buildStatus(db, now).today;
  expect(today.interactions_per_pr).toBe(1); // (2 + 0) / 2
  expect(today.revert_rate).toBe(0);
  const calls: string[][] = [];
  const run: Run = (argv) => (calls.push(argv), { code: 0, out: JSON.stringify([{ number: 50, body: "Reverts acme/api#42\n\nBroke login." }, { number: 51, body: "Reverts acme/api#410" }]) });
  expect(findReverts(db, { repo: "acme/api", run, now: at(0) })).toEqual([2]);
  expect(calls[0].slice(0, 7)).toEqual(["gh", "pr", "list", "--repo", "acme/api", "--state", "merged"]);
  expect(buildStatus(db, now).today.revert_rate).toBe(0.5);
  expect(findReverts(db, { repo: "acme/api", run, now: at(0) })).toEqual([]); // #41 wasn't reverted; #42 is known
});

test("metrics.json: medians, merges per day, spend by stage and model, quality by blueprint, against the week before", () => {
  const db = db0();
  const now = new Date("2026-11-21T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
  const ticket = (id: number, bp: string, began: number, pr: number, merged: number | null, reverted = false) => {
    db.query("INSERT INTO tickets (id, title, blueprint, state, reverted_by, retries, updated_at) VALUES (?, 'x', ?, ?, ?, 1, ?)").run(id, bp, merged != null ? "merged" : "ready", reverted ? 99 : null, at(0));
    db.query("INSERT INTO stages (ticket, name, started_at) VALUES (?, 'Spec', ?)").run(id, at(began));
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(id, `opened PR #${id}`, at(pr));
    if (merged != null) db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(id, `merged PR #${id}`, at(merged));
  };
  ticket(1, "feature", 10, 9, 5);        // 1h to PR, 4h PR → merge
  ticket(2, "feature", 30, 27, 26, true); // 3h to PR, reverted
  ticket(3, "chore", 200, 199, 198);     // the week before: 1h
  db.query("INSERT INTO sessions (id, ticket, stage, argv, started_at) VALUES (1, 1, 'implement', '[]', ?)").run(at(10));
  db.query("INSERT INTO usage (message_id, ticket, session, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('m', 1, 1, ?, 'claude-sonnet-5-5', 0, 0, 0, 0, 0, 3)").run(at(9));
  const r = (buildMetrics(db, now).ranges as any)["7"];
  expect(r.headline.time_to_pr_min).toEqual([120, 60]);
  expect(r.headline.revert_rate).toEqual([0.5, 0]);
  expect(r.headline.cost_per_pr_usd).toEqual([1.5, 0]);
  expect(r.cycle).toEqual({ pickup_to_pr_min: 120, pr_to_merge_min: 150, pickup_to_merge_min: 270 });
  expect(r.days).toHaveLength(7);
  expect(r.merged_per_day.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  expect(r.usd_by_stage).toEqual([{ name: "implement", usd: 3 }]);
  expect(r.usd_by_model).toEqual([{ name: "claude-sonnet-5-5", usd: 3 }]);
  expect(r.quality).toEqual([{ blueprint: "feature", merged: 2, reverted: 1, retries_per_ticket: 1 }]);
  // Per day for the charts: null where nothing happened, so the line breaks instead of reading 0.
  expect(r.days.at(-1)).toBe("2026-11-21");
  expect(r.opened_per_day).toEqual([0, 0, 0, 0, 0, 1, 1]);
  expect(r.time_to_pr_per_day).toEqual([null, null, null, null, null, 180, 60]);
  expect(r.revert_rate_per_day).toEqual([null, null, null, null, null, 1, 0]);
  expect(r.first_try_per_day).toEqual([null, null, null, null, null, 0, 0]); // both retried once
  expect(r.usd_by_agent_per_day).toEqual([{ name: "implement", values: [0, 0, 0, 0, 0, 0, 3] }]); // no agent named: its stage
  expect(r.usd_by_model_per_day).toEqual([{ name: "claude-sonnet-5-5", values: [0, 0, 0, 0, 0, 0, 3] }]);
  expect(r.tokens_in_cap).toBeNull();
  expect((buildMetrics(db, now, 4e7).ranges as any)["7"].tokens_in_cap).toBe(4e7);
});
