import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, getMeta, open, setRepo } from "./db.ts";
import { buildStatus } from "./status.ts";
import { sh, startTicket, type Run } from "./runner.ts";
import { transcriptDir } from "./usage.ts";
import { planFile, type Reading } from "./planline.ts";
import { GRACE_MS, STAGGER_MS, limitHit, limitOnScreen, resumeWaiting, watchLimit, whenText } from "./planlimit.ts";
import { validateStatus } from "../lib/status.js";
import { subtitle } from "../lib/model.js";

afterEach(() => rmSync(planFile(), { force: true }));

const NOW = "2026-11-21T10:30:00Z";
const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const writePlan = (r: Reading) => writeFileSync(planFile(), JSON.stringify(r));

function setup(o: { tickets?: number[]; yaml?: string } = {}) {
  const ids = o.tickets ?? [412];
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const dbPath = join(dir, "factory.db");
  const db = open(dbPath);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  if (o.yaml) appendFileSync(join(repo, ".factory/factory.yaml"), o.yaml);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const calls: string[][] = [];
  const screens: Record<string, string> = {};
  // hc is stubbed: run gives each new terminal an address, read gives the screen set for it.
  const run: Run = (argv, cwd) => {
    if (argv[0] !== "hc") return sh(argv, cwd);
    calls.push(argv);
    if (argv[1] === "read") return { code: 0, out: screens[argv[2]] ?? "" };
    return { code: 0, out: `{"address":"t${10 + calls.length}","state":"live"}` };
  };
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  for (const id of ids) {
    db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run(id);
    startTicket(db, { dir, repo, id, run, now: "2026-11-21T10:00:00Z" });
    mkdirSync(join(dir, "tickets", String(id)), { recursive: true });
  }
  const session = (id: number) => db.query("SELECT * FROM sessions WHERE ticket = ? ORDER BY id DESC LIMIT 1").get(id) as any;
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  const logs: string[] = [];
  const watch = (id: number, now: string, o2: { state?: string; reading?: Reading | null } = {}) =>
    watchLimit(db, { dir, repo, run, now, s: session(id), info: { status: { state: o2.state ?? "idle" } }, log: (l) => logs.push(l), ...("reading" in o2 ? { reading: o2.reading } : {}) });
  const resume = (now: string) => resumeWaiting(db, { dir, repo, run, now, log: (l) => logs.push(l) });
  return { dir, dbPath, db, repo, run, calls, screens, session, ticket, watch, resume, logs };
}

test("Claude Code's limit messages are found at the bottom of the screen; look-alikes aren't", () => {
  expect(limitOnScreen("● Working on it\n\n  ⎿  You've hit your session limit · resets 3pm (Europe/London)\n     /rate-limit-options")).toMatchObject({ window: "five_hour" });
  expect(limitOnScreen("You’ve hit your weekly limit · resets Nov 25, 9am")).toMatchObject({ window: "seven_day" });
  expect(limitOnScreen("You've hit your Opus limit · resets Nov 25")?.window).toBe("seven_day");
  expect(limitOnScreen("You've hit your limit · resets 5pm")).toMatchObject({ window: null });
  expect(limitOnScreen("Claude usage limit reached. Your limit will reset at 5pm (America/New_York).")).toMatchObject({ window: null });
  expect(limitOnScreen("5-hour limit reached ∙ resets 5pm")?.window).toBe("five_hour");
  // not the limit: a ticket about rate limits, the warning before it, extra usage, and an old line far up
  expect(limitOnScreen("Rate-limit login: the 6th attempt gets a 429\nrate limited by the API")).toBeNull();
  expect(limitOnScreen("Usage limit approaching. Checkpoint now")).toBeNull();
  expect(limitOnScreen("You've hit your monthly spend limit · /usage-credits to raise it")).toBeNull();
  expect(limitOnScreen(["usage limit reached", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join("\n"))).toBeNull();
});

test("from the reading: a full window stops an idle agent; one at 99% that is still working goes on", () => {
  const now = new Date(NOW);
  const r = (five: number, week = 0.4, fiveReset: string | null = "2026-11-21T14:04:00Z", weekReset: string | null = "2026-11-24T09:00:00Z"): Reading =>
    ({ at: NOW, five_hour: { used: five, resets_at: fiveReset }, seven_day: { used: week, resets_at: weekReset } });
  expect(limitHit({ reading: r(0.99), screen: "", working: false, now })).toEqual({ window: "five_hour", via: "reading", line: null });
  expect(limitHit({ reading: r(0.99), screen: "", working: true, now })).toBeNull();
  expect(limitHit({ reading: r(1), screen: "", working: true, now })).toMatchObject({ window: "five_hour" }); // 100%: nothing goes through
  expect(limitHit({ reading: r(0.9), screen: "", working: false, now })).toBeNull();
  expect(limitHit({ reading: r(1, 1), screen: "", working: false, now })?.window).toBe("seven_day"); // both full: wait for the later reset
  expect(limitHit({ reading: r(1, 0.4, "2026-11-21T10:00:00Z"), screen: "", working: false, now })).toBeNull(); // that window already reset
  expect(limitHit({ reading: r(0.2), screen: "You've hit your session limit", working: false, now })).toMatchObject({ window: "five_hour", via: "terminal" });
  expect(limitHit({ reading: null, screen: "", working: false, now })).toBeNull();
});

test("the limit on the terminal: work committed, session ended, the ticket waits running with its resume time", () => {
  const s = setup();
  const wt = s.ticket(412).worktree;
  writeFileSync(join(wt, "limiter.ts"), "export const x = 1;\n"); // work in progress
  const reset = "2026-11-21T14:04:00Z";
  writePlan({ at: NOW, five_hour: { used: 0.97, resets_at: reset }, seven_day: { used: 0.4, resets_at: "2026-11-24T09:00:00Z" } });
  s.screens[s.session(412).terminal] = "● Editing limiter.ts\n\nYou've hit your session limit · resets 2pm\n/rate-limit-options";
  // Herdr saw the limit menu as a question first
  s.db.query("UPDATE tickets SET needs_kind = 'attention', needs_text = 'Waiting on you' WHERE id = 412").run();
  const terminal = s.session(412).terminal;
  expect(s.watch(412, NOW)).toBe(true);
  expect(sh(["git", "-C", wt, "log", "-1", "--format=%s"]).out).toBe("factory: #412 work in progress at the plan limit (session 1)");
  expect(sh(["git", "-C", wt, "status", "--porcelain"]).out).toBe("");
  expect(s.calls.some((c) => c[1] === "kill" && c[2] === terminal)).toBe(true);
  expect(s.session(412).ended_at).toBe(NOW);
  const t = s.ticket(412);
  expect(t).toMatchObject({ state: "running", stage: "spec", needs_kind: null, resume_at: later(reset, GRACE_MS) });
  expect(t.detail).toBe(`waiting for plan reset · resumes ${whenText(t.resume_at, new Date(NOW))}`);
  expect(t.detail).toMatch(/resumes \d\d:\d\d$/);
  expect((s.db.query("SELECT detail FROM stages WHERE ended_at IS NULL").get() as any).detail).toBe(t.detail);
  const d = s.db.query("SELECT what, why FROM decisions WHERE ticket = 412 ORDER BY id DESC LIMIT 1").get() as any;
  expect(d.what).toContain("stopped at the 5-hour plan limit");
  expect(d.why).toContain("its terminal says \"You've hit your session limit");
  expect(d.why).toContain(`the window resets at ${reset}`);
  // what you see: status.json carries the resume time; the sidebar row says it; not Needs you
  const status = buildStatus(s.db, new Date(NOW));
  expect(validateStatus(status)).toEqual([]);
  const row = status.tickets[0] as any;
  expect(row).toMatchObject({ resume_at: t.resume_at, needs: null, terminal: null });
  expect(subtitle(row)).toMatch(/^spec · plan reset · resumes \d\d:\d\d$/);
  // nothing more happens to it before the reset
  expect(s.resume(later(reset, 30_000))).toBeNull();
  expect(s.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});

test("at the reset: a fresh session in the same stage and slice, briefed from the commit, the diff and the transcript's end", () => {
  const s = setup();
  const folder = join(s.dir, "tickets/412");
  writeFileSync(join(folder, "SLICES.md"), "# Slices\n\n## S1. The limiter (done)\nx\n\n## S2. The 429 response\nreturn it from login\n");
  // the ticket is building slice S2 when the limit comes
  s.db.query("UPDATE tickets SET stage = 'implement' WHERE id = 412").run();
  s.db.query("UPDATE sessions SET stage = 'implement', agent = 'builder', slice = 'S2' WHERE ticket = 412").run();
  const wt = s.ticket(412).worktree;
  mkdirSync(transcriptDir(wt), { recursive: true });
  writeFileSync(join(transcriptDir(wt), "s1.jsonl"), [
    { type: "user", timestamp: "2026-11-21T10:01:00Z", message: { content: "go" } },
    { type: "assistant", timestamp: "2026-11-21T10:20:00Z", message: { content: [{ type: "text", text: "The limiter works; next the 429 in login()." }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(wt, "limiter.ts"), "export const x = 1;\n");
  const reset = "2026-11-21T14:04:00Z";
  writePlan({ at: NOW, five_hour: { used: 1, resets_at: reset }, seven_day: null });
  expect(s.watch(412, NOW)).toBe(true);
  const resumeAt = s.ticket(412).resume_at;
  // the Mac slept through the reset: the first tick after it resumes the ticket
  const wake = "2026-11-21T16:40:00Z";
  expect(s.resume(wake)).toBe(412);
  const [old, next] = s.db.query("SELECT * FROM sessions ORDER BY id").all() as any[];
  expect(old.ended_at).toBe(NOW);
  expect(next).toMatchObject({ stage: "implement", agent: "builder", slice: "S2", ended_at: null, started_at: wake, cwd: wt });
  const argv = JSON.parse(next.argv) as string[];
  expect(argv[0]).toBe("claude");
  expect(argv).not.toContain("--resume");
  expect(argv).not.toContain("--continue");
  const brief = argv.at(-1)!;
  expect(brief).toContain("You are session 2 of #412");
  expect(brief).toContain("was stopped by the plan's 5-hour limit");
  expect(brief).toContain("factory: #412 work in progress at the plan limit"); // the last commit
  expect(brief).toMatch(/limiter\.ts \| 1 \+/); // git diff --stat
  expect(brief).toContain("The 429 response");
  expect(brief).not.toContain("S1. The limiter");
  expect(brief).toContain("## Where it stopped");
  expect(brief).toContain("> The limiter works; next the 429 in login().");
  expect(brief).toContain(join(transcriptDir(wt), "s1.jsonl"));
  expect(brief).not.toContain("## HANDOFF.md");
  const t = s.ticket(412);
  expect(t).toMatchObject({ state: "running", resume_at: null, detail: "builder agent · session 2" });
  expect(getMeta(s.db, "plan_wait:412")).toBeNull();
  expect((s.db.query("SELECT what FROM decisions WHERE ticket = 412 ORDER BY id DESC LIMIT 1").get() as any).what).toBe("resumed after the plan reset in session 2");
  expect(Date.parse(wake)).toBeGreaterThan(Date.parse(resumeAt));
  // a second tick doesn't start another
  expect(s.resume(later(wake, STAGGER_MS * 2))).toBeNull();
  expect(s.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
});

test("waiting tickets restart one at a time, oldest first, a gap apart, within max_running", () => {
  const s = setup({ tickets: [412, 413, 414, 415] });
  writePlan({ at: NOW, five_hour: { used: 1, resets_at: "2026-11-21T14:04:00Z" }, seven_day: null });
  for (const id of [414, 412, 413]) expect(s.watch(id, NOW)).toBe(true);
  // max_running is 3: #415 still runs, so two slots are free once the window resets
  const due = later("2026-11-21T14:04:00Z", GRACE_MS);
  expect(s.resume(later(due, -1000))).toBeNull();
  expect(s.resume(due)).toBe(412);
  expect(s.resume(later(due, 1000))).toBeNull(); // the gap
  expect(s.resume(later(due, STAGGER_MS))).toBe(413);
  expect(s.resume(later(due, STAGGER_MS * 2))).toBeNull(); // #412, #413 and #415 run: max_running
  expect(s.ticket(414).resume_at).toBe(due);
  s.db.query("UPDATE tickets SET state = 'merged' WHERE id = 415").run();
  expect(s.resume(later(due, STAGGER_MS * 3))).toBe(414);
});

test("no resume while the window still reads over plan.pause_at", () => {
  const s = setup({ yaml: "plan:\n  pause_at: 85%\n" });
  writePlan({ at: NOW, five_hour: { used: 1, resets_at: "2026-11-21T14:04:00Z" }, seven_day: null });
  expect(s.watch(412, NOW)).toBe(true);
  const due = s.ticket(412).resume_at;
  // a session elsewhere on the account saw the new window fill to 90% already
  writePlan({ at: later(due, 60_000), five_hour: { used: 0.9, resets_at: "2026-11-21T19:04:00Z" }, seven_day: null });
  expect(s.resume(later(due, 120_000))).toBeNull();
  expect(s.ticket(412).detail).toBe("waiting for plan reset · the 5-hour window still reads 90%, over plan.pause_at (85%)");
  expect(s.ticket(412).resume_at).toBe(due);
  writePlan({ at: later(due, 600_000), five_hour: { used: 0.5, resets_at: "2026-11-21T19:04:00Z" }, seven_day: null });
  expect(s.resume(later(due, 660_000))).toBe(412);
});

test("the weekly limit: it waits for the weekly reset, and says so", () => {
  const s = setup();
  const weekReset = "2026-11-24T09:00:00Z";
  writePlan({ at: NOW, five_hour: { used: 0.3, resets_at: "2026-11-21T14:04:00Z" }, seven_day: { used: 1, resets_at: weekReset } });
  s.screens[s.session(412).terminal] = "You've hit your weekly limit · resets Nov 24, 9am";
  expect(s.watch(412, NOW)).toBe(true);
  const t = s.ticket(412);
  expect(t.resume_at).toBe(later(weekReset, GRACE_MS));
  expect(t.detail).toBe(`waiting for the weekly plan reset · resumes ${whenText(t.resume_at, new Date(NOW))}`);
  expect(t.detail).toMatch(/resumes Nov \d+ \d\d:\d\d$/);
  // the 5-hour window resetting changes nothing
  expect(s.resume("2026-11-21T15:00:00Z")).toBeNull();
  expect(s.resume(later(weekReset, 2 * GRACE_MS))).toBe(412);
  expect(JSON.parse(s.session(412).argv).at(-1)).toContain("was stopped by the plan's weekly limit");
});

test("no reset time in the reading: the next 5-hour boundary from the estimate, and the log says so", () => {
  const s = setup();
  // the window's first message was at 09:40, so it resets at 14:40
  s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('m1', 412, '2026-11-21T09:40:00Z', 'claude-sonnet-5-5', 10, 0, 0, 0, 5, 0)").run();
  writePlan({ at: NOW, five_hour: { used: 1, resets_at: null }, seven_day: null });
  expect(s.watch(412, NOW)).toBe(true);
  expect(s.ticket(412).resume_at).toBe(later("2026-11-21T14:40:00Z", GRACE_MS));
  expect(s.logs.at(-1)).toContain("no reset time in Claude Code's reading: estimated from the 5-hour window");
  expect((s.db.query("SELECT why FROM decisions ORDER BY id DESC LIMIT 1").get() as any).why).toContain("estimated");
  // the stale reading (taken before that reset, with no resets_at) doesn't hold the resume
  expect(s.resume(later("2026-11-21T14:40:00Z", 2 * GRACE_MS))).toBe(412);
  // no reading and no usage at all: five hours from now
  const t = setup({ tickets: [500] });
  t.screens[t.session(500).terminal] = "You've hit your limit · resets 3pm";
  expect(t.watch(500, NOW, { reading: null })).toBe(true);
  expect(t.ticket(500).resume_at).toBe(later(NOW, 5 * 3_600_000 + GRACE_MS));
});

test("a daemon restarted mid-wait picks the wait up from the database", () => {
  const s = setup();
  writePlan({ at: NOW, five_hour: { used: 1, resets_at: "2026-11-21T14:04:00Z" }, seven_day: null });
  expect(s.watch(412, NOW)).toBe(true);
  s.db.close();
  const db = open(s.dbPath);
  const due = later("2026-11-21T14:04:00Z", GRACE_MS);
  expect(resumeWaiting(db, { dir: s.dir, repo: s.repo, run: s.run, now: due })).toBe(412);
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get() as any).n).toBe(1);
  // and once resumed, a second daemon's tick finds nothing to do
  expect(resumeWaiting(db, { dir: s.dir, repo: s.repo, run: s.run, now: later(due, STAGGER_MS) })).toBeNull();
});

test("a working agent under the limit is left alone, and its screen isn't read while it works", () => {
  const s = setup();
  writePlan({ at: NOW, five_hour: { used: 0.5, resets_at: "2026-11-21T14:04:00Z" }, seven_day: null });
  expect(s.watch(412, NOW, { state: "working" })).toBe(false);
  expect(s.calls.some((c) => c[1] === "read")).toBe(false);
  expect(s.watch(412, later(NOW, 1000))).toBe(false); // idle, no message: read, nothing found
  expect(s.calls.filter((c) => c[1] === "read")).toHaveLength(1);
  expect(s.watch(412, later(NOW, 2000))).toBe(false); // read at most every 30s
  expect(s.calls.filter((c) => c[1] === "read")).toHaveLength(1);
  expect(s.ticket(412).resume_at).toBeNull();
});

test("the migration: a database that already has resume_at from the abandoned attempt opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  const file = join(dir, "factory.db");
  const old = new Database(file, { create: true, strict: true });
  for (const m of MIGRATIONS.slice(0, -1)) typeof m === "string" ? old.exec(m) : m(old);
  old.exec("ALTER TABLE tickets ADD COLUMN resume_at TEXT; ALTER TABLE sessions ADD COLUMN outcome TEXT; ALTER TABLE sessions ADD COLUMN prompt_since TEXT;");
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  old.close();
  const db = open(file);
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(MIGRATIONS.length);
  expect((db.query("PRAGMA table_info(tickets)").all() as any[]).filter((c) => c.name === "resume_at")).toHaveLength(1);
  // and a new one gets the column
  const fresh = open(join(dir, "new.db"));
  expect((fresh.query("PRAGMA table_info(tickets)").all() as any[]).some((c) => c.name === "resume_at")).toBe(true);
  expect((fresh.query("SELECT resume_at FROM ticket_lead").all())).toEqual([]);
});
