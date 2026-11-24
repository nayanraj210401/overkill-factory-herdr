// Ticket memory, layer 1 (journal.ts): sessions name their Claude transcript, the daemon journals
// what happens to a ticket as it happens, old tickets get a journal from their rows, and
// `factory journal` and status.json read it back.
import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MIGRATIONS, open, setRepo } from "./db.ts";
import { advance, pause, resume, sendBack, sh, startTicket, type Run } from "./runner.ts";
import { backfillJournal, claudeSession, journal, ticketEvents, transcriptPath } from "./journal.ts";
import { recordVerdict } from "./ready.ts";
import { noteAttention } from "./attention.ts";
import { main, paths } from "./cli.ts";
import { transcriptDir } from "./usage.ts";

const kinds = (db: Database, id: number) => ticketEvents(db, id).map((e) => e.kind);

test("a Claude session gets a known id just before its brief, and the transcript Claude Code will write for it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wt-"));
  const cs = claudeSession(["claude", "--model", "m", "the brief"], cwd);
  expect(cs.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(cs.argv).toEqual(["claude", "--model", "m", "--session-id", cs.id!, "the brief"]);
  // Claude Code names the folder after the real path of its cwd (macOS's /var is /private/var).
  expect(cs.transcript).toBe(join(transcriptDir(realpathSync(cwd)), `${cs.id}.jsonl`));
  expect(transcriptPath(cwd, "x")).toBe(cs.transcript!.replace(`${cs.id}.jsonl`, "x.jsonl"));
  expect(claudeSession(["codex", "go"], cwd)).toEqual({ argv: ["codex", "go"], id: null, transcript: null });
  expect(claudeSession(["claude", "go"], null).id).toBeNull();
});

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"true\"]\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let n = 0;
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (argv[1] === "run" ? { code: 0, out: `{"address":"t${++n}"}` } : { code: 0, out: "" }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  return { db, dir, repo, run };
}

test("a stage's session row names its Claude session and transcript, and the journal follows the ticket", () => {
  const { db, dir, repo, run } = setup();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  const s = db.query("SELECT * FROM sessions WHERE ticket = 7").get() as any;
  const argv = JSON.parse(s.argv) as string[];
  expect(argv[0]).toBe("claude");
  expect(argv[argv.indexOf("--session-id") + 1]).toBe(s.claude_session);
  expect(argv.at(-1)).toContain("#7"); // the brief stays last
  const wt = (db.query("SELECT worktree FROM ticket_lead WHERE id = 7").get() as any).worktree;
  expect(s.transcript).toBe(transcriptPath(wt, s.claude_session));
  const start = ticketEvents(db, 7).find((e) => e.kind === "session-start")!;
  expect(start).toMatchObject({ session: s.id, ref: `transcript:${s.transcript}` });

  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:10:00Z", failed: "ZQ the spec is unclear" }); // spec has no on_fail: it parks
  expect(kinds(db, 7)).toEqual(["stage", "session-start", "session-end", "stage-end", "parked"]);
  expect(ticketEvents(db, 7).find((e) => e.kind === "session-end")!.text).toBe("spec session ended (spec-writer): failed: ZQ the spec is unclear");
  // The search finds it; words of nothing in the journal find nothing.
  expect(ticketEvents(db, 7, { query: "unclear" }).map((e) => e.kind)).toEqual(expect.arrayContaining(["session-end", "stage-end", "parked"]));
  expect(ticketEvents(db, 7, { query: "kubernetes" })).toEqual([]);
});

test("pause, resume, a verdict, a check and a send-back are journaled where they happen", () => {
  const { db, dir, repo, run } = setup();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:01:00Z" }); // plan
  pause(db, { id: 7, run, now: "2026-11-21T10:02:00Z" });
  resume(db, { dir, repo, id: 7, run, now: "2026-11-21T10:03:00Z" });
  recordVerdict(db, { id: 7, kind: "review", result: "FAIL", detail: "ZQ no tests for the limiter", now: "2026-11-21T10:04:00Z" });
  const after = ticketEvents(db, 7).filter((e) => e.at >= "2026-11-21T10:02:00Z").map((e) => `${e.kind}: ${e.text}`);
  expect(after).toEqual([
    "session-end: plan session ended (planner): paused",
    "pause: you: paused at plan",
    "resume: you: resumed at plan",
    "stage: entered Plan · planner agent",
    "session-start: plan session 2 started (planner)",
    "verdict: review FAIL from planner: ZQ no tests for the limiter",
  ]);
  // A ready PR sent back: the note is journaled with the stage it goes back to.
  db.query("UPDATE tickets SET state = 'ready' WHERE id = 7").run();
  db.query("UPDATE ticket_repos SET pr_number = 51 WHERE ticket = 7").run();
  sendBack(db, { dir, repo, id: 7, note: "ZQ handle the 429 body", run, now: "2026-11-21T10:05:00Z" });
  const back = ticketEvents(db, 7).find((e) => e.kind === "send-back")!;
  expect(back.text).toBe("you: sent PR #51 back, back to implement: ZQ handle the 429 body");
  expect(back.ref).toMatch(/^decision:\d+$/);
});

test("an agent waiting on you in its terminal is journaled with the transcript the question is in", () => {
  const { db, dir, repo, run } = setup();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  const s = db.query("SELECT id, terminal, transcript FROM sessions WHERE ticket = 7").get() as any;
  noteAttention(db, { ticket: 7, terminal: s.terminal, stage: "spec", waiting: true, now: "2026-11-21T10:05:00Z" });
  noteAttention(db, { ticket: 7, terminal: s.terminal, stage: "spec", waiting: false, now: "2026-11-21T10:07:00Z" });
  expect(ticketEvents(db, 7).filter((e) => e.kind === "attention").map((e) => [e.text, e.session, e.ref])).toEqual([
    [`spec asks you in its terminal (${s.terminal})`, s.id, `transcript:${s.transcript}`],
    ["spec has its answer and goes on", s.id, `transcript:${s.transcript}`],
  ]);
});

test("an old ticket gets its journal from its rows when the database migrates, once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "old-")), "factory.db");
  const old = new Database(path, { create: true, strict: true });
  const at = MIGRATIONS.findIndex((m) => typeof m === "string" && m.includes("CREATE TABLE ticket_events"));
  expect(at).toBe(34); // the migration after agent memory's; the backfill is the one after it
  for (const m of MIGRATIONS.slice(0, at)) typeof m === "string" ? old.exec(m) : m(old);
  old.exec(`PRAGMA user_version = ${at}`);
  old.exec(`INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (10000, 'Search trains', 'parked', 'feature', '2026-11-22T12:00:00Z');
    INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (11, 'Quiet one', 'chore', '2026-11-20T08:00:00Z');
    INSERT INTO decisions (ticket, who, what, at) VALUES (10000, 'you', 'added a goal', '2026-11-22T10:00:00Z');
    INSERT INTO decisions (ticket, who, what, why, at) VALUES (10000, 'you', 'sent PR #9 back', 'ZQ use the IRCTC date format', '2026-11-22T11:30:00Z');
    INSERT INTO stages (ticket, name, detail, started_at) VALUES (10000, 'Implement', 'builder agent', '2026-11-22T10:05:00Z');
    INSERT INTO sessions (ticket, stage, agent, argv, started_at, ended_at) VALUES (10000, 'implement', 'builder', '[]', '2026-11-22T10:05:00Z', '2026-11-22T11:00:00Z');
    INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (10000, 'tests', 'FAIL', 'exit 1', '2026-11-22T11:01:00Z');
    INSERT INTO questions (ticket, n, kind, text, asked_at, answer, answered_by, answered_at) VALUES (10000, 1, 'product', 'Which quota?', '2026-11-22T10:02:00Z', 'Tatkal', 'you', '2026-11-22T10:03:00Z');
    INSERT INTO asks (from_agent, to_agent, text, about, at) VALUES ('builder', 'overwatch', 'the API key is missing', 10000, '2026-11-22T10:30:00Z');`);
  old.close();
  const db = open(path);
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(MIGRATIONS.length);
  expect(ticketEvents(db, 10000).map((e) => `${e.kind}: ${e.text}`)).toEqual([
    "created: you: added a goal",
    "question: Q1 (product): Which quota?",
    "answer: A1 from you: Tatkal",
    "stage: entered Implement", // a stage row's detail is its last one, so the backfill leaves it out
    "session-start: implement session started (builder)",
    "ask: builder asked overwatch: the API key is missing",
    "session-end: implement session ended (builder)",
    "check: tests FAIL: exit 1",
    "send-back: you: sent PR #9 back (ZQ use the IRCTC date format)",
  ]);
  expect(ticketEvents(db, 10000, { query: "IRCTC" }).map((e) => e.kind)).toEqual(["send-back"]);
  expect(ticketEvents(db, 11).map((e) => `${e.kind}: ${e.text}`)).toEqual(["created: Quiet one"]); // nothing kept but the ticket
  // Idempotent: a ticket with a journal is left alone.
  journal(db, { ticket: 10000, kind: "note", text: "later", at: "2026-11-23T00:00:00Z" });
  expect(backfillJournal(db)).toBe(0);
  expect(ticketEvents(db, 10000).length).toBe(10);
});

test("factory journal prints a ticket's events in order, as JSON, or the ones a search finds; status.json carries the newest", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => { out.length = 0; main([...a, "--name", "acme-api"], (s) => out.push(s)); return out; };
  run("init", "--repo", "acme/api");
  run("ticket", "add", "412", "Rate-limit", "login");
  for (let i = 1; i <= 9; i++) run("evidence", "412", `C${i}`, i === 4 ? "fail" : "pass", ...(i === 4 ? ["ZQ", "the", "limiter", "leaks"] : []));
  const lines = [...run("journal", "412")];
  expect(lines.length).toBe(10);
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}created {7}Rate-limit login \(feature blueprint\)$/);
  expect(lines[4]).toContain("check         C4 FAIL: ZQ the limiter leaks  [evidence:4]");
  const json = JSON.parse(run("journal", "412", "--json")[0]);
  expect(json.map((e: any) => e.kind)).toEqual(["created", ...Array(9).fill("check")]);
  expect(json[0]).toMatchObject({ ticket: 412, session: null, kind: "created", ref: null });
  expect(run("journal", "412", "--search", "leaks limiter")).toEqual([expect.stringContaining("C4 FAIL")]);
  expect(run("journal", "412", "--search", "zebra")).toEqual(['#412: nothing in its journal matches "zebra"']);
  expect(() => run("journal", "9")).toThrow("no ticket 9");
  // status.json: the newest 8, oldest first.
  const status = () => JSON.parse(readFileSync(paths("acme-api").status, "utf8")).tickets.find((t: any) => t.id === 412);
  const events = status().events;
  expect(events.length).toBe(8);
  expect(events.map((e: any) => e.text)).toEqual(["C2 PASS", "C3 PASS", "C4 FAIL: ZQ the limiter leaks", "C5 PASS", "C6 PASS", "C7 PASS", "C8 PASS", "C9 PASS"]);
  expect(Object.keys(events[0]).sort()).toEqual(["at", "kind", "text"]);
  // A ticket settled over a week ago goes without them.
  const db = open(paths("acme-api").db);
  db.query("UPDATE tickets SET state = 'merged', updated_at = '2026-01-01T00:00:00Z' WHERE id = 412").run();
  db.close();
  run("status");
  expect(status().events).toBeUndefined();
});

test("factory sessions --json: each session's stage, terminal, transcript and Claude session, oldest first (the V2 Chat view reads it)", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => { out.length = 0; main([...a, "--name", "acme-api"], (s) => out.push(s)); return out; };
  run("init", "--repo", "acme/api");
  run("ticket", "add", "412", "Rate-limit", "login");
  expect(JSON.parse(run("sessions", "412", "--json")[0])).toEqual([]);
  const db = open(paths("acme-api").db);
  db.exec(`INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, ended_at, claude_session, transcript)
      VALUES (412, 'implement', 'builder', 't3', '["claude"]', '2026-11-22T09:00:00Z', '2026-11-22T09:40:00Z', 'aaaa', '/x/aaaa.jsonl'),
             (412, 'implement', 'builder', 't7', '["claude"]', '2026-11-22T10:00:00Z', NULL, 'bbbb', '/x/bbbb.jsonl')`);
  db.close();
  const rows = JSON.parse(run("sessions", "412", "--json")[0]);
  expect(rows.map((r: any) => [r.stage, r.terminal, r.ended_at, r.claude_session, r.transcript])).toEqual([
    ["implement", "t3", "2026-11-22T09:40:00Z", "aaaa", "/x/aaaa.jsonl"],
    ["implement", "t7", null, "bbbb", "/x/bbbb.jsonl"],
  ]);
  expect(Object.keys(rows[0]).sort()).toEqual(["agent", "claude_session", "ended_at", "id", "stage", "started_at", "terminal", "tokens_in", "tokens_out", "transcript", "usd"]);
});
