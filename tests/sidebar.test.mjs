import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarView, waitingLine, workingLine, quietLine, elapsed, age, tickMs, rowTitle, SETTLED_MAX, threadTarget, chatUnread, seenNext } from "../lib/sidebar.js";

const status = JSON.parse(readFileSync(new URL("../fixtures/acme-api/status.json", import.meta.url)));
const now = Date.parse("2026-11-21T10:00:00Z");
const ticket = (o) => ({ id: 1, title: "T", state: "queued", blueprint: "feature", stage: null, detail: null, updated_at: "2026-11-21T09:00:00Z",
  tokens: { input: 0, output: 0 }, budget: { input: 1, output: 1 }, usd: 0, where: "local", pr: null, blocked_by: null, needs: null, ...o });
const of = (s, roster = []) => sidebarView(s, roster, now);
const view = (tickets, roster) => of({ factory: { name: "acme-api" }, tickets }, roster);

test("the sample: waiting on you first, then what works, the queue as one line, the week's settled", () => {
  const v = of(status);
  assert.deepEqual(v.waiting.map((r) => [r.ticket, r.kind]), [[421, "ask"], [409, "ready"], [425, "parked"]]);
  assert.deepEqual(v.waiting.map((r) => r.sub), ["grooming · 3 questions for you", "PR #511 ready to merge · 6 of 6 rules", "parked · retries used up in verify"]);
  assert.deepEqual(v.working.map((r) => [r.ticket, r.sub]), [[412, "builder · implement (S2 of 3)"], [418, "checker · verify · ☁ cloud"]]);
  assert.equal(elapsed(v.working[0].since, now), "24m");
  assert.equal(v.quiet.text, "3 queued · 1 blocked by #425 →");
  assert.deepEqual(v.settled.map((r) => [r.ticket, r.age]), [[401, "merged 17h"], [405, "closed 1d"]]);
  assert.equal(rowTitle(v.waiting[0]), "#421 Search index rebuild");
});

test("every group empty: nothing waits, Working is empty, no quiet line, nothing settled", () => {
  const v = view([]);
  assert.deepEqual([v.waiting, v.working, v.quiet, v.settled, v.settledCount], [[], [], null, [], 0]);
  assert.deepEqual(of(null), { waiting: [], working: [], quiet: null, settled: [], settledCount: 0 });
});

test("a stage agent waiting on you in its terminal is in Waiting on you, not Working", () => {
  const t = ticket({ id: 7, state: "running", stage: "implement", agent: "builder", needs: { kind: "attention", text: "asks" } });
  const v = view([t]);
  assert.deepEqual(v.waiting.map((r) => [r.ticket, r.kind, r.sub]), [[7, "ask", "builder asks you · implement"]]);
  assert.deepEqual(v.working, []);
  assert.equal(waitingLine("attention", { stage: "verify" }), "its agent asks you · verify");
});

test("global agents: a blocked one waits on you, a working one works, another factory's doesn't show", () => {
  const roster = [
    { factory: null, agent: "overwatch", tier: "global", status: "waiting", terminal: "t3", ticket: null },
    { factory: null, agent: "maintainer", tier: "global", status: "working", terminal: "t9", ticket: null, started_at: "2026-11-21T09:59:20Z" },
    { factory: "acme-api", agent: "learner", tier: "global", status: "working", ticket: { id: 3, title: "X" }, stage: "learn", started_at: null },
    { factory: "shop", agent: "babysitter", tier: "global", status: "working", ticket: null },
    { factory: "acme-api", agent: "builder", tier: "repo", status: "working", ticket: { id: 3, title: "X" } }, // a ticket's own agent: its ticket row covers it
    { factory: null, agent: "maintainer", tier: "global", status: "idle", ticket: null },
  ];
  const v = view([], roster);
  assert.deepEqual(v.waiting.map((r) => [r.agent, r.kind, r.sub, r.terminal]), [["overwatch", "ask", "asks you · in its terminal", "t3"]]);
  assert.deepEqual(v.working.map((r) => [r.agent, r.sub]), [["maintainer", "factory agent · every factory"], ["learner", "learn · #3 X"]]);
  assert.equal(rowTitle(v.working[0]), "maintainer");
  assert.equal(elapsed(v.working[0].since, now), "40s");
  assert.equal(tickMs(v.working, now), 1000, "seconds on screen: redraw every second");
  assert.equal(tickMs([], now), 5000);
});

test("a cloud ticket says so, a plan-stopped one says when it resumes, one with nothing known still reads", () => {
  assert.equal(workingLine(ticket({ state: "running", stage: "verify", where: "cloud" })), "verify · ☁ cloud");
  assert.match(workingLine(ticket({ state: "running", stage: "implement", agent: "builder", resume_at: "2026-11-21T14:05:00" })), /^builder · implement · plan reset · resumes 14:05$/);
  assert.equal(workingLine(ticket({ state: "running" })), "starting");
  const v = view([ticket({ id: 2, state: "running", stage: "plan", resume_at: "2026-11-21T14:05:00Z" })]);
  assert.equal(v.working[0].idle, true);
  assert.equal(v.working[0].since, null);
  assert.equal(elapsed(null, now), null, "no stage start: no timer");
});

test("a long title is kept whole for the row (the mod truncates it) and stays out of the second line", () => {
  const long = "Rebuild the search index without downtime ".repeat(10);
  const v = view([ticket({ id: 9, title: long, state: "running", stage: "implement", agent: "builder" })]);
  assert.equal(rowTitle(v.working[0]), `#9 ${long}`);
  assert.equal(v.working[0].sub, "builder · implement");
});

test("the quiet line: queued, paused and question-free grooming wait their turn; blockers named when one", () => {
  assert.equal(quietLine([]), null);
  assert.equal(quietLine([ticket({ state: "queued" }), ticket({ state: "paused" }), ticket({ state: "grooming" })]).text, "3 queued →");
  assert.equal(quietLine([ticket({ state: "blocked", blocked_by: 4 }), ticket({ state: "blocked", blocked_by: 5 })]).text, "2 blocked →");
  assert.equal(quietLine([ticket({ state: "blocked", blocked_by: 4 })]).text, "1 blocked by #4 →");
  assert.equal(quietLine([ticket({ state: "grooming", needs: { kind: "question", text: "q" } })]), null, "a question waits on you, not in the queue");
});

test("Settled: the past 7 days' merged and closed, newest first, at most 10", () => {
  const ts = Array.from({ length: 14 }, (_, i) => ticket({ id: i + 1, state: i % 2 ? "closed" : "merged", updated_at: new Date(now - (i + 1) * 3600_000).toISOString() }));
  ts.push(ticket({ id: 99, state: "merged", updated_at: "2026-11-01T00:00:00Z" })); // three weeks ago
  const v = view(ts);
  assert.equal(v.settled.length, SETTLED_MAX);
  assert.equal(v.settledCount, 14);
  assert.deepEqual(v.settled.slice(0, 2).map((r) => [r.ticket, r.age]), [[1, "merged 1h"], [2, "closed 2h"]]);
  assert.ok(!v.settled.some((r) => r.ticket === 99));
});

test("ages and timers read short", () => {
  assert.deepEqual(["2026-11-21T10:00:00Z", "2026-11-21T09:55:00Z", "2026-11-21T07:00:00Z", "2026-11-18T10:00:00Z"].map((x) => age(x, now)), ["now", "5m", "3h", "3d"]);
  assert.deepEqual(["2026-11-21T09:59:58Z", "2026-11-21T08:55:00Z", "2026-11-19T07:00:00Z"].map((x) => elapsed(x, now)), ["2s", "1h 5m", "2d 3h"]);
  assert.equal(waitingLine("merge", ticket({ state: "ready" })), "ready to merge");
});

// ── the sidebar as the chat's thread list (V2_UI) ──────────────────────────

test("a thread click opens its ticket on Chat only with the gate on and the Ticket page on Chat", () => {
  const v = of(status);
  const [ask] = v.waiting;
  const [work] = v.working;
  const settled = v.settled[0];
  const onChat = { v2: true, page: "ticket", view: "chat" };
  assert.deepEqual(threadTarget(ask, onChat), { ticket: 421, view: "chat" });
  assert.deepEqual(threadTarget(work, onChat), { ticket: 412, view: "chat" });
  // Settled rows aren't threads: they open as today.
  assert.deepEqual(threadTarget(settled, onChat), { ticket: settled.ticket, view: null });
  // Any one of the three missing, and the ticket opens as it does today.
  assert.deepEqual(threadTarget(work, { ...onChat, v2: false }), { ticket: 412, view: null });
  assert.deepEqual(threadTarget(work, { ...onChat, view: "overview" }), { ticket: 412, view: null });
  assert.deepEqual(threadTarget(work, { ...onChat, view: "diff" }), { ticket: 412, view: null });
  assert.deepEqual(threadTarget(work, { ...onChat, page: "home" }), { ticket: 412, view: null });
  assert.deepEqual(threadTarget(work), { ticket: 412, view: null });
  // Global agents open as they always have, whatever the page shows.
  const maint = view([], [{ agent: "maintainer", tier: "global", status: "working", factory: null, terminal: "t9" }]).working[0];
  assert.deepEqual(threadTarget(maint, onChat), { agent: "maintainer" });
});

test("chat-unread: the live transcript grew since this viewer last saw it, or a new session wrote", () => {
  const t = { id: 412, transcript: "/p/c.jsonl" };
  const seen = { 412: { file: "/p/c.jsonl", size: 100 } };
  assert.equal(chatUnread(t, seen, 100), false);
  assert.equal(chatUnread(t, seen, 140), true);
  assert.equal(chatUnread({ ...t, transcript: "/p/d.jsonl" }, seen, 10), true); // a handoff's next session
  assert.equal(chatUnread({ ...t, transcript: "/p/d.jsonl" }, seen, 0), false); // ...with nothing in it yet
  assert.equal(chatUnread(t, {}, 140), false); // never sighted: no marker until a baseline
  assert.equal(chatUnread(t, seen, null), false); // not read yet
  assert.equal(chatUnread({ id: 412, transcript: null }, seen, 140), false); // no live session
});

test("seen: a first sighting is the baseline, the ticket on screen is read, gone ones drop out", () => {
  const sizes = { "/p/a.jsonl": 50, "/p/b.jsonl": 90 };
  const rows = [{ id: 1, transcript: "/p/a.jsonl" }, { id: 2, transcript: "/p/b.jsonl" }, { id: 3, transcript: null }];
  const first = seenNext({}, rows, sizes);
  assert.deepEqual(first, { 1: { file: "/p/a.jsonl", size: 50 }, 2: { file: "/p/b.jsonl", size: 90 } });
  assert.equal(seenNext(first, rows, sizes), first); // nothing changed: the same object, no write
  const grown = { ...sizes, "/p/b.jsonl": 120 };
  const kept = seenNext(first, rows, grown);
  assert.equal(kept, first); // grown but not viewed: the old size stays, so it shows as unread
  assert.equal(chatUnread(rows[1], kept, grown["/p/b.jsonl"]), true);
  const read = seenNext(first, rows, grown, 2); // its chat is on screen
  assert.deepEqual(read[2], { file: "/p/b.jsonl", size: 120 });
  assert.equal(chatUnread(rows[1], read, grown["/p/b.jsonl"]), false);
  assert.deepEqual(Object.keys(seenNext(read, rows.slice(1), grown)), ["2"]); // #1 left the sidebar
  assert.deepEqual(seenNext(first, rows, {}), first); // sizes not read: kept as they were
});
