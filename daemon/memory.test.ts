// Agent memory (memory.ts): rows in, the closest ones out (good and bad), outcomes filled in
// later, the brief's bounded block, retention, and the producers wired to it.
import { afterEach, test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { main } from "./cli.ts";
import { BRIEF_BYTES, listMemories, MAX_TEXT, memoryBlock, pruneMemories, recall, remember, setOutcome, settleMemories } from "./memory.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { prejudge } from "./prejudge.ts";
import { storeComments } from "./comments.ts";
import { openRound } from "./round.ts";
import { label } from "./agreement.ts";
import { learnerDigest } from "./learner.ts";

const NOW = "2026-11-23T10:00:00Z";
const HOME0 = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = HOME0; });

const fresh = () => open(join(mkdtempSync(join(tmpdir(), "mem-")), "factory.db"));
const row = (o: Partial<Parameters<typeof remember>[1]> = {}) => ({ agent: "reviewer", repo: "acme/api", kind: "verdict", input: "", output: "", at: NOW, ...o });

test("recall ranks by the query, puts rows with an outcome first, and keeps a good and a bad example", () => {
  const db = fresh();
  const merged = remember(db, row({ input: "rate limit the login endpoint", output: "added a token bucket" }));
  const reverted = remember(db, row({ input: "rate limit login with redis", output: "redis counter", at: "2026-11-01T00:00:00Z" }));
  const merged2 = remember(db, row({ input: "rate limit login rate limit login", output: "token bucket again" }));
  const open1 = remember(db, row({ input: "login rate limit retry", output: "pending" }));
  remember(db, row({ input: "login limit, still open", output: "pending too" }));
  remember(db, row({ input: "unrelated css colour", output: "x" }));
  remember(db, row({ agent: "builder", input: "rate limit login", output: "not the reviewer's" }));
  remember(db, row({ repo: "acme/web", input: "rate limit login", output: "another repo" }));
  setOutcome(db, merged, "merged", "daemon", NOW);
  setOutcome(db, merged2, "merged", "daemon", NOW);
  setOutcome(db, reverted, "reverted", "revert", NOW);

  // Two rows asked for: one good and one bad, though both merged rows outrank the reverted one.
  const two = recall(db, { agent: "reviewer", repo: "acme/api", query: "rate limit login", limit: 2 });
  expect(two.map((m) => m.outcome).sort()).toEqual(["merged", "reverted"]);
  // More room: every row with an outcome, then at most one without (the best-ranked).
  const all = recall(db, { agent: "reviewer", repo: "acme/api", query: "rate limit login", limit: 5 });
  expect(all.slice(0, 3).map((m) => m.outcome).every(Boolean)).toBe(true);
  expect(all.slice(3).map((m) => m.id)).toEqual([open1]);
  expect(all.every((m) => m.agent === "reviewer" && m.repo === "acme/api")).toBe(true);
  expect(all.some((m) => m.input.includes("css"))).toBe(false);
  // Kinds filter; no query lists the newest.
  expect(recall(db, { agent: "reviewer", query: "rate limit", kinds: ["stage-output"] })).toEqual([]);
  expect(listMemories(db, { agent: "reviewer", limit: 2 }).map((m) => m.at)).toEqual([NOW, NOW]);
});

test("a row's input and output are capped, an outcome can be set and changed, and an unknown id is refused", () => {
  const db = fresh();
  const id = remember(db, row({ input: "x".repeat(MAX_TEXT * 2), output: "y" }));
  const [m] = listMemories(db, {});
  expect(m.input.length).toBe(MAX_TEXT);
  expect(m.outcome).toBeNull();
  setOutcome(db, id, "kept", "you", NOW);
  setOutcome(db, id, "edited", "you", "2026-11-24T00:00:00Z");
  expect(listMemories(db, {})[0]).toMatchObject({ outcome: "edited", outcome_source: "you", outcome_at: "2026-11-24T00:00:00Z" });
  expect(() => setOutcome(db, 999, "kept", "you", NOW)).toThrow("no memory 999");
  expect(() => remember(db, row({ kind: " " }))).toThrow("agent, repo and kind");
});

test("the brief's block is a few one-line rows within its byte bound, and empty when there is nothing", () => {
  const db = fresh();
  expect(memoryBlock(db, { agent: "reviewer", repo: "acme/api", query: "anything" })).toBe("");
  for (let i = 0; i < 12; i++) setOutcome(db, remember(db, row({ input: `login flow ${i} ${"word ".repeat(80)}`, output: "z ".repeat(200) })), i % 2 ? "kept" : "deleted", "you", NOW);
  const block = memoryBlock(db, { agent: "reviewer", repo: "acme/api", query: "login flow" });
  const lines = block.split("\n");
  expect(lines.length).toBeLessThanOrEqual(5);
  expect(Buffer.byteLength(block)).toBeLessThanOrEqual(BRIEF_BYTES);
  expect(lines.every((l) => /^- \[(kept|deleted)\] verdict: /.test(l))).toBe(true);
  expect(new Set(lines.map((l) => l.match(/\[(\w+)\]/)![1])).size).toBe(2); // good and bad
});

test("retention keeps the newest rows per agent and repo, dropping the oldest without an outcome first", () => {
  const db = fresh();
  const at = (i: number) => new Date(Date.parse(NOW) + i * 1000).toISOString();
  const ids = Array.from({ length: 6 }, (_, i) => remember(db, row({ input: `row${i}`, at: at(i) })));
  setOutcome(db, ids[0], "kept", "you", NOW); // the oldest, but it has an outcome
  remember(db, row({ agent: "builder", input: "other agent", at: at(0) }));
  expect(pruneMemories(db, 3)).toBe(3);
  expect(listMemories(db, { agent: "reviewer" }).map((m) => m.input).sort()).toEqual(["row0", "row4", "row5"]);
  expect(listMemories(db, { agent: "builder" })).toHaveLength(1);
  // The search index follows the deletes.
  expect(recall(db, { query: "row1" })).toEqual([]);
  expect(pruneMemories(db, 3)).toBe(0);
});

test("stage outputs settle as merged, then reverted once a revert is found; a closed ticket's as closed", () => {
  const db = fresh();
  for (const [id, state] of [[1, "merged"], [2, "closed"], [3, "running"]] as const)
    db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (?, 't', ?, ?)").run(id, state, NOW);
  const a = remember(db, row({ kind: "stage-output", ticket: 1 })), b = remember(db, row({ kind: "stage-output", ticket: 2 })), c = remember(db, row({ kind: "stage-output", ticket: 3 }));
  const failed = remember(db, row({ kind: "stage-output", ticket: 1, outcome: "failed", outcome_source: "stage-done" }));
  expect(settleMemories(db, NOW)).toBe(2);
  const out = () => Object.fromEntries(listMemories(db, {}).map((m) => [m.id, m.outcome]));
  expect(out()).toEqual({ [a]: "merged", [b]: "closed", [c]: null, [failed]: "failed" });
  db.query("UPDATE tickets SET reverted_by = 9 WHERE id = 1").run();
  expect(settleMemories(db, NOW)).toBe(1);
  expect(out()[a]).toBe("reverted");
  expect(settleMemories(db, NOW)).toBe(0); // idempotent
});

test("the babysitter's verdicts land in its memory, and settle against your verdict: kept at merge, then your label", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(process.env.FACTORY_HOME, "agents"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\n");
  const db = fresh();
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (7, 't', 'running', ?)").run(NOW);
  const run: Run = (argv) => (argv[0] === "claude" ? { code: 0, out: "VERDICT: pushback\nCLEAR: no\nWHY: the reviewer misread it" } : { code: 1, out: "stubbed" });
  const rows = storeComments(db, { ticket: 7, pr: 12, limit: 2, repo: "acme/api", round: () => openRound(db, 7, NOW),
    comments: [{ ghId: "g1", thread: "g1", author: "sam", body: "Null check missing here.", at: NOW, place: "src/a.ts:3", url: null, hunk: "@@ +a @@" }] });
  prejudge(db, { repo, ticket: 7, rows, run, now: NOW });
  const [m] = listMemories(db, { agent: "babysitter" });
  expect(m).toMatchObject({ repo: "acme/api", kind: "babysitter-verdict", ticket: 7, pr: 12, ref: "C1", output: "pushback: the reviewer misread it", outcome: null });
  expect(m.input).toContain("Null check missing here.");
  // The fix agent fixed it, and the PR merged with that verdict: the babysitter was overruled.
  db.query("UPDATE comments SET verdict = 'fix', judged_at = ? WHERE ticket = 7").run(NOW);
  expect(settleMemories(db, NOW)).toBe(0); // not merged yet: nothing known
  db.query("UPDATE tickets SET state = 'merged' WHERE id = 7").run();
  settleMemories(db, NOW);
  expect(listMemories(db, { agent: "babysitter" })[0]).toMatchObject({ outcome: "overruled", outcome_source: "kept" });
  // Your label says pushback after all: it wins.
  label(db, { ticket: 7, n: 1, verdict: "pushback", now: NOW });
  settleMemories(db, NOW);
  expect(listMemories(db, { agent: "babysitter" })[0]).toMatchObject({ outcome: "agreed", outcome_source: "label" });
  expect(learnerDigest(db, repo).memory).toEqual([{ agent: "babysitter", kind: "babysitter-verdict", outcome: "agreed", rows: 1 }]);
});

function repoDir() {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", dir, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: echo\n---\nWrite INTENT.md.\n");
  sh(["git", "-C", dir, "add", "."]);
  sh(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("a stage's brief carries the agent's closest memories, and its end goes into that agent's memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const r = repoDir();
  setRepo(db, { slug: "acme/api", path: r, lead: true });
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (1, 'Rate-limit login', 'feature', ?)").run(NOW);
  setOutcome(db, remember(db, row({ agent: "spec-writer", kind: "stage-output", input: "Rate-limit signup", output: "INTENT: a token bucket per IP" })), "reverted", "revert", NOW);
  remember(db, row({ agent: "builder", kind: "stage-output", input: "Rate-limit login", output: "ZQ-NOT-MINE" }));
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9"}' }) : sh(argv, cwd));
  startTicket(db, { dir, repo: r, id: 1, run, now: NOW });
  const text = calls[0].at(-1)!;
  expect(text).toContain("From your memory:");
  expect(text).toContain("- [reverted] stage-output: Rate-limit signup → INTENT: a token bucket per IP");
  expect(text).not.toContain("ZQ-NOT-MINE");
  mkdirSync(join(dir, "tickets/1"), { recursive: true });
  writeFileSync(join(dir, "tickets/1/INTENT.md"), "ZQ-INTENT limit login to 5 a minute\n");
  advance(db, { dir, repo: r, id: 1, run, now: NOW, failed: "the spec is unclear" });
  const [m] = listMemories(db, { agent: "spec-writer", limit: 1 });
  expect(m).toMatchObject({ kind: "stage-output", ticket: 1, repo: "acme/api", ref: "spec", outcome: "failed", outcome_source: "stage-done" });
  expect(m.input).toContain("Rate-limit login\nZQ-INTENT");
  expect(m.output).toContain("ZQ-INTENT"); // spec's output file
});

test("factory memory add, outcome, search and list, as the session's agent in its ticket's repo", () => {
  const name = `mem-${Date.now()}`;
  const r = repoDir();
  main(["init", "--repo", "acme/api", "--path", r, "--name", name], () => {});
  const out: string[] = [];
  const log = (s: string) => out.push(s);
  const env = { ...process.env };
  process.env.FACTORY_AGENT = "reviewer";
  try {
    const file = join(mkdtempSync(join(tmpdir(), "in-")), "hunk.txt");
    writeFileSync(file, "@@ -1 +1 @@\n+const token = req.query.token");
    main(["memory", "add", "--name", name, "--kind", "review-comment", "--pr", "12", "--input", file, "Tokens", "belong", "in", "headers"], log);
    expect(out.at(-1)).toMatch(/^memory 1 for reviewer in acme\/api/);
    main(["memory", "outcome", "--name", name, "1", "accepted"], log);
    out.length = 0;
    main(["memory", "search", "--name", name, "token", "query", "--json"], log);
    const [m] = JSON.parse(out[0]);
    expect(m).toMatchObject({ agent: "reviewer", repo: "acme/api", kind: "review-comment", pr: 12, output: "Tokens belong in headers", outcome: "accepted", outcome_source: "reviewer" });
    expect(m.input).toContain("req.query.token");
    out.length = 0;
    main(["memory", "list", "--name", name, "--agent", "builder"], log);
    expect(out).toEqual(["no memories"]);
    delete process.env.FACTORY_AGENT;
    expect(() => main(["memory", "add", "--name", name, "--kind", "verdict", "x"], log)).toThrow("whose memory?");
  } finally { process.env.FACTORY_AGENT = env.FACTORY_AGENT; if (env.FACTORY_AGENT === undefined) delete process.env.FACTORY_AGENT; }
});
