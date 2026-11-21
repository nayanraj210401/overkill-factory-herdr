import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { startGroomed } from "./groom.ts";
import { estimateBudget, startHold } from "./budget.ts";
import { buildStatus } from "./status.ts";
import { setPlan } from "./metrics.ts";
import { validateDir } from "./validate.ts";

const now = "2026-11-21T10:00:00Z";

function setup(extra = "") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\n${extra}`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let n = 0;
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: `{"address":"t${++n}"}` } : sh(argv, cwd));
  const add = (id: number, blueprint = "feature") => db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, 'Wire it', ?, ?)").run(id, blueprint, now);
  const use = (id: string, input: number, output: number, at = now) =>
    db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, 1, ?, 'm', ?, 0, 0, 0, ?, 0)").run(id, at, input, output);
  return { db, dir, repo, run, add, use, ticket: (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any };
}

test("the day's token cap holds every kind of start, and says why", () => {
  const { db, dir, repo, run, add, use, ticket } = setup("budget:\n  per_day: { input: 1M, output: 100k }\n");
  add(1); add(2);
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at, state, groomed_at) VALUES (3, 'Groomed', 'feature', ?, 'queued', ?)").run(now, now);
  use("a", 900_000, 50_000);
  expect(startHold(db, repo, new Date(now))).toBeNull();
  use("b", 100_000, 0);
  expect(startHold(db, repo, new Date(now))).toBe("daily budget reached (1M/1M in)");
  expect(() => startTicket(db, { dir, repo, id: 1, run, now })).toThrow("#1 waits: daily budget reached");
  expect(ticket(1).state).toBe("queued");
  const logged: string[] = [];
  expect(startGroomed(db, { dir, repo, run, now, log: (x) => logged.push(x) })).toEqual([]);
  expect(logged).toEqual([]); // held quietly, not a failed start every tick
  expect(ticket(3).state).toBe("queued");
  expect(buildStatus(db, new Date(now)).plan.hold).toBe("daily budget reached (1M/1M in)");
  // Tomorrow's tokens are a fresh day.
  expect(startHold(db, repo, new Date("2026-11-22T10:00:00Z"))).toBeNull();
});

test("plan.pause_at holds starts when the 5-hour window passes it, and is ignored with no plan data", () => {
  const { db, repo, use, add } = setup("plan:\n  pause_at: 85%\n");
  add(1);
  use("a", 870, 0);
  const at = new Date(now);
  expect(startHold(db, repo, at)).toBeNull(); // no plan limits known
  setPlan(db, 1000, 10000);
  expect(startHold(db, repo, at)).toMatch(/^5-hour window at 87%, resets \d\d:\d\d$/);
  setPlan(db, 2000, 10000);
  expect(startHold(db, repo, at)).toBeNull(); // 43%
});

test("a running ticket at its budget parks at the stage boundary; at 80% status.json warns", () => {
  const { db, dir, repo, run, add, ticket } = setup();
  add(7);
  db.query("UPDATE tickets SET budget_in = 1000, budget_out = 100 WHERE id = 7").run();
  startTicket(db, { dir, repo, id: 7, run, now });
  db.query("UPDATE tickets SET tokens_in = 799 WHERE id = 7").run();
  expect(buildStatus(db, new Date(now)).tickets[0].warning).toBeNull();
  db.query("UPDATE tickets SET tokens_in = 850 WHERE id = 7").run();
  expect(buildStatus(db, new Date(now)).tickets[0].warning).toBe("85% of its token budget used");
  db.query("UPDATE tickets SET tokens_in = 1000 WHERE id = 7").run();
  expect(advance(db, { dir, repo, id: 7, run, now })).toMatchObject({ parked: true });
  expect(ticket(7)).toMatchObject({ state: "parked", needs_kind: "parked" });
  expect(ticket(7).needs_text).toBe("Budget used up (1k/1k in, 0/100 out). Raise the budget or drop the ticket");
});

test("grooming sets the budget from merged tickets on the blueprint times headroom, else per_ticket", () => {
  const { db, dir, repo, run, add } = setup("max_running: 0\nbudget:\n  per_ticket: { input: 2M, output: 80k }\n  headroom: 2\n");
  expect(estimateBudget(db, repo, "feature")).toEqual({ input: 2e6, output: 80e3 }); // no history
  for (const [id, i, o, bp] of [[1, 1000, 100, "feature"], [2, 3000, 300, "feature"], [3, 99999, 9999, "chore"]] as const) {
    add(id, bp);
    db.query("UPDATE tickets SET state = 'merged', tokens_in = ?, tokens_out = ? WHERE id = ?").run(i, o, id);
  }
  expect(estimateBudget(db, repo, "feature")).toEqual({ input: 4000, output: 400 });
  // The groomed step applies it, unless you set the budget yourself while it was groomed.
  add(10); add(11);
  db.query("UPDATE tickets SET state = 'grooming' WHERE id IN (10, 11)").run();
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (11, 'you', 'set the budget to 9M', ?)").run(now);
  for (const id of [10, 11]) advance(db, { dir, repo, id, run, now });
  const budget = (id: number) => db.query("SELECT budget_in, budget_out FROM tickets WHERE id = ?").get(id);
  expect(budget(10)).toEqual({ budget_in: 4000, budget_out: 400 });
  expect(budget(11)).toEqual({ budget_in: 3_000_000, budget_out: 150_000 });
});

test("factory.yaml's budget and plan keys validate; a typo is an error", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  const check = (yaml: string) => { writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${yaml}`); return validateDir(join(repo, ".factory")).flatMap((f) => f.errors.map((e) => `${f.path}: ${e}`)); };
  expect(check("budget:\n  per_ticket: { input: 3M, output: 150k }\n  headroom: 1.5\n  per_day: { input: 40M, output: 2M }\nplan:\n  pause_at: 85%\n")).toEqual([]);
  expect(check("budget:\n  perday: { input: 1M }\n").join("\n")).toContain("perday");
});
