import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// A fake triager that finishes: its last step is GROOMING.md in the folder it runs in.
const triaged = (argv: string[]) => {
  if (argv.includes("factory.stage=groom") && argv.includes("--cwd")) writeFileSync(join(argv[argv.indexOf("--cwd") + 1], "GROOMING.md"), "groomed\n");
};

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
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (triaged(argv), { code: 0, out: `{"address":"t${++n}"}` }) : sh(argv, cwd));
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

const merged = (db: any, add: any, id: number, i: number, o: number, bp = "feature", state = "merged") => {
  add(id, bp);
  db.query("UPDATE tickets SET state = ?, tokens_in = ?, tokens_out = ? WHERE id = ?").run(state, i, o, id);
};

test("grooming sets the budget from merged tickets on the blueprint times headroom, else per_ticket", () => {
  const { db, dir, repo, run, add } = setup("max_running: 0\nbudget:\n  per_ticket: { input: 2M, output: 80k }\n  headroom: 2\n  floor: 0\n");
  expect(estimateBudget(db, repo, "feature")).toMatchObject({ input: 2e6, output: 80e3 }); // no history
  // feature has 10 stage runs (implement counts 3): the stage floor is 1.5M in, 80k out.
  for (const id of [1, 2, 3, 4]) merged(db, add, id, id * 1000, id * 100);
  merged(db, add, 5, 99999, 9999, "chore");
  expect(estimateBudget(db, repo, "feature")).toMatchObject({ input: 2e6, output: 80e3, why: "default: only 4 past feature tickets, need 5" });
  merged(db, add, 6, 5000, 500);
  const e = estimateBudget(db, repo, "feature")!;
  expect(e.why).toContain("p80 of 5 past feature tickets × 2");
  // The groomed step applies it, unless you set the budget yourself while it was groomed.
  add(10); add(11);
  db.query("UPDATE tickets SET state = 'grooming' WHERE id IN (10, 11)").run();
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (11, 'you', 'set the budget to 9M', ?)").run(now);
  for (const id of [10, 11]) {
    mkdirSync(join(dir, "tickets", String(id)), { recursive: true });
    writeFileSync(join(dir, "tickets", String(id), "GROOMING.md"), "groomed\n"); // triage finished
    advance(db, { dir, repo, id, run, now });
  }
  const budget = (id: number) => db.query("SELECT budget_in, budget_out FROM tickets WHERE id = ?").get(id);
  expect(budget(10)).toMatchObject({ budget_in: e.input, budget_out: e.output });
  expect(db.query("SELECT why FROM decisions WHERE ticket = 10 AND what LIKE 'set the budget to %'").get()).toEqual({ why: e.why });
  expect(budget(11)).toEqual({ budget_in: 3_000_000, budget_out: 150_000 });
});

test("a tiny past ticket never drags the budget under the floor; per-slice stages raise it", () => {
  const { db, repo, add } = setup("budget:\n  per_ticket: { input: 3M, output: 150k }\n  headroom: 1.5\n");
  for (const id of [1, 2, 3, 4, 5, 6]) merged(db, add, id, 20_000, 1_000);
  merged(db, add, 7, 20_000, 1_000, "feature", "parked"); // never reached a PR: not counted
  const e = estimateBudget(db, repo, "feature")!;
  expect(e).toMatchObject({ input: 1_500_000, output: 80_000 }); // 50% of per_ticket is 1.5M/75k; 10 stage runs need 80k out
  expect(e.why).toBe("p80 of 6 past feature tickets × 1.5, floor 1.5M in, 80k out");
  // Few tickets: the default, as is.
  expect(estimateBudget(db, repo, "chore")).toMatchObject({ input: 3e6, output: 150e3, why: "default: only 0 past chore tickets, need 5" });
  // A small per_ticket: the per-stage minimum times the stage runs (slices count 3) is the floor.
  const small = setup("budget:\n  per_ticket: { input: 100k, output: 10k }\n");
  const s = estimateBudget(small.db, small.repo, "feature")!;
  expect(s.input).toBe(150_000 * 10);
  expect(s.output).toBe(8_000 * 10);
});

test("enough history: p80 of input and output apart, times headroom", () => {
  const { db, repo, add } = setup("budget:\n  per_ticket: { input: 1M, output: 20k }\n  headroom: 1.5\n  floor: 10%\n");
  for (const [id, i] of [[1, 1e6], [2, 2e6], [3, 3e6], [4, 4e6], [5, 20e6]]) merged(db, add, id, i, i / 10, "chore");
  // p80 of 1M..20M input is 7.2M (interpolated), of 100k..2M output 720k; the mean would be 6M.
  expect(estimateBudget(db, repo, "chore")).toMatchObject({ input: 10_800_000, output: 1_080_000, why: "p80 of 5 past chore tickets × 1.5" });
});

test("factory.yaml's budget and plan keys validate; a typo is an error", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  const check = (yaml: string) => { writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${yaml}`); return validateDir(join(repo, ".factory")).flatMap((f) => f.errors.map((e) => `${f.path}: ${e}`)); };
  expect(check("budget:\n  per_ticket: { input: 3M, output: 150k }\n  headroom: 1.5\n  per_day: { input: 40M, output: 2M }\nplan:\n  pause_at: 85%\n")).toEqual([]);
  expect(check("budget:\n  floor: 50%\n")).toEqual([]);
  expect(check("budget:\n  floor: lots\n").join("\n")).toContain("budget.floor");
  expect(check("budget:\n  perday: { input: 1M }\n").join("\n")).toContain("perday");
});
