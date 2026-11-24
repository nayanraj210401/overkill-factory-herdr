import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStatusMd } from "../lib/model.js";
import { answerResumeAsk, dropAsk } from "../lib/actions.js";
import {
  V2_TABS, ticketKind, stageStrip, chips, askShort, askSource, deadline, hardRules, slices, checks, checkCount, readyRules, readyCount,
  diffFiles, activity, agentLine, tokenBar, tail, terminalQuestion, answerKeys, buttons, pageKey, span, cut,
  mdSections, digestView, refTarget, hitRows, memoryKey, rebuildAsk,
} from "../lib/ticketv2.js";

const status = JSON.parse(readFileSync(new URL("../fixtures/acme-api/status.json", import.meta.url)));
const byId = (id) => structuredClone(status.tickets.find((t) => t.id === id));
const file = (id, name) => readFileSync(new URL(`../fixtures/acme-api/tickets/${id}/${name}`, import.meta.url), "utf8");
const now = Date.parse("2026-11-21T10:00:00Z");

// The prototype's four states, from the fixture: 412 runs, 425 is parked, 409 is ready; the
// asks state is 412 with its agent waiting on you in its terminal.
const working = () => byId(412);
const asks = () => ({ ...byId(412), needs: { kind: "attention", text: "implement asks you in its terminal (t7): press e to answer" } });
const parked = () => byId(425);
const ready = () => byId(409);

test("each ticket gets one of the four designs, else other", () => {
  assert.equal(ticketKind(working()), "working");
  assert.equal(ticketKind(asks()), "asks");
  assert.equal(ticketKind(parked()), "parked");
  assert.equal(ticketKind(ready()), "ready");
  // Grooming: asking in a live triage terminal is asks; questions nobody's terminal asks is parked.
  assert.equal(ticketKind({ ...byId(421), terminal: "t3" }), "asks");
  assert.equal(ticketKind(byId(421)), "parked");
  // A parked ticket's live session (talk it through running) asks in its terminal.
  assert.equal(ticketKind({ ...parked(), terminal: "t9", needs: { kind: "attention", text: "asks" } }), "asks");
  for (const id of [430, 431, 401, 405]) assert.equal(ticketKind(byId(id)), "other", `#${id}`);
  assert.equal(ticketKind({ ...working(), state: "paused" }), "other");
  assert.equal(ticketKind(null), "other");
});

test("the stage strip marks done, the stage in hand (pulsing, in the ask colour when it waits on you) and what's left", () => {
  const { stages } = parseStatusMd(file(412, "STATUS.md"));
  const run = stageStrip(stages, working(), "working");
  assert.deepEqual(run.map((s) => s.state), ["done", "done", "done", "now", "next", "next", "next"]);
  assert.deepEqual(run[3], { name: "Implement", state: "now", sub: "working · 12m", pulse: true, asks: false });
  assert.deepEqual(run[0], { name: "Grooming", state: "done", sub: "4m", pulse: false, asks: false });
  assert.equal(run[4].sub, "");
  const ask = stageStrip(stages, asks(), "asks")[3];
  assert.deepEqual([ask.sub, ask.pulse, ask.asks], ["asks you · 12m", true, true]);
  // Parked: no stage is "now" in 425's STATUS.md, so nothing pulses; the rounds note shows.
  const park = stageStrip(parseStatusMd(file(425, "STATUS.md")).stages, parked(), "parked");
  assert.equal(park.find((s) => s.name === "Verify").sub, "11m · failed 4×");
  assert.equal(park.find((s) => s.name === "Implement").sub, "31m · 4 rounds");
  // Ready: the merge waits for you, without a pulse or the ask colour.
  const pr = stageStrip(parseStatusMd(file(409, "STATUS.md")).stages, ready(), "ready").at(-1);
  assert.deepEqual(pr, { name: "Merge", state: "now", sub: "waits for you", pulse: false, asks: false });
  // No STATUS.md yet: the ticket's own stage.
  assert.deepEqual(stageStrip([], working(), "working").map((s) => [s.name, s.state]), [["Implement", "now"]]);
  assert.deepEqual(stageStrip([], byId(431), "other"), []);
});

test("chips: blueprint, source, deadline, spend against the budget, hard rules", () => {
  const t = working();
  assert.deepEqual(chips(t, "acme/api", {}, now).map((c) => [c.id, c.value, c.tone]), [
    ["blueprint", "feature", null],
    ["source", "issue #412", null],
    ["spend", "$1.80 · 2.5M of 3M in", "warn"], // 83% used: the daemon warns
  ]);
  assert.equal(chips(t, "acme/api", {}, now)[1].url, "https://github.com/acme/api/issues/412");
  const goal = { ...t, id: 10000, title: "Migrate railway.json to config-as-code before 2026-12-01", warning: null, usd: 0.49, tokens: { input: 108000, output: 9000 } };
  const files = { "INTENT.md": "## Goal\n\nRun railway config migrate. Do not deploy; keep the same healthcheck.\n\n## Hard rules\n\n- Keep the same restart settings.\n" };
  assert.deepEqual(chips(goal, "acme/api", files, now).map((c) => [c.id, c.value, c.tone]), [
    ["blueprint", "feature", null],
    ["source", "your goal", null],
    ["deadline", "deadline 2026-12-01 · 10 days", "warn"],
    ["spend", "$0.49 · 108k of 3M in", null],
    ["rule-0", "keep the same restart settings", "rule"],
    ["rule-1", "don't deploy", "rule"],
  ]);
});

test("a deadline is read from the title or the ticket's notes, with the days left", () => {
  assert.equal(deadline({ title: "Ship it" }, {}, now), null);
  assert.deepEqual(deadline({ title: "x" }, { "GROOMING.md": "Deadline: 2026-11-20." }, now), { date: "2026-11-20", days: -1, text: "deadline 2026-11-20 · passed 1d ago", warn: true });
  assert.equal(deadline({ title: "by 2027-03-01" }, {}, now).warn, false);
});

test("hard rules come from a rules section and don't-sentences, deduped and capped at three", () => {
  assert.deepEqual(hardRules({}), []);
  const g = "# Triage\n\nNever touch the billing tables. Don't deploy. Do not deploy.\n\n## Constraints\n\n- No new dependencies\n- Keep the API stable\n";
  assert.deepEqual(hardRules({ "GROOMING.md": g }), ["no new dependencies", "keep the API stable", "don't touch the billing tables"]);
});

test("the ask, short: INTENT.md's Goal, else GROOMING.md's first paragraph, cut at a sentence", () => {
  assert.equal(askShort({}), null);
  assert.equal(askShort({ "GROOMING.md": "# Triage\n\nPer-user limit, **60 s** window.\n\n## Decisions\n" }), "Per-user limit, 60 s window.");
  assert.equal(askShort({ "INTENT.md": "## Decisions\n\nNone.\n\n## Goal\n\nUsers who fail login 5 times wait a minute.\n" }), "Users who fail login 5 times wait a minute.");
  const long = `${"A sentence that goes on. ".repeat(20)}`;
  assert.ok(askShort({ "INTENT.md": `## Goal\n\n${long}` }).length <= 280);
  assert.equal(cut("one two three four", 9), "one two…");
});

test("the ask's source: an issue, a split's part, or your goal", () => {
  assert.equal(askSource({ id: 412 }, "acme/api", {}).url, "https://github.com/acme/api/issues/412");
  assert.equal(askSource({ id: 10003 }, "acme/api", { "GROOMING.md": "# Part 2 of 3 of #412: Pages\n\nscope" }).chip, "part 2 of #412");
  assert.deepEqual(askSource({ id: 10000 }, "acme/api", {}), { chip: "your goal", line: "A goal you typed (factory new); its first words are the title.", url: null });
});

test("Plan: SLICES.md's slices as done, the one in hand, or still to do", () => {
  const rows = slices(file(412, "SLICES.md"), working(), "working");
  assert.deepEqual(rows.map((s) => [s.n, s.title, s.state]), [[1, "S1 Counter store", "done"], [2, "S2 Middleware", "now"], [3, "S3 429 page", "next"]]);
  assert.equal(rows[1].note, "src/middleware/limit.ts returns 429 after 5 attempts.");
  // The planner's format: headed slices with a Status line.
  const md = "# Slices\n\n## S1 · Add the setting\n\nChanges config.ts.\n- **Status**: [x]\n\n## S2 · Use it\n\nChanges run.ts.\n- **Status**: [ ]\n";
  assert.deepEqual(slices(md, { state: "running" }, "working").map((s) => [s.title, s.state, s.note]), [["S1 · Add the setting", "done", "Changes config.ts."], ["S2 · Use it", "now", "Changes run.ts."]]);
  assert.deepEqual(slices(md, { state: "ready" }, "ready").map((s) => s.state), ["done", "done"]);
  assert.deepEqual(slices(md, { state: "queued" }, "other").map((s) => s.state), ["done", "next"]);
  assert.deepEqual(slices(null, working(), "working"), []);
  // The daemon's slice in hand is already marked done in SLICES.md: the next open one is in hand.
  assert.deepEqual(slices(file(412, "SLICES.md"), { ...working(), slice: { n: 1, of: 3 } }, "working").map((s) => s.state), ["done", "now", "next"]);
});

test("Checks: EVIDENCE.md's checks and verdicts, each with its result", () => {
  const rows = checks(file(412, "EVIDENCE.md"));
  assert.deepEqual(rows.map((r) => [r.name, r.result, r.detail]), [
    ["npm test -- limit", "pass", "(14)"], ["C1: 6th login in 60 s gets 429", "pass", ""], ["C2: other users unaffected", "pending", ""], ["C3: retry-after header set", "pending", ""],
  ]);
  assert.equal(checkCount(rows), "2/4");
  const daemon = "# Evidence\n\n| Check | Result | Detail | When |\n| --- | --- | --- | --- |\n| `tests` | ✗ FAIL | exit 1: a \\| b | 2026-11-21 09:30 |\n| `lint` | ⚠ BROKEN | can't run | 2026-11-21 09:31 |\n\n## Verdicts\n\n| Kind | From | Result | Detail | When |\n| --- | --- | --- | --- | --- |\n| holdout | checker | ✓ PASS | 3 of 3 | 2026-11-21 09:40 |\n";
  assert.deepEqual(checks(daemon).map((r) => [r.name, r.result, r.detail, r.when]), [
    ["tests", "fail", "exit 1: a | b", "2026-11-21 09:30"], ["lint", "broken", "can't run", "2026-11-21 09:31"], ["holdout · checker", "pass", "3 of 3", "2026-11-21 09:40"],
  ]);
  assert.equal(checkCount([]), "");
});

test("the ready rules, from factory ready or the ticket's detail", () => {
  assert.deepEqual(readyRules("✓ evidence: 4 checks pass after the last commit\n✗ template: PR.md is missing\n– ci: not checked\njunk"), [
    { rule: "evidence", result: "pass", detail: "4 checks pass after the last commit" }, { rule: "template", result: "fail", detail: "PR.md is missing" }, { rule: "ci", result: "skipped", detail: "not checked" },
  ]);
  assert.equal(readyCount(ready()), "6 of 6 ready rules");
  assert.equal(readyCount(working()), null);
});

test("files changed: each file's status and line counts, from git diff", () => {
  const diff = ["diff --git a/railway.toml b/railway.toml", "new file mode 100644", "--- /dev/null", "+++ b/railway.toml", "@@ -0,0 +1,2 @@", "+a", "+b",
    "diff --git a/railway.json b/railway.json", "deleted file mode 100644", "--- a/railway.json", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
    "diff --git a/src/a.js b/src/a.js", "--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "-old", "+new"].join("\n");
  const d = diffFiles(diff);
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.add, f.del]), [["A", "railway.toml", 2, 0], ["D", "railway.json", 0, 1], ["M", "src/a.js", 1, 1]]);
  assert.equal(d.text, "3 · +3 −2");
  assert.equal(diffFiles("").text, "");
});

test("Activity: the journal's events newest first, each with its time and mark", () => {
  const rows = activity(working().events, now);
  assert.equal(rows.length, 8);
  const local = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  assert.deepEqual(rows[0], { time: local("2026-11-21T09:48:00Z"), mark: "●", tone: "accent", text: "implement session 2 started (builder): after a handoff at 61%" });
  assert.deepEqual(rows.find((r) => r.text.startsWith("tests")), { time: local("2026-11-21T09:30:00Z"), mark: "✗", tone: "bad", text: "tests FAIL: exit 1: login.test.ts: expected 429, got 200" });
  assert.equal(rows.at(-1).mark, "○"); // groomed, the oldest
  assert.equal(activity(working().events, now, 3).length, 3);
  assert.deepEqual(activity([{ kind: "verdict", text: "holdout PASS from checker", at: "2026-11-19T10:00:00Z" }], now)[0].mark, "✓");
  assert.match(activity([{ kind: "pr", text: "PR #5 opened", at: "2026-11-19T10:00:00Z" }], now)[0].time, /^Nov 19$/);
  assert.deepEqual(activity(undefined, now), []);
});

test("the agent line names who runs which stage, and the time, per state", () => {
  assert.deepEqual(agentLine(working(), "working", undefined, now), { tone: "working", who: "builder · implement · S2 of 3", time: "24m so far · session 2" });
  const a = asks();
  a.events.push({ kind: "attention", text: "implement asks you in its terminal (t7)", at: "2026-11-21T09:46:00Z" });
  assert.deepEqual(agentLine(a, "asks", a.events, now), { tone: "ask", who: "builder · implement · asks you", time: "waiting 14m" });
  assert.deepEqual(agentLine(parked(), "parked", undefined, now), { tone: "ask", who: "no agent running", time: "parked 48m" });
  assert.deepEqual(agentLine(ready(), "ready", undefined, now), { tone: "ok", who: "done · waits for your merge", time: "ready 2m ago" });
  assert.equal(agentLine(byId(418), "working", undefined, now).who, "checker · verify · in the cloud");
  assert.equal(agentLine(byId(430), "other", undefined, now).who, "waits on #425");
  assert.equal(span("2026-11-19T07:00:00Z", now), "2d 3h");
});

test("the token bar: input and output against their budgets, cost, session and the context note", () => {
  assert.deepEqual(tokenBar(working()), { input: 2.5 / 3, output: 64000 / 150000, left: "2.5M in · 64k out · $1.80", right: "session 2 · handoff at 60%", warn: true });
  assert.equal(tokenBar(ready()).right, "");
  assert.equal(tokenBar({ ...ready(), tokens: { input: 9e9, output: 0 } }).input, 1);
});

// What Claude Code's question tool draws, as hc read prints it.
const SCREEN = `⏺ Bash(railway config migrate)
  ⎿  Unauthorized. Please run \`railway login\`.

────────────────────────────────────────
 ☐ Login

The CLI needs railway login, which opens a browser. How should I get the generated file?

❯ 1. I'll log in now
     Run railway login yourself; I retry when it says logged in.
  2. Write railway.toml by hand
     Copy each setting from railway.json; I diff both to prove they match.
  3. Type something.

Enter to select · ↑/↓ to navigate · Esc to cancel


`;

test("the terminal's tail drops trailing blank lines and colour codes", () => {
  assert.deepEqual(tail("a\n\x1b[32mb\x1b[0m  \n\n\n", 5), ["a", "b"]);
  assert.equal(tail(SCREEN, 3).at(-1), "Enter to select · ↑/↓ to navigate · Esc to cancel");
});

test("the question card reads the question and its options from the live screen", () => {
  const q = terminalQuestion(tail(SCREEN, 40));
  assert.equal(q.question, "The CLI needs railway login, which opens a browser. How should I get the generated file?");
  assert.deepEqual(q.options, [
    { n: 1, label: "I'll log in now", detail: "Run railway login yourself; I retry when it says logged in." },
    { n: 2, label: "Write railway.toml by hand", detail: "Copy each setting from railway.json; I diff both to prove they match." },
  ]);
  assert.equal(q.free, 3);
  assert.equal(terminalQuestion(["⏺ Read(a.js)", "  1. not a menu"]), null);
  assert.equal(terminalQuestion([]), null);
});

test("Send types the pick or your words into the live terminal", () => {
  const q = terminalQuestion(tail(SCREEN, 40));
  assert.deepEqual(answerKeys("t7", q, 2, ""), [["keys", "t7", "2"]]);
  assert.deepEqual(answerKeys("t7", q, 2, "  use a token  "), [["keys", "t7", "3"], ["send", "--force", "t7", "use a token"]]);
  assert.deepEqual(answerKeys("t7", null, null, "yes, go on"), [["send", "--force", "t7", "yes, go on"]]);
  assert.deepEqual(answerKeys("t7", q, null, " "), []);
});

test("each state has its buttons, with the keys that do the same", () => {
  const ids = (t) => buttons(t, ticketKind(t)).map((b) => `${b.label} ${b.key}`);
  assert.deepEqual(ids(working()), ["Open live terminal e", "Diff d", "Pause p"]);
  assert.deepEqual(ids(asks()), ["Answer in terminal e", "Diff d", "Pause p"]);
  assert.deepEqual(ids({ ...parked(), questions: [{ n: 1, kind: "engineering", text: "Which?" }] }), ["Talk it through u", "Diff d", "Close x"]);
  assert.deepEqual(ids(parked()), ["Answer and restart u", "Diff d", "Close x"]); // retries used up: no question to talk through
  assert.deepEqual(ids(byId(421)), ["Talk it through u"]); // grooming: no diff, nothing to close here
  assert.deepEqual(ids(ready()), ["Open PR o", "Diff d", "Send back b", "Merge m"]);
  assert.deepEqual(ids({ ...working(), state: "paused" }), ["Diff d", "Resume p"]);
  assert.deepEqual(buttons(working(), "working")[0].action, { kind: "terminal" });
  assert.deepEqual(buttons(parked(), "parked").at(-1).action, { kind: "drop" });
});

test("the page's keys follow its buttons: x closes a parked ticket, b sends a ready one back", () => {
  assert.deepEqual(pageKey({ kind: "send-back" }, parked(), "parked"), { kind: "drop" });
  assert.deepEqual(pageKey({ kind: "budget" }, ready(), "ready"), { kind: "send-back" });
  assert.deepEqual(pageKey({ kind: "send-back" }, ready(), "ready"), { kind: "send-back" });
  assert.deepEqual(pageKey({ kind: "budget" }, working(), "working"), { kind: "budget" });
  assert.equal(pageKey(null, working(), "working"), null);
});

test("the inline answer goes to factory answer through the dialog, prefilled", () => {
  const a = answerResumeAsk(parked(), "  skip the flaky upload test  ");
  assert.deepEqual([a.args, a.input.value, a.confirm], [["answer", "425"], "skip the flaky upload test", "Answer and restart"]);
  assert.equal(answerResumeAsk(byId(421), "keep the old index").confirm, "Answer");
  assert.deepEqual(answerResumeAsk(parked(), " "), { error: "Type an answer first" });
  assert.deepEqual(answerResumeAsk(working(), "x"), { error: "#412 isn't waiting for an answer" });
  assert.deepEqual(dropAsk(parked()).args, ["drop", "425"]);
  assert.deepEqual(dropAsk(byId(401)), { error: "#401 is merged already" });
});

test("six tabs: The ask, then Memory", () => {
  assert.deepEqual(V2_TABS.map((t) => `${t.key} ${t.title}`), ["1 Plan", "2 Checks", "3 Questions", "4 PR", "5 The ask", "6 Memory"]);
});

test("Markdown sections: headings become labels; an empty title heading and fenced # lines are not headings", () => {
  assert.deepEqual(mdSections(readFileSync(new URL("../fixtures/acme-api/tickets/412/GATES.md", import.meta.url), "utf8")).map((s) => s.heading), ["Questions", "Decisions made for you"]);
  assert.deepEqual(mdSections("# GATES\n\n## Questions\n\n- **Q1** (product): which?\n"), [{ heading: "Questions", body: "- **Q1** (product): which?" }]);
  assert.deepEqual(mdSections("Lead line.\n\n## `Current` state ##\n```sh\n# a comment\n```"), [{ heading: null, body: "Lead line." }, { heading: "Current state", body: "```sh\n# a comment\n```" }]);
  assert.deepEqual(mdSections(null), []);
});

const NOW = Date.parse("2026-11-24T12:00:00Z");
const D = "## Decisions and why\n- A sliding window.\n## Current state\n- Spec written.";

test("the digest view: its age, whose it is, and your edits", () => {
  const own = digestView({ text: D, at: "2026-11-24T11:48:00Z", event: 9, from: 412, edited: null }, 412, NOW);
  assert.equal(own.state, "own");
  assert.equal(own.age, "updated 12m ago");
  assert.deepEqual(own.sections.map((s) => s.heading), ["Decisions and why", "Current state"]);
  assert.deepEqual(own.notes, []);
  assert.equal(own.edited, false);
  const edited = digestView({ text: D, at: "2026-11-24T11:58:00Z", event: 9, from: 412, edited: "2026-11-24T10:00:00Z" }, 412, NOW);
  assert.equal(edited.edited, true);
  assert.match(edited.notes[0], /^Has your edits \(2h ago\): every rewrite keeps your corrections/);
  // A parent's: says so, and an edit there is the parent's, not this ticket's.
  const inherited = digestView({ text: D, at: "2026-11-23T12:00:00Z", event: null, from: 412, edited: "2026-11-23T12:00:00Z" }, 10003, NOW);
  assert.equal(inherited.state, "inherited");
  assert.equal(inherited.age, "updated 1d ago");
  assert.match(inherited.notes[0], /^Inherited from #412: /);
  assert.equal(inherited.edited, false);
  assert.equal(digestView(null, 412, NOW).state, "none");
});

test("a hit's ref: a transcript line, a file, a tab, GitHub, or nothing", () => {
  assert.deepEqual(refTarget("transcript:/u/.claude/projects/x/s.jsonl#L42", "acme/api"), { open: "file", path: "/u/.claude/projects/x/s.jsonl", line: 42, label: "transcript · line 42" });
  assert.deepEqual(refTarget("transcript:/u/s.jsonl", "acme/api"), { open: "file", path: "/u/s.jsonl", line: null, label: "transcript" });
  assert.deepEqual(refTarget("file:/f/tickets/412/GROOMING.md", null), { open: "file", path: "/f/tickets/412/GROOMING.md", line: null, label: "GROOMING.md" });
  assert.deepEqual(refTarget("file:TICKET-MEMORY.md", null), { open: "tab", tab: "6", label: "the digest" });
  assert.deepEqual(refTarget("question:2", null), { open: "tab", tab: "3", label: "Q2" });
  assert.deepEqual(refTarget("evidence:17", null), { open: "tab", tab: "2", label: "Checks" });
  assert.equal(refTarget("pr:511", "acme/api").url, "https://github.com/acme/api/pull/511");
  assert.equal(refTarget("issue:412", "acme/api").url, "https://github.com/acme/api/issues/412");
  assert.equal(refTarget("commit:abc1234def", "acme/api").label, "abc1234");
  for (const r of ["session:3", "decision:9", "ask:2", null, "", "pr:511"]) assert.equal(refTarget(r, r === "pr:511" ? null : "acme/api"), null, String(r));
});

test("hit rows: who or what, the snippet, when, and where a click goes", () => {
  const rows = hitRows([
    { ticket: 412, source: "transcript", kind: "user", snippet: "use a  [sliding]\nwindow", ref: "transcript:/t/s.jsonl#L7", at: "2026-11-24T10:05:00Z", rank: -3 },
    { ticket: 412, source: "journal", kind: "answer", snippet: "A1 from you: [sliding]", ref: "question:1", at: "2026-11-20T10:00:00Z", rank: -2 },
    { ticket: 412, source: "journal", kind: "session-end", snippet: "spec session [ended]", ref: "session:4", at: null, rank: -1 },
  ], "acme/api", NOW);
  assert.deepEqual(rows.map((r) => [r.who, r.mark, r.snippet, r.where, r.target?.open ?? null]), [
    ["you", "❝", "use a [sliding] window", "transcript · line 7", "file"],
    ["answer", "↩", "A1 from you: [sliding]", "Q1", "tab"],
    ["session-end", "■", "spec session [ended]", "session", null],
  ]);
  assert.equal(rows[1].time, "Nov 20");
  assert.equal(rows[2].time, "");
  assert.deepEqual(hitRows(null), []);
});

test("the digest reloads when the journal grows; Rebuild on your edit asks first", () => {
  const t = byId(412);
  const k = memoryKey(t);
  assert.equal(memoryKey(t), k);
  assert.notEqual(memoryKey({ ...t, events: [...t.events.slice(1), { kind: "digest-edit", text: "you edited the digest", at: "2026-11-24T12:00:00Z" }] }), k);
  assert.deepEqual(rebuildAsk(t).args, ["digest", "412", "--rebuild"]);
  assert.match(rebuildAsk(t).detail, /your corrections are kept/);
  assert.deepEqual(activity([{ kind: "digest-edit", text: "you edited the digest", at: "2026-11-24T11:00:00Z" }], NOW).map((e) => e.mark), ["✎"]);
});
