import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { buildStatus } from "./status.ts";
import { findReverts, setPlan } from "./metrics.ts";
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
  expect(buildStatus(db, now).plan).toEqual({ window_5h: 0, week: 0 });
  setPlan(db, 10_000_000, 30_000_000);
  expect(buildStatus(db, now).plan).toEqual({ window_5h: 0.1, week: 0.1 });
});

test("interactions per PR count your steps before it opened; the revert rate counts reverted merges", () => {
  const db = db0();
  const now = new Date();
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60000).toISOString();
  for (const id of [1, 2]) db.query("INSERT INTO tickets (id, title, state, pr_number, updated_at) VALUES (?, 'x', 'merged', ?, ?)").run(id, 40 + id, at(0));
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
