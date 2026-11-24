import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { TICKET_VIEWS, ticketViews, viewOf, chatSessions, pickSession, chatTarget, chatEmpty, NO_AGENT } from "../lib/ticketchat.js";

// The V2 Chat view (mods/factory-chat): which session it shows, the transcript it reads and the
// terminal it types into, then its real render() against tests/fake-gpui.mjs, and the gate.
const FAKE = pathToFileURL("tests/fake-gpui.mjs").href;
const LIB = pathToFileURL("lib/").href;
const EMPTY = `data:text/javascript,${encodeURIComponent("export default null;")}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "gpui-kit" || spec === "gpui-base" || spec === "herdr") return { url: FAKE, shortCircuit: true };
    if (spec === "./sample.js" || spec === "./sample-reviews.js" || spec === "./lib/cli.js" || spec === "../lib/cli.js") return { url: EMPTY, shortCircuit: true };
    if (spec.startsWith("./lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(6), LIB).href, ctx);
    if (spec.startsWith("../lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(7), LIB).href, ctx);
    if (spec === "./chat/host.js" && ctx.parentURL?.includes("/mods/factory-ticket/")) return next(pathToFileURL("mods/factory-chat/chat/host.js").href, ctx);
    return next(spec, ctx);
  },
});
const { fake, cx, find, text } = await import(FAKE);
const { ChatView, resultWord, splitCode } = await import("../mods/factory-chat/chat/chat.js");

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ROWS = [
  { id: 1, stage: "plan", agent: "planner", terminal: "t2", started_at: "2026-11-20T09:00:00Z", ended_at: "2026-11-20T09:30:00Z", claude_session: "aaaa", transcript: "/p/aaaa.jsonl" },
  { id: 2, stage: "implement", agent: "builder", terminal: "t3", started_at: "2026-11-20T10:00:00Z", ended_at: "2026-11-20T11:00:00Z", claude_session: "bbbb", transcript: "/p/bbbb.jsonl" },
  { id: 3, stage: "implement", agent: "builder", terminal: "t7", started_at: "2026-11-20T11:05:00Z", ended_at: null, claude_session: "cccc", transcript: "/p/cccc.jsonl" },
];
const ticket = (o = {}) => ({ id: 412, state: "running", terminal: "t7", stage: "implement", agent: "builder", ...o });

test("the switcher lists every session oldest first, numbered within its stage, the live one marked", () => {
  const list = chatSessions(ROWS, ticket(), NOW);
  assert.deepEqual(list.map((x) => x.label), ["plan · 1 · Nov 20", "implement · 1 · Nov 20", "implement · 2 · Nov 20"]);
  assert.deepEqual(list.map((x) => x.live), [false, false, true]);
  assert.deepEqual(list.map((x) => x.file), ["/p/aaaa.jsonl", "/p/bbbb.jsonl", "/p/cccc.jsonl"]);
  // An open session whose terminal isn't the ticket's (status.json has moved on) isn't live.
  assert.deepEqual(chatSessions(ROWS, ticket({ terminal: "t9" }), NOW).map((x) => x.live), [false, false, false]);
  assert.deepEqual(chatSessions(null, ticket(), NOW), []);
});

test("the chat shows the session you pick, else the live one, else the newest with a transcript", () => {
  const list = chatSessions(ROWS, ticket(), NOW);
  assert.equal(pickSession(list).id, 3);
  assert.equal(pickSession(list, 1).id, 1);
  assert.equal(pickSession(list, 99).id, 3); // a pick that's gone falls back
  const parked = chatSessions([...ROWS.slice(0, 2), { ...ROWS[2], ended_at: "2026-11-20T12:00:00Z", transcript: null, claude_session: null }], ticket({ terminal: null }), NOW);
  assert.equal(pickSession(parked).id, 2); // the newest with a transcript
  assert.equal(pickSession([]), null);
});

test("the live session reads its transcript and types into the ticket's terminal", () => {
  const list = chatSessions(ROWS, ticket(), NOW);
  assert.deepEqual(chatTarget(ticket(), pickSession(list), { sessions: list }), { file: "/p/cccc.jsonl", terminal: "t7", readonly: false, note: null });
});

test("read-only: no agent running, an earlier session, or sample data", () => {
  const parkedT = ticket({ state: "parked", terminal: null });
  const parked = chatSessions(ROWS.map((r) => ({ ...r, ended_at: r.ended_at ?? "2026-11-20T12:00:00Z" })), parkedT, NOW);
  assert.deepEqual(chatTarget(parkedT, pickSession(parked), { sessions: parked }), { file: "/p/cccc.jsonl", terminal: null, readonly: true, note: NO_AGENT });
  assert.equal(NO_AGENT, "No agent running. Use Talk it through (u) or Answer & resume.");
  const list = chatSessions(ROWS, ticket(), NOW);
  const old = chatTarget(ticket(), pickSession(list, 2), { sessions: list });
  assert.equal(old.terminal, null);
  assert.equal(old.file, "/p/bbbb.jsonl");
  assert.equal(old.note, "An earlier session, read-only. implement · 2 · Nov 20 is live: pick it to message the agent.");
  assert.deepEqual(chatTarget(ticket(), pickSession(list), { daemon: false, sessions: list }).terminal, null);
  assert.match(chatEmpty(null, [], { terminal: null }), /No agent session yet/);
  assert.match(chatEmpty({ cloud: true }, [{}], { terminal: null }), /cloud/);
});

test("the gate: Overview · Chat · Diff only with V2_UI on; ⌘⌥7–9 pick them", () => {
  assert.equal(ticketViews({ ui: { v2: false } }), null);
  assert.equal(ticketViews(null), null);
  assert.deepEqual(ticketViews({ ui: { v2: true } }).map((v) => v.title), ["Overview", "Chat", "Diff"]);
  assert.equal(viewOf("view-chat"), "chat");
  assert.equal(viewOf("tab-1"), null);
  const keys = JSON.parse(readFileSync("keys.json", "utf8"))["layout:factory"];
  for (const v of TICKET_VIEWS) assert.equal(keys[`cmd-alt-${v.key}`], `factory-ticket.view-${v.id}`);
  // ⌘⌥1–6 stay the Overview's tabs, so the new chords take keys nothing else has.
  assert.deepEqual(TICKET_VIEWS.map((v) => v.key), ["7", "8", "9"]);
});

// ── the chat's render ──────────────────────────────────────────────────────

const LINES = [
  { type: "user", cwd: "/w/acme", message: { content: "Add the rate limiter<system-reminder>x</system-reminder>" } },
  { type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "I'll read the config first." }, { type: "tool_use", id: "u1", name: "Read", input: { file_path: "src/app.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "a\nb\nc" }] } },
  { type: "assistant", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "u3", name: "Edit", input: { file_path: "src/limit.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u2", content: "1 failing", is_error: true }, { type: "tool_result", tool_use_id: "u3", content: "ok" }] } },
].map((x) => JSON.stringify(x));

function chat(props, { lines = LINES, terminals = [], prep = () => {} } = {}) {
  fake.terminals = terminals;
  const v = new ChatView();
  v.init(props, cx);
  v.render(cx); // starts the transcript (follow → start); cx.spawn is a no-op here
  for (const l of lines) v.t?.feed(l);
  prep(v);
  const tree = v.render(cx);
  const all = find(tree, () => true);
  return { v, ids: new Set(all.map(({ n }) => n.calls.id?.[0]).filter(Boolean)), words: all.map(({ n }) => text(n)).join("\n") };
}
const props = (o = {}) => ({ ticket: { id: 412, terminal: "t7", state: "running" }, who: "builder", sessions: chatSessions(ROWS, ticket(), NOW), daemon: true, ...o });

test("live: the transcript with folded tool rows, the session switcher and an enabled composer", () => {
  const { v, ids, words } = chat(props(), { terminals: [{ address: "t7", status: "idle" }] });
  assert.equal(v.file, "/p/cccc.jsonl");
  for (const id of ["chat-head", "sessions", "session-1", "session-2", "session-3", "composer", "send", "search", "side-toggle"]) assert.ok(ids.has(id), id);
  assert.ok(!ids.has("composer-disabled"));
  assert.match(words, /Add the rate limiter/);
  assert.doesNotMatch(words, /system-reminder/);
  assert.match(words, /I'll read the config first\./);
  assert.match(words, /3 tool calls · Read, Bash, Edit/); // a turn's calls fold into one line
  assert.doesNotMatch(words, /src\/app\.ts/);
  assert.match(words, /opus-5-5 · live in t7/);
  assert.match(words, /typed into t7/);
});

test("a folded line opens to a row per call: its name, argument and result; a row opens to its output", () => {
  const group = (v) => v.t.entries.find((e) => e.kind === "tools").key;
  const { ids, words } = chat(props(), { prep: (v) => { v.open.add(group(v)); v.open.add(`${group(v)}-t1`); } });
  for (const n of [0, 1, 2]) assert.ok([...ids].some((id) => id.startsWith("tool-") && id.endsWith(`-t${n}`)), `row ${n}`);
  assert.match(words, /Read\nsrc\/app\.ts\n3 lines/);
  assert.match(words, /Bash\nnpm test\nerror/);
  assert.match(words, /~~~~text\n1 failing\n~~~~/); // the opened row's output
  assert.doesNotMatch(words, /~~~~text\na\nb\nc/); // the closed one's isn't drawn
});

test("read-only: no agent running disables the composer with the note", () => {
  const parkedT = ticket({ state: "parked", terminal: null });
  const ended = ROWS.map((r) => ({ ...r, ended_at: r.ended_at ?? "2026-11-20T12:00:00Z" }));
  const { ids, words } = chat(props({ ticket: { id: 412, terminal: null, state: "parked" }, sessions: chatSessions(ended, parkedT, NOW) }));
  assert.ok(ids.has("composer-disabled"));
  assert.ok(!ids.has("send"));
  assert.match(words, /No agent running\. Use Talk it through \(u\) or Answer & resume\./);
  assert.match(words, /read-only/);
  assert.match(words, /I'll read the config first\./); // the transcript still shows
});

test("the switcher: picking an earlier session reads its transcript, read-only", () => {
  const { v, ids, words } = chat(props(), { prep: (v) => v.pick(2, cx) });
  assert.equal(v.file, "/p/bbbb.jsonl");
  assert.ok(ids.has("composer-disabled"));
  assert.match(words, /An earlier session, read-only\. implement · 2 · Nov 20 is live/);
});

test("a question on the terminal: its choices as buttons in the ask card", () => {
  const screen = ["Do you want to make this edit to limit.ts?", "❯ 1. Yes", "  2. Yes, allow all edits this session", "  3. No, and tell Claude what to do differently", "Esc to cancel"].join("\n");
  const { ids, words } = chat(props(), { terminals: [{ address: "t7", status: "blocked" }], prep: (v) => { v.screen = screen; } });
  for (const id of ["question", "choice-0", "choice-1", "choice-2", "key-esc"]) assert.ok(ids.has(id), id);
  assert.match(words, /BUILDER ASKS YOU/);
  assert.match(words, /Yes, allow all edits this session/);
});

test("queued messages show as Queued with Send now and Edit while the agent works", () => {
  const { ids, words } = chat(props(), {
    terminals: [{ address: "t7", status: "working" }],
    lines: [...LINES, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "also cover the login route" })],
    prep: (v) => { v.pending = [{ text: "also cover the login route", users: 1, at: Date.now() }]; },
  });
  for (const id of ["pending-0", "send-now-0", "edit-q-0"]) assert.ok(ids.has(id), id);
  assert.match(words, /Queued · the agent reads it at its next step/);
  assert.match(words, /■ Stop/);
});

test("⌘F search shows only the messages that match", () => {
  const { words, ids } = chat(props(), { prep: (v) => { v.searching = true; v.search = { value: () => "rate limiter", set_value() {}, focus() {}, on() {} }; } });
  assert.ok(ids.has("search-bar"));
  assert.match(words, /Add the rate limiter/);
  assert.doesNotMatch(words, /I'll read the config first/);
  assert.match(words, /1 match\b/);
});

test("a tool row's result in a few words", () => {
  const item = (result, o = {}) => ({ result, error: false, images: [], ...o });
  assert.equal(resultWord(item(null)), "…");
  assert.equal(resultWord(item("boom", { error: true })), "error");
  assert.equal(resultWord(item("a3f91c2")), "a3f91c2");
  assert.equal(resultWord(item("1\n2\n3")), "3 lines");
  assert.equal(resultWord(item("")), "done");
});


test("a reply is cut at its fenced code blocks, each drawn with Copy", () => {
  assert.deepEqual(splitCode("Run this:\n```sh\nnpm test\n```\nThen look."), [{ md: "Run this:" }, { code: "npm test", lang: "sh", fence: "```" }, { md: "Then look." }]);
  assert.deepEqual(splitCode("no code"), [{ md: "no code" }]);
});

// ── the gate on the Ticket page ────────────────────────────────────────────

const status = JSON.parse(readFileSync("fixtures/acme-api/status.json", "utf8"));
const { default: FactoryTicket } = await import("../mods/factory-ticket/main.js");
function page(v2, view) {
  fake.status = { ...structuredClone(status), source: "fixture", ui: { v2 } };
  const p = new FactoryTicket();
  p.init({}, cx);
  if (view) p.view = view;
  p.files = {};
  p.id = p.at = undefined;
  const all = find(p.render(cx), () => true);
  return new Set(all.map(({ n }) => n.calls.id?.[0]).filter(Boolean));
}

test("gate on: the Ticket page has Overview · Chat · Diff; Chat embeds the chat, Diff the diff", () => {
  const ids = page(true);
  for (const id of ["views", "view-overview", "view-chat", "view-diff", "overview", "ticket-left", "ticket-right"]) assert.ok(ids.has(id), id);
  const chatIds = page(true, "chat");
  assert.ok(chatIds.has("chat-view"));
  assert.ok(!chatIds.has("ticket-left"));
  assert.ok(page(true, "diff").has("diff-view"));
});

test("gate off: the page is today's, with no switch and no chat", () => {
  const ids = page(false, "chat");
  for (const id of ["views", "view-chat", "chat-view", "diff-view", "factory-chat"]) assert.ok(!ids.has(id), id);
  assert.ok(ids.has("ticket"));
});
