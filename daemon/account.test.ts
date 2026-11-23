import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { readAccount, profileText } from "./account.ts";
import { pauseAt, startHold, tokensToday } from "./budget.ts";
import { planMeters } from "./metrics.ts";
import { awayPolicy } from "./away.ts";
import { brief } from "./runner.ts";
import { validateAccount } from "./validate.ts";

const before = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = before; });

// A fresh FACTORY_HOME with this config.yaml, and a repo whose factory.yaml says `own`.
function account(yaml: string, own = "") {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  process.env.FACTORY_HOME = home;
  writeFileSync(join(home, "config.yaml"), yaml);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${own}`);
  return { home, repo };
}

function factory(home: string, name: string, tokensIn: number, at = "2026-11-22T09:00:00Z") {
  mkdirSync(join(home, name), { recursive: true });
  const db = open(join(home, name, "factory.db"));
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (1, 't', ?)").run(at);
  db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, 1, ?, 'm', ?, 0, 0, 0, 10, 0)").run(`${name}-1`, at, tokensIn);
  return db;
}

test("config.yaml is checked: unknown keys and wrong types are errors, and a bad file refuses to load", () => {
  expect(validateAccount("plan: { pause_at: 85% }\nbudget: { per_day: { input: 40M } }\nprofile: { taste: [small diffs] }\n")).toEqual([]);
  expect(validateAccount("budgets: {}\n")[0]).toContain("budgets: unknown key");
  expect(validateAccount("profile: { taste: small diffs }\n")[0]).toContain("profile.taste");
  account("plan: { pauseat: 85% }\n");
  expect(() => readAccount()).toThrow("plan.pauseat: unknown key");
});

test("with no config.yaml nothing changes", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "fh-"));
  expect(readAccount()).toEqual({});
  expect(profileText()).toBe("");
});

test("plan.pause_at: factory.yaml's wins, else the account's", () => {
  const { repo } = account("plan: { pause_at: 70% }\n");
  expect(pauseAt(repo)).toBe(0.7);
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nplan: { pause_at: 90% }\n");
  expect(pauseAt(repo)).toBe(0.9);
});

test("budget.per_day in config.yaml holds starts once every factory together reaches it", () => {
  const { home, repo } = account("budget: { per_day: { input: 1M } }\n");
  const now = new Date("2026-11-22T12:00:00Z");
  const a = factory(home, "a", 600_000);
  factory(home, "b", 300_000).close();
  factory(home, "old", 900_000, "2026-11-21T09:00:00Z").close(); // yesterday's: not counted
  expect(tokensToday(a, now)).toEqual({ input: 600_000, output: 10 });
  expect(tokensToday(a, now, true)).toEqual({ input: 900_000, output: 20 });
  expect(startHold(a, repo, now)).toBe(null);
  factory(home, "c", 200_000).close();
  expect(startHold(a, repo, now)).toBe("account's daily budget reached (1.1M/1M in, every factory)");
});

test("plan.limits are the estimate's fallback; `factory plan` on the factory still wins", () => {
  const { home } = account("plan: { limits: { five_hour: 1M, week: 10M } }\n");
  const now = new Date("2026-11-22T09:30:00Z");
  const db = factory(home, "a", 500_000);
  expect(planMeters(db, now)).toMatchObject({ source: "estimate", window_5h: 0.5, week: 0.05 });
  setMeta(db, "plan_5h", "2000000");
  expect(planMeters(db, now).window_5h).toBe(0.25);
});

test("away: the account's policy under the factory's, key by key", () => {
  const { repo } = account("away: { blueprints: [chore], review_rounds: 2 }\n", "away: { review_rounds: 1 }\n");
  expect(awayPolicy(repo)).toEqual({ blueprints: ["chore"], review_rounds: 1 });
});

test("profile: your rules and taste go into every stage brief; none, no paragraph", () => {
  account("profile: { rules: [never push to main], taste: [small diffs over clever ones] }\n");
  const text = brief({ id: 1, title: "t" }, "spec", "P", "/f");
  expect(text).toContain("Your person's rules and taste, for every ticket:\n- never push to main\n- small diffs over clever ones");
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "fh-"));
  expect(brief({ id: 1, title: "t" }, "spec", "P", "/f")).not.toContain("rules and taste");
});
