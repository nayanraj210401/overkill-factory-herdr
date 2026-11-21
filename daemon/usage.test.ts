import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { buildStatus } from "./status.ts";
import { codexHome, parseCodex, parseTranscript, recordUsage, transcriptDir, usd } from "./usage.ts";

const msg = (id: string, at: string, u: object, model = "claude-opus-5-5", type = "assistant") =>
  JSON.stringify({ type, timestamp: at, message: { id, model, usage: u } });
const U = (input: number, w1h: number, read: number, output: number) =>
  ({ input_tokens: input, cache_creation_input_tokens: w1h, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1h }, cache_read_input_tokens: read, output_tokens: output });

test("a transcript gives one entry per message (the last copy), skipping what isn't usage", () => {
  const text = [
    msg("m1", "2026-11-21T10:00:00Z", U(2, 100, 0, 10)),
    msg("m1", "2026-11-21T10:00:01Z", U(2, 100, 0, 338)), // the same message's next block: final count
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    msg("m2", "2026-11-21T10:01:00Z", { input_tokens: 5, cache_creation_input_tokens: 40, cache_read_input_tokens: 7, output_tokens: 3 }),
    msg("m3", "2026-11-21T10:02:00Z", U(1, 0, 0, 1), "<synthetic>"),
    '{"type":"assistant","message":{"id":"m4","usage":{"inp', // a line still being written
  ].join("\n");
  expect(parseTranscript(text)).toEqual([
    { id: "m1", at: "2026-11-21T10:00:01Z", model: "claude-opus-5-5", input: 2, w5m: 0, w1h: 100, read: 0, output: 338 },
    { id: "m2", at: "2026-11-21T10:01:00Z", model: "claude-opus-5-5", input: 5, w5m: 40, w1h: 0, read: 7, output: 3 }, // old shape: 5-minute writes
  ]);
});

test("dollars: input, 5m and 1h writes (1.25x, 2x), cache reads, output, per model", () => {
  const u = (model: string, o: Partial<{ input: number; w5m: number; w1h: number; read: number; output: number }>) =>
    usd({ id: "x", at: "", model, input: 0, w5m: 0, w1h: 0, read: 0, output: 0, ...o });
  expect(u("claude-opus-5-5", { input: 1e6, output: 1e6 })).toBe(24);
  expect(u("claude-opus-5-5", { w5m: 1e6, w1h: 1e6, read: 1e6 })).toBeCloseTo(5 + 8 + 0.2);
  expect(u("claude-sonnet-5-5", { read: 1e6, output: 1e6 })).toBeCloseTo(10.1);
  expect(u("claude-fable-5-2", { w5m: 1e6, w1h: 1e6 })).toBe(26); // $10 and $16, as listed
  expect(u("some-new-model", { input: 1e6 })).toBe(0);
});

test("the daemon records each ticket's usage by stage session, once, and today's numbers follow", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "usage-")), "factory.db"));
  const wt = "/work/trees/acme/factory-7-wire-it";
  db.query("INSERT INTO tickets (id, title, updated_at, state) VALUES (7, 'Wire it', '2026-11-21T09:00:00Z', 'running')").run();
  setRepo(db, { slug: "acme/api", path: wt, lead: true });
  setWork(db, 7, { worktree: wt });
  for (const [stage, at] of [["spec", "2026-11-21T09:00:00Z"], ["plan", "2026-11-21T09:30:00Z"]])
    db.query("INSERT INTO sessions (ticket, stage, argv, started_at) VALUES (7, ?, '[]', ?)").run(stage, at);
  db.query("INSERT INTO stages (ticket, name, started_at) VALUES (7, 'Spec', '2026-11-21T09:00:00Z')").run();
  const dir = transcriptDir(wt);
  expect(dir).toEndWith("/projects/-work-trees-acme-factory-7-wire-it");
  mkdirSync(join(dir, "s2/subagents"), { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), msg("a", "2026-11-21T09:10:00Z", U(1000, 1e5, 5e5, 2000)) + "\n");
  writeFileSync(join(dir, "s2.jsonl"), msg("b", "2026-11-21T09:40:00Z", U(500, 0, 0, 1000)) + "\n");
  writeFileSync(join(dir, "s2/subagents/agent-1.jsonl"), msg("c", "2026-11-21T09:41:00Z", U(100, 0, 0, 100), "claude-haiku-5-5") + "\n");
  const t = () => db.query("SELECT tokens_in, tokens_out, usd FROM ticket_lead").get() as any;
  recordUsage(db);
  recordUsage(db); // nothing changed: no double count
  expect(t()).toMatchObject({ tokens_in: 1000 + 1e5 + 500 + 100, tokens_out: 3100 });
  expect(t().usd).toBeCloseTo((1000 * 4 + 1e5 * 8 + 5e5 * 0.2 + 2000 * 20 + 500 * 4 + 1000 * 20 + 100 * 0.1 + 100 * 0.5) / 1e6);
  expect(db.query("SELECT stage, tokens_in, tokens_out FROM sessions ORDER BY id").all()).toEqual([
    { stage: "spec", tokens_in: 101000, tokens_out: 2000 },
    { stage: "plan", tokens_in: 600, tokens_out: 1100 }, // its sub-agent counts with it
  ]);
  appendFileSync(join(dir, "s2.jsonl"), msg("b", "2026-11-21T09:40:02Z", U(500, 0, 0, 1500)) + "\n"); // b's final copy
  recordUsage(db);
  expect(t().tokens_out).toBe(3600);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (7, 'daemon', 'opened PR #42', '2026-11-21T10:00:00Z')").run();
  const today = buildStatus(db, new Date("2026-11-21T12:00:00Z")).today;
  expect(today).toMatchObject({ time_to_pr_min: 60, tokens: { input: 101600, output: 3600 } });
  expect(today.cost_per_pr_usd).toBe(+t().usd.toFixed(2));
  expect(buildStatus(db, new Date("2026-11-22T12:00:00Z")).today).toMatchObject({ usd: 0, cost_per_pr_usd: 0, time_to_pr_min: 0 });
});

test("Codex sessions count for the ticket whose folder they ran in, one entry per change in the running total", () => {
  const ev = (at: string, t: object | null) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: t && { total_token_usage: t } } });
  const total = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
  const text = (cwd: string) => [
    JSON.stringify({ timestamp: "2026-11-21T10:00:00Z", type: "session_meta", payload: { id: "s1", cwd } }),
    JSON.stringify({ timestamp: "2026-11-21T10:00:01Z", type: "turn_context", payload: { cwd, model: "gpt-5.3-codex" } }),
    ev("2026-11-21T10:00:02Z", null),
    ev("2026-11-21T10:00:03Z", total(1000, 400, 50)),
    ev("2026-11-21T10:00:04Z", total(1000, 400, 50)), // repeated: no new entry
    ev("2026-11-21T10:01:00Z", total(2500, 1400, 80)),
  ].join("\n");
  expect(parseCodex(text("/w")).uses).toEqual([
    { id: "codex:s1:1", at: "2026-11-21T10:00:03Z", model: "gpt-5.3-codex", input: 600, w5m: 0, w1h: 0, read: 400, output: 50 },
    { id: "codex:s1:2", at: "2026-11-21T10:01:00Z", model: "gpt-5.3-codex", input: 500, w5m: 0, w1h: 0, read: 1000, output: 30 },
  ]);

  const db = open(join(mkdtempSync(join(tmpdir(), "usage-")), "factory.db"));
  const wt = mkdtempSync(join(tmpdir(), "wt-"));
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (5, 'x', '2026-11-21T09:00:00Z')").run();
  setRepo(db, { slug: "acme/api", path: wt, lead: true });
  setWork(db, 5, { worktree: wt });
  db.query(`INSERT INTO sessions (ticket, stage, argv, started_at, cwd) VALUES (5, 'implement', '["codex","go"]', '2026-11-21T09:59:00Z', ?)`).run(wt);
  const day = join(codexHome(), "sessions/2026/11/21");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-a.jsonl"), text(wt));
  writeFileSync(join(day, "rollout-b.jsonl"), text("/somewhere/else").replace(/"s1"/, '"s2"'));
  mkdirSync(join(codexHome(), "sessions/2026/10/01"), { recursive: true });
  writeFileSync(join(codexHome(), "sessions/2026/10/01/rollout-old.jsonl"), text(wt).replace(/"s1"/, '"s0"')); // before the factory used Codex
  const logs: string[] = [];
  recordUsage(db, (s) => logs.push(s));
  expect(db.query("SELECT tokens_in, tokens_out, usd FROM ticket_lead WHERE id = 5").get()).toEqual({ tokens_in: 1100, tokens_out: 80, usd: 0 });
  expect(logs).toEqual(["factory: no price for gpt-5.3-codex; its usage counts as $0"]);
  recordUsage(db, (s) => logs.push(s));
  expect(logs).toHaveLength(1);
});
