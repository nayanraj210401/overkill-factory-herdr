// The learner agent (learner.ts, learner.md): its digest, its schedule and holds, its
// budget, and its proposals becoming maintainer requests. claude, gh and hc are stubbed.
import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import type { Run } from "./runner.ts";
import { addLesson, setOverride } from "./learn.ts";
import { request } from "./maintainer.ts";
import { tokensToday } from "./budget.ts";
import { learnerDigest, learnerDue, learnerHold, learningCap, learningSpent, parseProposals, runLearner } from "./learner.ts";
import { validateFile } from "./validate.ts";

// Each test gets its own FACTORY_HOME; put the preload's back so other files never see one with agents in it.
const HOME0 = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = HOME0; });
const NOW = "2026-11-22T12:00:00.000Z";
const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

function setup(yaml = "") {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-")); // no account config, no plan reading
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${yaml}`);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  const say = { out: JSON.stringify({ type: "result", result: "NONE", usage: { input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }, total_cost_usd: 0.01 }), code: 0 };
  const run: Run = (argv) => {
    calls.push(argv);
    if (argv[0] === "claude") return { code: say.code, out: say.out };
    return { code: 1, out: `${argv[0]} is stubbed` };
  };
  let id = 100;
  // A finished work ticket, with the settings it ran on, its cost and whether it was reverted.
  const ticket = (o: { settings?: object; usd?: number; state?: string; reverted?: boolean } = {}) => {
    const t = ++id;
    db.query("INSERT INTO tickets (id, title, state, blueprint, settings, reverted_by, updated_at) VALUES (?, 'x', ?, 'feature', ?, ?, ?)")
      .run(t, o.state ?? "merged", JSON.stringify(o.settings ?? {}), o.reverted ? 900 + t : null, NOW);
    if (o.usd != null) db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, ?, ?, 'm', 1, 0, 0, 0, 1, ?)").run(`m${t}`, t, NOW, o.usd);
    return t;
  };
  const many = (n: number, o: Parameters<typeof ticket>[0] = {}) => Array.from({ length: n }, () => ticket(o));
  const answer = (text: string) => { say.out = JSON.stringify({ type: "result", result: text, usage: { input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }, total_cost_usd: 0.01 }); };
  const go = (now = NOW, force = false) => runLearner(db, { dir, repo, slug: "acme/api", run, now, force });
  return { db, dir, repo, calls, say, ticket, many, answer, go };
}

test("the digest: outcomes by setting value, the target's trend, reverts, lessons, repeated comments and open requests", () => {
  const s = setup("learn:\n  target: cost_per_pr\n  tunable: [agents.builder.model]\n  review_every: 2\n");
  s.ticket({ usd: 4 });
  s.ticket({ usd: 6, reverted: true });
  const a = s.ticket({ settings: { "agents.builder.model": "claude-haiku-5-5" }, usd: 1 });
  const b = s.ticket({ settings: { "agents.builder.model": "claude-haiku-5-5" }, usd: 3 });
  s.ticket({ state: "closed" });
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (1, 'Raise the budget', 'queued', 'factory', ?)").run(NOW);
  setOverride(s.db, { key: "agents.builder.model", value: "claude-haiku-5-5", reason: "cheaper", tunable: ["agents.builder.model"], now: NOW });
  addLesson(s.db, { area: "src/auth/**", text: "rotate the session id after login", now: NOW });
  for (const [t, n] of [[a, 1], [b, 1], [a, 2]] as const)
    s.db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, body, at) VALUES (?, ?, 1, ?, 'th', 'sam', ?, ?)").run(t, n, `g${t}${n}`, n === 2 ? "Something else." : "Please add a test for this!", NOW);

  const d = learnerDigest(s.db, s.repo);
  expect(Object.keys(d)).toEqual(["target", "tickets", "trend", "settings", "overrides", "lessons", "repeated_comments", "open_requests"]);
  expect(d.target).toBe("cost_per_pr");
  expect(d.tickets).toEqual({ finished: 5, merged: 4, reverted: 1, revert_rate: 0.25 });
  expect(d.trend).toEqual([{ tickets: "#101–#102", value: 5, n: 2 }, { tickets: `#${a}–#${b}`, value: 2, n: 2 }]);
  expect(d.settings).toEqual([
    { key: "agents.builder.model", value: "(file)", tickets: 3, merged: 2, reverted: 1, target: 5 },
    { key: "agents.builder.model", value: '"claude-haiku-5-5"', tickets: 2, merged: 2, reverted: 0, target: 2 },
  ]);
  expect(d.overrides).toEqual([{ id: 1, key: "agents.builder.model", value: '"claude-haiku-5-5"', since: "2026-11-22", reason: "cheaper" }]);
  expect(d.lessons.map((l) => l.text)).toEqual(["rotate the session id after login"]);
  expect(d.repeated_comments).toEqual([{ text: "Please add a test for this!", times: 2, tickets: 2 }]);
  expect(d.open_requests).toEqual([{ id: 1, title: "Raise the budget", from: "you" }]);
});

test("a run sends learner.md's prompt and model with the digest; each proposal becomes one learner request, deduped against open ones", () => {
  const s = setup("learn: { warmup_tickets: 2 }\n");
  s.many(2, { usd: 2 });
  request(s.db, { text: "Add a lint rule for missing tests", repo: "acme/api", run: () => ({ code: 1, out: "" }), now: NOW }); // yours, open
  s.answer([
    "**PROPOSAL:** Give the reviewer the diff stat first",
    "WHY: review_rounds_per_pr 2.1 -> 1.4 over 12 tickets",
    "PROPOSAL: add a lint rule for missing tests.",
    "WHY: the same comment on 4 PRs",
    "PROPOSAL: a proposal with no evidence",
    "",
  ].join("\n"));
  const r = s.go();
  expect(r).toMatchObject({ ran: true, status: "done" });
  const call = s.calls.find((c) => c[0] === "claude")!;
  expect(call.slice(0, 6)).toEqual(["claude", "-p", "--model", "claude-sonnet-5-5", "--output-format", "json"]);
  expect(call[6]).toContain("You are the learner");
  expect(call[6]).toContain("Write a file");
  expect(call[6]).toContain("PROPOSAL: <the change, in one sentence>");
  expect(call[6]).toContain('"target":"cost_per_pr"');
  // One request filed; the open one isn't asked again; a proposal without WHY is dropped.
  expect(r.filed.map((f) => f.title)).toEqual(["Give the reviewer the diff stat first"]);
  expect(r.skipped).toEqual(["add a lint rule for missing tests."]);
  const t = s.db.query("SELECT blueprint, trigger_name FROM tickets WHERE id = ?").get(r.filed[0].id);
  expect(t).toEqual({ blueprint: "factory", trigger_name: "learner" });
  const md = readFileSync(join(s.dir, "tickets", String(r.filed[0].id), "REQUEST.md"), "utf8");
  expect(md).toContain("From: the learner");
  expect(md).toContain("- review_rounds_per_pr 2.1 -> 1.4 over 12 tickets");
  expect(md).toContain("From learner run #1 on 2026-11-22 (claude-sonnet-5-5), over the newest 2 finished tickets; learn.target: cost_per_pr.");
  // The next run proposing the same thing files nothing while that request is open.
  const again = s.go(NOW, true);
  expect(again.filed).toEqual([]);
  expect(again.skipped).toContain("Give the reviewer the diff stat first");
  // The run is recorded with what it spent.
  expect(s.db.query("SELECT status, tokens_in, tokens_out, usd, proposals, filed FROM learner_runs WHERE id = 1").get())
    .toEqual({ status: "done", tokens_in: 1200, tokens_out: 50, usd: 0.01, proposals: 2, filed: String(r.filed[0].id) });
});

test("~/.factory/agents/learner.md replaces the shipped one", () => {
  const s = setup("learn: { warmup_tickets: 0 }\n");
  mkdirSync(join(process.env.FACTORY_HOME!, "agents"));
  writeFileSync(join(process.env.FACTORY_HOME!, "agents/learner.md"), "---\nrole: learn\nmodel: haiku\n---\nZQ-OWN-LEARNER words.\n");
  s.go();
  const call = s.calls.find((c) => c[0] === "claude")!;
  expect(call[3]).toBe("claude-haiku-5-5");
  expect(call[6]).toContain("ZQ-OWN-LEARNER words.");
  expect(call[6]).not.toContain("You are the learner");
  expect(validateFile("agents/learner.md", readFileSync(join(process.env.FACTORY_HOME!, "agents/learner.md"), "utf8"))).toEqual([]);
});

test("an answer outside the format is unreadable: no request, and the run is recorded as such", () => {
  expect(parseProposals("NONE")).toEqual([]);
  expect(parseProposals("Here are my thoughts: the reviewer is slow.")).toBeNull();
  expect(parseProposals("PROPOSAL: x")).toBeNull(); // no WHY, no NONE
  expect(parseProposals("- PROPOSAL: x\n- WHY: y")).toEqual([{ change: "x", why: "y" }]);
  const s = setup("learn: { warmup_tickets: 0 }\n");
  s.answer("I would change the reviewer's model to haiku.");
  expect(s.go()).toMatchObject({ ran: true, status: "unreadable", filed: [] });
  // Not JSON at all: read as text, its tokens estimated so the budget still counts them.
  s.say.out = "PROPOSAL: y\nWHY: z";
  const r = s.go(NOW, true);
  expect(r.status).toBe("done");
  expect((s.db.query("SELECT tokens_in FROM learner_runs WHERE id = 2").get() as any).tokens_in).toBeGreaterThan(100);
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets WHERE blueprint = 'factory'").get()).toEqual({ n: 1 });
  // A failing call is recorded as failed and waits an hour before trying again.
  s.say.code = 1; s.say.out = "rate limited";
  s.many(10);
  expect(s.go(at(DAY_MS))).toMatchObject({ ran: true, status: "failed" });
  expect(learnerDue(s.db, s.repo, new Date(at(DAY_MS + HOUR / 2)))).toMatchObject({ due: false, why: expect.stringContaining("failed") });
  expect(learnerDue(s.db, s.repo, new Date(at(DAY_MS + HOUR)))).toMatchObject({ due: true });
});
const DAY_MS = 24 * HOUR;

test("the schedule: after warmup, every learn.review_every merged tickets, and daily when anything merged", () => {
  const s = setup("learn: { warmup_tickets: 3, review_every: 4 }\n");
  s.many(2);
  s.ticket({ state: "closed" }); // closed tickets don't count toward warmup
  expect(learnerHold(s.db, s.repo, new Date(NOW))).toBe("warming up: 2 of learn.warmup_tickets 3 tickets merged, so only logging");
  expect(s.go()).toMatchObject({ ran: false, why: expect.stringContaining("warming up") });
  expect(s.calls).toEqual([]);
  s.ticket();
  expect(learnerDue(s.db, s.repo, new Date(NOW))).toEqual({ due: true, why: "first run" });
  expect(s.go()).toMatchObject({ ran: true });
  expect(learnerDue(s.db, s.repo, new Date(at(DAY_MS)))).toEqual({ due: false, why: "nothing merged since the last run" });
  s.many(3);
  expect(learnerDue(s.db, s.repo, new Date(at(HOUR)))).toEqual({ due: false, why: "ran less than a day ago" });
  expect(learnerDue(s.db, s.repo, new Date(at(DAY_MS)))).toEqual({ due: true, why: "daily run" });
  s.ticket();
  expect(learnerDue(s.db, s.repo, new Date(at(HOUR)))).toEqual({ due: true, why: "4 tickets merged since the last run (learn.review_every 4)" });
  // Not due: no call at all.
  s.go(at(HOUR));
  const n = s.calls.length;
  expect(s.go(at(2 * HOUR))).toMatchObject({ ran: false });
  expect(s.calls.length).toBe(n);
});

test("learn.pause_above holds the run when the day's budget is past it", () => {
  const s = setup("budget: { per_day: { input: 1000, output: 1000 }, learning: 50% }\nlearn: { warmup_tickets: 0, pause_above: 60% }\n");
  const t = s.ticket({ state: "closed" });
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('u1', ?, ?, 'm', 650, 0, 0, 0, 1, 0)").run(t, NOW);
  expect(learnerHold(s.db, s.repo, new Date(NOW))).toBe("the day's budget is at 65%, past learn.pause_above 60%");
  expect(s.go()).toMatchObject({ ran: false, why: expect.stringContaining("pause_above") });
  expect(s.calls).toEqual([]);
});

test("budget.learning: a share of the day's budget or tokens, charged with each run, and the day's tokens include it", () => {
  expect(learningCap(setup("budget: { per_day: { input: 40M, output: 2M } }\n").repo)).toEqual({ input: 4_000_000, output: 200_000 }); // 10% by default
  expect(learningCap(setup("budget: { per_day: { input: 40M, output: 2M }, learning: 25% }\n").repo)).toEqual({ input: 10_000_000, output: 500_000 });
  expect(learningCap(setup("budget: { learning: 2M/100k }\n").repo)).toEqual({ input: 2_000_000, output: 100_000 });
  expect(learningCap(setup("budget: { learning: 10% }\n").repo)).toBeNull(); // a share of no cap

  const s = setup("budget: { learning: 3000/1000 }\nlearn: { warmup_tickets: 0, pause_above: 100% }\n");
  expect(s.go()).toMatchObject({ ran: true });
  expect(learningSpent(s.db, new Date(NOW))).toEqual({ input: 1200, output: 50 });
  expect(tokensToday(s.db, new Date(NOW))).toEqual({ input: 1200, output: 50 });
  expect(s.go(NOW, true)).toMatchObject({ ran: true }); // 2400 spent
  // The next prompt wouldn't fit in what's left of the 3000.
  const r = s.go(NOW, true);
  expect(r).toMatchObject({ ran: false, why: expect.stringContaining("budget.learning is spent for today") });
  expect(s.calls.filter((c) => c[0] === "claude")).toHaveLength(2);
  // A new day, a new allowance.
  expect(learnerHold(s.db, s.repo, new Date(at(DAY_MS)))).toBeNull();
});

test("factory.yaml's learn.review_every validates", () => {
  expect(validateFile("factory.yaml", "name: t\nlearn: { review_every: 10 }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: t\nlearn: { review_every: often }\n").join()).toContain("review_every");
});
