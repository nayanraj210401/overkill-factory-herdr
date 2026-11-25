import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { TICKET_VIEWS, ticketViews, viewOf, chatSessions, pickSession, chatTarget, chatEmpty, ownChat, NO_AGENT, askedView, panelOpen, panelShown, shortDigest, chatPanel, VIEW_KEY, OPEN_KEY, PANEL_KEY, PANEL_MIN } from "../lib/ticketchat.js";

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
  assert.equal(NO_AGENT, "No agent running. Press + to open your own session, or use Talk it through (u) or Answer & resume.");
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
  assert.match(words, /No agent running\. Press \+ to open your own session, or use Talk it through \(u\) or Answer & resume\./);
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

// ── phase 2: the sidebar as the thread list, and the Changes + ticket memory panel ─────────

test("a sidebar click's ask opens this ticket on its view while fresh; ⌘⌥0 toggles the panel", () => {
  const at = NOW - 2000;
  assert.equal(askedView({ id: 412, view: "chat", at }, 412, NOW), "chat");
  assert.equal(askedView({ id: 412, view: "chat", at }, 418, NOW), null); // another ticket's
  assert.equal(askedView({ id: 412, view: "chat", at: NOW - 60_000 }, 412, NOW), null); // stale, from before a restart
  assert.equal(askedView({ id: 412, view: "nope", at }, 412, NOW), null);
  assert.equal(askedView(null, 412, NOW), null);
  const keys = JSON.parse(readFileSync("keys.json", "utf8"))["layout:factory"];
  assert.equal(keys["cmd-alt-0"], "factory-ticket.chat-panel");
  assert.equal(Object.keys(keys).filter((k) => keys[k] === "factory-ticket.chat-panel").length, 1);
});

test("the panel: open unless this viewer closed it, folded away on a narrow Chat view", () => {
  assert.equal(panelOpen(null), true);
  assert.equal(panelOpen(true), true);
  assert.equal(panelOpen(false), false);
  assert.equal(panelShown(true, PANEL_MIN + 200), true);
  assert.equal(panelShown(true, PANEL_MIN - 1), false);
  assert.equal(panelShown(true, 0), true); // not measured yet
  assert.equal(panelShown(false, 2000), false);
});

const DIGEST = { from: 412, at: "2026-11-22T11:00:00Z", edited: null,
  text: "## Decisions and why\n- Token bucket, not fixed window\n- none\n## Open questions\n- none\n## Current state\n- S2 middleware half done\n- tests red on burst\n- a\n- b" };
const DIFF = "diff --git a/src/limit.ts b/src/limit.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/limit.ts\n@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n"
  + "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";

test("the panel's content: files changed with +/−, the digest short (Current state first), the last events", async () => {
  const { diffFiles, mdSections } = await import("../lib/ticketv2.js");
  const short = shortDigest(mdSections(DIGEST.text));
  assert.deepEqual(short.map((x) => x.heading), ["Current state", "Decisions and why"]); // "- none" only: Open questions left out
  assert.deepEqual(short[0].lines, ["- S2 middleware half done", "- tests red on burst", "- a"]); // three lines a section
  const events = [1, 2, 3, 4, 5, 6].map((n) => ({ kind: "stage", text: `event ${n}`, at: "2026-11-22T10:00:00Z" }));
  const p = chatPanel({ ticket: ticket({ events }), diff: diffFiles(DIFF), memory: { digest: DIGEST }, now: NOW });
  assert.deepEqual(p.changes.files.map((f) => [f.status, f.path, f.add, f.del]), [["A", "src/limit.ts", 2, 0], ["M", "src/app.ts", 1, 1]]);
  assert.equal(p.changes.total, "2 · +3 −1");
  assert.equal(p.digest.note, null);
  assert.match(p.digest.age, /updated/);
  assert.deepEqual(p.events.map((e) => e.text), ["event 6", "event 5", "event 4", "event 3"]); // newest first, four
  // While read, on failure, before a start, on sample data, and with no digest yet.
  assert.equal(chatPanel({ ticket: ticket(), diff: null, memory: null, now: NOW }).changes.note, "Reading the diff…");
  assert.equal(chatPanel({ ticket: ticket(), diff: null, memory: null, now: NOW }).digest.note, "Reading the digest…");
  assert.equal(chatPanel({ ticket: ticket(), diff: { error: "No diff: x" }, memory: { error: "Couldn't read" }, now: NOW }).changes.note, "No diff: x");
  assert.equal(chatPanel({ ticket: ticket({ state: "queued" }), diff: null, memory: null, now: NOW }).changes.note, "No changes: it hasn't started.");
  assert.match(chatPanel({ ticket: ticket(), diff: null, memory: null, daemon: false, now: NOW }).digest.note, /^Sample data/);
  assert.equal(chatPanel({ ticket: ticket(), diff: diffFiles(""), memory: { digest: null }, now: NOW }).digest.note, "No digest yet.");
  assert.equal(chatPanel({ ticket: ticket({ id: 413 }), diff: null, memory: { digest: DIGEST }, now: NOW }).digest.note, "Inherited from #412.");
});

// The V2 page on Chat with the panel, against fake-gpui: what it draws and where its clicks go.
const { TicketV2 } = await import("../mods/factory-ticket/v2.js");
const { diffFiles } = await import("../lib/ticketv2.js");
function chatPage({ width = 1400, panel = null, prep = () => {} } = {}) {
  const s = { ...structuredClone(status), source: "daemon", ui: { v2: true } };
  fake.status = s;
  fake.shared = panel == null ? {} : { [PANEL_KEY]: panel };
  const v2 = new TicketV2();
  v2.init();
  v2.chatW = width;
  const tk = { ...s.tickets.find((x) => x.id === 412) };
  v2.diffFor = 412; v2.diff = { ...diffFiles(DIFF), raw: DIFF };
  v2.memoryKey = "skip"; v2.memory = { id: 412, key: "skip", digest: DIGEST };
  v2.loaded = { "412:running": Date.now() }; // the CLI was just read
  prep(v2);
  const pg = { files: {}, tab: "1", view: "chat", handle: cx.focus_handle(), refresh() {} };
  const draw = () => {
    v2.memoryKey = "412:" + (tk.events?.length ?? 0) + ":" + (tk.events?.at(-1)?.at ?? ""); // as loaded: no CLI
    const all = find(v2.render(pg, tk, s, cx), () => true);
    return { all, ids: new Set(all.map(({ n }) => n.calls.id?.[0]).filter(Boolean)), words: all.map(({ n }) => text(n)).join("\n") };
  };
  return { v2, pg, draw, click: (all, id) => all.find(({ n }) => n.calls.id?.[0] === id).n.calls.on_click[0]({}, cx) };
}

test("Chat with the panel: Changes (a click opens that file's diff), the digest with Edit on Memory, the journal", async () => {
  const { pg, draw, click, v2 } = chatPage();
  let { all, ids, words } = draw();
  for (const id of ["chat-view", "chat-panel", "panel-changes", "chg-0", "chg-1", "panel-memory", "digest-sec-0", "edit-on-memory", "panel-journal", "pev-0"]) assert.ok(ids.has(id), id);
  // Its clicks keep focus in the chat's box: the panel stops the page's own mouse-down focus.
  const node = (id) => all.find(({ n }) => n.calls.id?.[0] === id).n;
  for (const id of ["chat-view", "chat-panel"]) assert.equal(node(id).calls.on_mouse_down?.[0], "left", id);
  assert.match(words, /src\/limit\.ts/);
  assert.match(words, /\+2/);
  assert.match(words, /Current state/);
  assert.match(words, /S2 middleware half done/);
  // The sidebar reads which view shows: written from a task after the frame.
  const now = { ...cx, spawn: (f) => f({ ...cx, timer: { after: (_ms, fn) => fn() } }) };
  v2.publishing = null; // the first frame's task never ran here (fake cx.spawn)
  v2.render(pg, { ...fake.status.tickets.find((x) => x.id === 412) }, fake.status, now);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.shared[VIEW_KEY], "chat");
  // A file: the Diff view, showing that file alone, with All files to go back.
  click(all, "chg-1");
  assert.equal(pg.view, "diff");
  ({ all, ids, words } = draw());
  assert.ok(ids.has("diff-all"));
  assert.match(words, /src\/app\.ts · \+1 −1/);
  assert.doesNotMatch(words, /export const a/); // src/limit.ts's lines aren't shown
  click(all, "diff-all");
  ({ words } = draw());
  assert.match(words, /export const a/);
  // Leaving Diff drops the one-file focus.
  click(all, "diff-all");
  pg.view = "chat";
  draw();
  assert.equal(v2.diffFile, null);
  // Edit on Memory: Overview › Memory.
  ({ all } = draw());
  click(all, "edit-on-memory");
  assert.deepEqual([pg.view, pg.tab], ["overview", "6"]);
});

test("the panel folds away on a narrow window, stays shut once closed, and × closes it", () => {
  assert.ok(!chatPage({ width: PANEL_MIN - 100 }).draw().ids.has("chat-panel"));
  assert.ok(!chatPage({ panel: false }).draw().ids.has("chat-panel"));
  const { draw, click } = chatPage({ panel: true });
  const { all, ids } = draw();
  assert.ok(ids.has("chat-panel"));
  click(all, "panel-close");
  assert.equal(fake.shared[PANEL_KEY], false);
  assert.ok(!draw().ids.has("chat-panel"));
});

test("a sidebar click's ask switches the page to Chat once", () => {
  const { pg, draw } = chatPage({ prep: () => {} });
  pg.view = "overview";
  fake.shared[OPEN_KEY] = { id: 412, view: "chat", at: Date.now() };
  draw();
  assert.equal(pg.view, "chat");
  pg.view = "overview"; // you switch back: the same ask doesn't pull you to Chat again
  draw();
  assert.equal(pg.view, "overview");
});

test("the chat's head has Changes, which toggles the page's panel; factory-chat's own page has none", () => {
  const on = chat(props({ panel: { open: true, folded: false } }));
  assert.ok(on.ids.has("panel-toggle"));
  fake.shared = {};
  const head = find(on.v.render(cx), (n) => n.calls.id?.[0] === "panel-toggle")[0].n;
  head.calls.on_click[0]({}, cx);
  assert.equal(fake.shared[PANEL_KEY], false);
  assert.ok(!chat(props()).ids.has("panel-toggle"));
});

// The sidebar's real render(): the chat-unread marker, and where a row's click goes.
const { default: FactoryTickets } = await import("../mods/factory-tickets/main.js");
function sidebar({ v2 = true, page = "ticket", view = "chat", seen = {}, sizes = {} } = {}) {
  const s = structuredClone(status);
  s.ui = { v2 };
  s.tickets.find((x) => x.id === 412).transcript = "/p/412.jsonl";
  fake.status = s;
  fake.layout = { id: "root", children: [{ id: "pages", active: page, children: [] }] };
  fake.shared = { [VIEW_KEY]: view, "factory.chat.seen": seen };
  const sb = new FactoryTickets();
  sb.init({}, cx);
  sb.sizes = sizes;
  const all = find(sb.render(), () => true);
  return { all, ids: new Set(all.map(({ n }) => n.calls.id?.[0]).filter(Boolean)), click: (id) => all.find(({ n }) => n.calls.id?.[0] === id).n.calls.on_click[0]({}, cx) };
}

test("sidebar: a grown transcript marks its row; a thread click opens the ticket on Chat while Chat shows", () => {
  const seen = { 412: { file: "/p/412.jsonl", size: 100 } };
  assert.ok(sidebar({ seen, sizes: { "/p/412.jsonl": 180 } }).ids.has("unread-t-412"));
  assert.ok(!sidebar({ seen, sizes: { "/p/412.jsonl": 100 } }).ids.has("unread-t-412"));
  assert.ok(!sidebar({ v2: false, seen, sizes: { "/p/412.jsonl": 180 } }).ids.has("unread-t-412")); // gate off: nothing
  sidebar().click("t-421");
  assert.equal(fake.shared["factory.ticket"], 421);
  assert.equal(fake.shared[OPEN_KEY].view, "chat");
  assert.equal(fake.shared[OPEN_KEY].id, 421);
  sidebar({ view: "overview" }).click("t-412");
  assert.equal(fake.shared["factory.ticket"], 412);
  assert.equal(fake.shared[OPEN_KEY], undefined); // as today: no ask
  sidebar({ v2: false }).click("t-412");
  assert.equal(fake.shared[OPEN_KEY], undefined);
});

// Your own session on the ticket (daemon/chat.ts): a "chat" stage row.
const OWN = { id: 4, stage: "chat", agent: "chat", terminal: "t8", started_at: "2026-11-20T12:00:00Z", ended_at: null, claude_session: "dddd", transcript: "/p/dddd.jsonl", paused_ticket: 1 };

test("your session: Open on a started ticket, Close once it's open, none before a worktree or on sample data", () => {
  const ended = ROWS.map((r) => ({ ...r, ended_at: r.ended_at ?? "2026-11-20T11:30:00Z" }));
  const paused = ticket({ state: "paused", terminal: "t8", stage: "implement", agent: "chat" });
  const list = chatSessions([...ended, OWN], paused, NOW);
  assert.equal(list.at(-1).label, "your session · 1 · Nov 20");
  assert.equal(list.at(-1).agent, "your session");
  assert.equal(pickSession(list).id, 4); // the chat follows it: it's the ticket's terminal
  assert.deepEqual(chatTarget(paused, pickSession(list), { sessions: list }).terminal, "t8");
  assert.deepEqual(ownChat(paused, list), { action: "close", args: ["chat", "412", "--close"], label: "Close your session", tip: "End your session; the blueprint resumes where it paused" });
  const running = ownChat(ticket(), chatSessions(ROWS, ticket(), NOW));
  assert.deepEqual(running.args, ["chat", "412"]);
  assert.equal(running.label, "Your session");
  assert.match(running.tip, /blueprint pauses until you close it/);
  assert.doesNotMatch(ownChat(ticket({ state: "parked", terminal: null }), []).tip, /pauses/);
  assert.equal(ownChat(ticket({ state: "queued" }), []), null);
  assert.equal(ownChat(ticket(), [], false), null);
});

test("the switcher ends in + for your session, which becomes Close your session once it's open", () => {
  const fresh = chat(props());
  assert.ok(fresh.ids.has("own-session"));
  assert.ok(!fresh.ids.has("own-close"));
  assert.match(fresh.words, /\+/);
  const paused = ticket({ state: "paused", terminal: "t8" });
  const { words } = chat(props({ ticket: { id: 412, terminal: "t8", state: "paused" }, sessions: chatSessions([...ROWS.map((r) => ({ ...r, ended_at: r.ended_at ?? "2026-11-20T11:30:00Z" })), OWN], paused, NOW) }));
  assert.match(words, /Close your session/);
  const open = chat(props({ ticket: { id: 412, terminal: "t8", state: "paused" }, sessions: chatSessions([...ROWS.map((r) => ({ ...r, ended_at: r.ended_at ?? "2026-11-20T11:30:00Z" })), OWN], paused, NOW) }));
  assert.ok(open.ids.has("own-close") && !open.ids.has("own-session"));
  assert.ok(!chat(props({ daemon: false })).ids.has("own-session"));
});
