// Ticket memory, layer 3 (digest.ts): after a session ends, Haiku rewrites the ticket's digest from
// the digest before, the journal and the new transcript chunks, all redacted; it is stored on the
// ticket, written to TICKET-MEMORY.md (kept out of git), and carried by every brief. A failure never
// blocks anything and is journaled; a re-requested ticket starts from its parent's digest.
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { journal, ticketEvents } from "./journal.ts";
import { newTicket } from "./intake.ts";
import { triageBrief } from "./groom.ts";
import { DIGEST_CAP, DIGEST_TOKENS, FILE, MODEL, SECTIONS, digestBlock, digestInput, digestOf, digestPrompt, digestsDue, parseDigest, runDigest, runDueDigest } from "./digest.ts";
import { main, paths } from "./cli.ts";
import { factoryChanges } from "./local.ts";

const T0 = "2026-11-24T10:00:00Z", T1 = "2026-11-24T10:10:00Z", T2 = "2026-11-24T10:11:00Z";

const DIGEST = [
  "## Decisions and why", "- A sliding window, not a fixed one: bursts at the boundary passed twice the limit.",
  "## The person's answers", '- Q1 (which window?): "ZQ use a sliding window, not a fixed one"',
  "## Tried and failed", "- A fixed 60s window: the test at the boundary failed.",
  "## Open questions", "- none",
  "## Current state", "- The spec is written; planning is next.",
].join("\n");

// claude -p --output-format json's answer, with its usage and cost.
const answer = (result: string, usd = 0.0021) => JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: usd,
  usage: { input_tokens: 9000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 600 } });

const line = (o: object) => JSON.stringify({ timestamp: T0, ...o });
const userTurn = (content: unknown) => line({ type: "user", message: { role: "user", content } });
const said = (text: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

function setup(yaml = "") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\n${yaml}`);
  writeFileSync(join(repo, "README.md"), "demo\n");
  sh(["git", "-C", repo, "add", "README.md"]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let n = 0;
  const prompts: string[] = [];
  const calls: { argv: string[]; cwd?: string }[] = [];
  let reply: (prompt: string) => { code: number; out: string } = () => ({ code: 0, out: answer(DIGEST) });
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return argv[1] === "run" ? { code: 0, out: `{"address":"t${++n}"}` } : { code: 0, out: "" };
    if (argv[0] === "claude" && argv.at(-1)!.startsWith("You keep the memory")) { prompts.push(argv.at(-1)!); calls.push({ argv, cwd }); return reply(argv.at(-1)!); }
    if (argv[0] === "claude") return { code: 1, out: "only the digest's calls answer here" }; // the orchestrator's pick falls back to the default
    return sh(argv, cwd);
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', ?)").run(T0);
  return { db, dir, repo, run, prompts, calls, answer: (f: typeof reply) => { reply = f; } };
}

// The ticket's first stage starts; its session's transcript holds the brief, your answer typed into
// its terminal, and what the agent said; then the stage ends, and the session's chunks are indexed.
function firstSession(s: ReturnType<typeof setup>, extra: string[] = []) {
  startTicket(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: T0 });
  const row = s.db.query("SELECT argv, transcript FROM sessions WHERE ticket = 7").get() as { argv: string; transcript: string };
  mkdirSync(dirname(row.transcript), { recursive: true });
  writeFileSync(row.transcript, [userTurn(JSON.parse(row.argv).at(-1)), userTurn("ZQ use a sliding window, not a fixed one"), said("A fixed window lets bursts through at the boundary."), ...extra].join("\n") + "\n");
  advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: T1 });
}

const worktree = (db: Database, id = 7) => (db.query("SELECT worktree FROM ticket_lead WHERE id = ?").get(id) as { worktree: string }).worktree;
const kinds = (db: Database, id = 7) => ticketEvents(db, id).map((e) => e.kind);

test("after a session ends, Haiku's digest is stored on the ticket, written to TICKET-MEMORY.md outside git, and its cost counted", () => {
  const s = setup();
  firstSession(s);
  expect(digestsDue(s.db, T2)).toEqual([7]);
  const r = runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2, cwd: s.dir });
  expect(r).toMatchObject({ id: 7, ok: true, chars: DIGEST.length, usd: 0.0021 });
  const t = s.db.query("SELECT digest, digest_at, digest_event, digest_chunk, usd FROM tickets WHERE id = 7").get() as any;
  expect(t.digest).toBe(DIGEST);
  expect(t.digest_at).toBe(T2);
  expect(t.digest_event).toBe(Math.max(...ticketEvents(s.db, 7).filter((e) => e.kind !== "digest").map((e) => e.id)));
  expect(t.digest_chunk).toBeGreaterThan(0);
  // The call: Haiku, its answer as JSON, from the factory's folder (not a worktree, whose usage is read from transcripts).
  expect(s.calls.map((c) => [...c.argv.slice(0, -1), c.cwd])).toEqual([["claude", "-p", "--model", "claude-haiku-5-5", "--output-format", "json", s.dir]]);
  // Its cost is a usage row on the ticket, so the ticket's spend and the day's budget count it.
  const u = s.db.query("SELECT model, session, input, cache_write_5m, cache_read, output, usd FROM usage WHERE message_id LIKE 'digest:7:%'").get() as any;
  expect(u).toEqual({ model: MODEL, session: null, input: 9000, cache_write_5m: 1000, cache_read: 20000, output: 600, usd: 0.0021 });
  expect(t.usd).toBeCloseTo(0.0021);
  // The file beside the code, which git doesn't see: the exclude line keeps it out of every commit.
  const file = join(worktree(s.db), FILE);
  expect(readFileSync(file, "utf8")).toContain(DIGEST);
  expect(readFileSync(file, "utf8")).toContain('factory recall 7 "words"');
  expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).toContain(`/${FILE}\n`);
  expect(sh(["git", "-C", worktree(s.db), "status", "--porcelain"]).out).not.toContain(FILE);
  expect(kinds(s.db).at(-1)).toBe("digest");
  // An agent forcing it into a commit: the PR guard sees it, as it does .factory/.
  sh(["git", "-C", worktree(s.db), "add", "-f", FILE]);
  sh(["git", "-C", worktree(s.db), "commit", "-q", "-m", "oops"]);
  expect(factoryChanges(sh, s.repo, worktree(s.db))).toEqual([FILE]);
  // Done until the next session ends.
  expect(digestsDue(s.db, T2)).toEqual([]);
  expect(runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2 })).toBeNull();
  expect(s.prompts).toHaveLength(1);
});

test("the prompt tells Haiku the cap and the sections, quotes your words, and leaves out the brief it already carries", () => {
  const s = setup();
  firstSession(s);
  const p = digestPrompt(digestInput(s.db, 7));
  expect(p).toContain(`Stay under ${DIGEST_TOKENS} tokens`);
  expect(p).toContain(`past ${DIGEST_CAP} characters`);
  for (const h of SECTIONS) expect(p).toContain(`## ${h}`);
  expect(p).toContain("verbatim");
  expect(p).toContain("[user] ZQ use a sliding window, not a fixed one");
  expect(p).toContain("[assistant] A fixed window lets bursts through");
  expect(p).toContain("session-end: spec session ended (spec-writer): stage done");
  expect(p).not.toContain("You run its spec stage"); // the session's brief, its first user turn
  // Past the cap the answer is cut; an answer without the headings is no digest.
  const long = parseDigest(`${DIGEST}\n${"- more\n".repeat(3000)}`)!;
  expect(long.length).toBeLessThan(DIGEST_CAP + 100);
  expect(long).toEndWith(`(cut at the digest's cap of ${DIGEST_CAP} characters)`);
  expect(parseDigest("I couldn't do that.")).toBeNull();
  expect(parseDigest(`Here it is:\n\n${DIGEST}`)).toBe(DIGEST);
});

test("the prompt carries redacted text only: the journal, the transcript and the digest before", () => {
  const s = setup();
  firstSession(s, [said("export AWS_KEY=AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnopqrstuvwxyz")]);
  journal(s.db, { ticket: 7, kind: "talk", text: "you said: GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list", at: T1 });
  s.db.query("UPDATE tickets SET digest = ? WHERE id = 7").run(`${DIGEST}\n- the key is sk-abcdefghijklmnopqrstuvwxyz012345`);
  runDigest(s.db, { id: 7, repo: s.repo, run: s.run, now: T2 });
  const p = s.prompts[0];
  for (const secret of ["AKIAABCDEFGHIJKLMNOP", "abcdefghijklmnopqrstuvwxyz", "ghp_", "sk-abcdef"]) expect(p).not.toContain(secret);
  expect(p).toContain("[redacted");
  expect(p).toContain("ZQ use a sliding window"); // the rest goes through as it is
});

test("every brief carries the digest with the pointer to factory recall", () => {
  const s = setup();
  firstSession(s);
  expect(digestBlock(s.db, 7)).toBe("");
  runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2 });
  const block = digestBlock(s.db, 7);
  expect(block).toStartWith("#7's memory so far, which the factory rewrites");
  expect(block).toContain('For detail run `factory recall 7 "words"`.');
  expect(block).toEndWith(DIGEST);
  // The next stage's session starts with it in its brief.
  advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-24T10:20:00Z" });
  const argv = JSON.parse((s.db.query("SELECT argv FROM sessions WHERE ticket = 7 ORDER BY id DESC LIMIT 1").get() as any).argv) as string[];
  expect(argv.at(-1)).toContain(block);
  // A template that doesn't place {{digest}} gets it anyway, after the map.
  writeFileSync(join(s.repo, ".factory/prompts/groom.md"), "Groom {{ticket.id}}.");
  expect(triageBrief({ id: 7, title: "t" }, { slug: "acme/api", repo: s.repo, folder: "/f", blueprints: [], prompt: null, digest: block })).toBe(`${block}\n\nGroom 7.`);
});

test("a failed digest never blocks: the stage went on, the failure is journaled, and the next session end tries again", () => {
  const s = setup();
  s.answer(() => ({ code: 1, out: "API Error: 529 overloaded" }));
  firstSession(s);
  expect(kinds(s.db)).toContain("stage-end"); // the session ended and the ticket moved on before any call
  const logs: string[] = [];
  const r = runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2, log: (l) => logs.push(l) });
  expect(r).toMatchObject({ id: 7, ok: false, why: "exit 1: API Error: 529 overloaded" });
  const failed = ticketEvents(s.db, 7).at(-1)!;
  expect(failed).toMatchObject({ kind: "digest-failed", text: `the digest wasn't rewritten (${MODEL}): exit 1: API Error: 529 overloaded; the next session end tries again` });
  expect(logs).toEqual(["factory: #7: the digest failed: exit 1: API Error: 529 overloaded"]);
  expect((s.db.query("SELECT digest FROM tickets WHERE id = 7").get() as any).digest).toBeNull();
  expect(existsSync(join(worktree(s.db), FILE))).toBe(false);
  // Not every tick: it waits for the next end.
  expect(digestsDue(s.db, T2)).toEqual([]);
  // A call that throws, or an answer that isn't a digest, fails the same way (the answer's cost still counts).
  s.answer(() => { throw new Error("spawn claude ENOENT"); });
  expect(runDigest(s.db, { id: 7, repo: s.repo, run: s.run, now: T2 })).toEqual({ ok: false, why: "spawn claude ENOENT" });
  s.answer(() => ({ code: 0, out: answer("Sorry, I can't help with that.", 0.001) }));
  expect(runDigest(s.db, { id: 7, repo: s.repo, run: s.run, now: "2026-11-24T10:12:00Z" })).toMatchObject({ ok: false, why: "unreadable answer: none of the digest's headings" });
  expect((s.db.query("SELECT COUNT(*) AS n FROM usage WHERE message_id LIKE 'digest:%'").get() as any).n).toBe(1);
  // The next session end: due again, and this time it works.
  advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-24T10:20:00Z" });
  expect(digestsDue(s.db, "2026-11-24T10:21:00Z")).toEqual([7]);
  s.answer(() => ({ code: 0, out: answer(DIGEST) }));
  expect(runDueDigest(s.db, { repo: s.repo, run: s.run, now: "2026-11-24T10:21:00Z" })).toMatchObject({ ok: true });
});

test("the day's budget holds the call: nothing is asked or journaled, and it goes once the hold lifts", () => {
  const s = setup("budget:\n  per_day: { input: 1000, output: 1000 }\n");
  firstSession(s);
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('m1', 7, ?, 'claude-sonnet-5-5', 5000, 0, 0, 0, 10, 0)").run(T1);
  const r = runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2 });
  expect(r).toMatchObject({ ok: false, held: true, why: "daily budget reached (5k/1k in)" });
  expect(s.prompts).toEqual([]);
  expect(kinds(s.db)).not.toContain("digest-failed");
  expect(digestsDue(s.db, T2)).toEqual([7]); // still due
  s.db.query("DELETE FROM usage WHERE message_id = 'm1'").run();
  expect(runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2 })).toMatchObject({ ok: true });
});

test("a re-requested ticket starts from its parent's digest, in its brief and in its first digest", () => {
  const s = setup();
  firstSession(s);
  runDueDigest(s.db, { repo: s.repo, run: s.run, now: T2 });
  const child = newTicket(s.db, { text: "Rate-limit login, again", repo: "acme/api", blueprint: "feature", run: s.run, now: T2, groom: true, parent: 7 });
  expect((s.db.query("SELECT parent FROM tickets WHERE id = ?").get(child.id) as any).parent).toBe(7);
  expect(ticketEvents(s.db, child.id)[0].text).toContain("it re-requests #7");
  expect(digestOf(s.db, child.id)).toMatchObject({ text: DIGEST, from: 7, event: null });
  const block = digestBlock(s.db, child.id);
  expect(block).toStartWith(`#${child.id} carries on from #7. This is #7's memory`);
  expect(block).toContain('`factory recall 7 "words"`');
  expect(block).toContain(`\`factory recall ${child.id} "words"\``);
  // Its first digest is written from the parent's.
  journal(s.db, { ticket: child.id, kind: "session-end", text: "groom session ended (triage): triage done", at: T2 });
  const input = digestInput(s.db, child.id);
  expect(input.previous).toMatchObject({ from: 7, text: DIGEST });
  expect(digestPrompt(input)).toContain(`# The digest before (#7's: this ticket carries on from it)\n\n${DIGEST}`);
  const own = DIGEST.replace("planning is next", "the re-request asks for a per-IP limit too");
  s.answer(() => ({ code: 0, out: answer(own) }));
  expect(runDueDigest(s.db, { repo: s.repo, run: s.run, now: "2026-11-24T10:12:00Z" })).toMatchObject({ id: child.id, ok: true });
  expect(digestOf(s.db, child.id)).toMatchObject({ text: own, from: child.id });
  expect(digestOf(s.db, 7)!.text).toBe(DIGEST); // the parent's is its own
  // A rebuild starts again from the parent's, not from its own.
  expect(digestInput(s.db, child.id, { rebuild: true }).previous).toMatchObject({ from: 7 });
  expect(() => newTicket(s.db, { text: "x", repo: "acme/api", blueprint: "feature", run: s.run, now: T2, parent: 99 })).toThrow("--parent: no ticket 99");
  s.db.query("UPDATE tickets SET state = 'paused' WHERE id = 7").run();
  expect(() => newTicket(s.db, { text: "y", repo: "acme/api", blueprint: "feature", run: s.run, now: T2, parent: 7 })).toThrow("#7 is paused");
});

test("an end older than two days starts no digest, so old tickets aren't digested all at once", () => {
  const s = setup();
  journal(s.db, { ticket: 7, kind: "session-end", text: "spec session ended", at: "2026-11-20T10:00:00Z" });
  expect(digestsDue(s.db, T2)).toEqual([]);
  journal(s.db, { ticket: 7, kind: "handoff", text: "spec: session 1 handed off to session 2", at: T1 });
  expect(digestsDue(s.db, T2)).toEqual([7]);
});

test("factory digest prints the digest, or its parent's; --rebuild asks Haiku now, and a failure says why", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  const out: string[] = [];
  const run = (...a: string[]) => { out.length = 0; main([...a, "--name", "acme-api"], (l) => out.push(l)); return out; };
  run("init", "--repo", "acme/api", "--path", repo);
  run("ticket", "add", "412", "Rate-limit", "login");
  expect(run("digest", "412")).toEqual(["#412 has no digest yet: it is written after the ticket's next session ends (or now: factory digest 412 --rebuild)"]);
  const db = open(paths("acme-api").db);
  db.query("UPDATE tickets SET digest = ?, digest_at = ?, digest_event = 3 WHERE id = 412").run(DIGEST, T2);
  db.close();
  expect(run("digest", "412", "--print")).toEqual(["# #412's digest · 2026-11-24 10:11 · the journal up to event 3\n", DIGEST]);
  run("new", "Rate-limit", "login", "again", "--parent", "412");
  expect(out[0]).toMatch(/^#10000 Rate-limit login again added/);
  expect(run("digest", "10000")[0]).toBe("# #10000's digest: none of its own yet, so #412's, which it starts from · 2026-11-24 10:11\n");
  expect(JSON.parse(run("digest", "10000", "--json")[0])).toMatchObject({ from: 412, text: DIGEST });
  // In tests claude is stubbed, so the rebuild fails: said, journaled, and the digest it had stays.
  expect(() => run("digest", "412", "--rebuild")).toThrow("#412: the digest wasn't rebuilt: exit 1: claude is stubbed in tests");
  const after = open(paths("acme-api").db);
  expect(ticketEvents(after, 412).at(-1)!.kind).toBe("digest-failed");
  expect((after.query("SELECT digest FROM tickets WHERE id = 412").get() as any).digest).toBe(DIGEST);
  expect(() => run("digest", "9")).toThrow("no ticket 9");
});
