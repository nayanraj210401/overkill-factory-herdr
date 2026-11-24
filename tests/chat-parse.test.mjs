import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript, summarize, toText } from "../mods/factory-chat/chat/parse.js";
import { live } from "../mods/factory-chat/chat/stream.js";
import { parsePrompt, choose, menuAtBottom } from "../mods/factory-chat/chat/prompt.js";

// The pure parts factory-chat vendored from herdr-chat (it ships no tests of its own): the
// Claude Code log reader, the screen reader for the streamed reply, and terminal pickers.
const feed = (...lines) => { const t = new Transcript(); for (const l of lines) t.feed(JSON.stringify(l)); return t; };
const kinds = (t) => t.entries.map((e) => e.kind);

test("a log becomes messages: yours without system reminders, replies, and tool calls with their results", () => {
  const t = feed(
    { type: "user", cwd: "/w/acme", message: { content: "Fix it<system-reminder>ignore</system-reminder>" } },
    { type: "assistant", message: { id: "a", model: "claude-opus-5-5", content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "x", name: "Bash", input: { command: "npm test\n--watch" } }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "1 failing" }], is_error: true }] } },
    { type: "assistant", message: { id: "b", model: "claude-opus-5-5", content: [{ type: "text", text: "Fixed." }] } },
  );
  assert.deepEqual(kinds(t), ["user", "assistant", "tools", "assistant"]);
  assert.equal(t.entries[0].text, "Fix it");
  assert.deepEqual(t.entries[2].items.map((i) => [i.name, i.summary, i.result, i.error]), [["Bash", "npm test", "1 failing", true]]);
  assert.equal(t.model, "claude-opus-5-5");
  assert.equal(t.cwd, "/w/acme");
  assert.deepEqual(t.tokens["claude-opus-5-5"], { input: 10, output: 5 });
});

test("sidechains, meta lines and tag-wrapped injections are left out; slash commands show as typed", () => {
  const t = feed(
    { type: "user", isSidechain: true, message: { content: "a sub-agent's prompt" } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "user", message: { content: "<task-notification>done</task-notification>" } },
    { type: "user", message: { content: "<command-name>/compact</command-name><command-args>keep the plan</command-args>" } },
    { type: "user", message: { content: "[Request interrupted by user]" } },
  );
  assert.deepEqual(t.entries.map((e) => [e.kind, e.text]), [["user", "/compact keep the plan"], ["note", "Interrupted"]]);
});

test("Claude Code's queue: enqueued, taken, and a message taken mid-turn shows as yours", () => {
  const t = feed(
    { type: "queue-operation", operation: "enqueue", content: "also the login route" },
    { type: "queue-operation", operation: "enqueue", content: "and the docs" },
    { type: "queue-operation", operation: "dequeue" },
    { attachment: { type: "queued_command", prompt: "also the login route", origin: { kind: "human" } } },
  );
  assert.deepEqual(t.queue, ["and the docs"]);
  assert.deepEqual(t.entries.map((e) => e.text), ["also the login route"]);
});

test("a compaction is a note that keeps its summary", () => {
  const t = feed(
    { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 150000, postTokens: 9000 } },
    { type: "user", isCompactSummary: true, message: { content: "Summary of the work.\n\nIf you need specific details from before compaction, read the log." } },
  );
  assert.deepEqual(t.entries.map((e) => [e.kind, e.text, e.summary]), [["note", "Conversation compacted", "Summary of the work."]]);
});

test("summarize and toText: a tool call's input in one line, any content as text", () => {
  assert.equal(summarize({ file_path: "src/a.ts", limit: 20 }), "src/a.ts");
  assert.equal(summarize('{"pattern":"TODO"}'), "TODO");
  assert.equal(toText([{ text: "a" }, "b", { content: [{ text: "c" }] }]), "a\nb\nc");
});

test("the screen: the reply being written, or the tool running with its output", () => {
  const box = ["─".repeat(20), "❯ ", "─".repeat(20), "  ? for shortcuts"];
  assert.deepEqual(live(["❯ fix it", "", "⏺ Looking at the limiter now, and", "  then the tests.", ...box].join("\n")), { kind: "text", text: "Looking at the limiter now, and then the tests." });
  const run = live(["❯ fix it", "⏺ Bash(npm test)", "  ⎿  PASS src/a.test.ts", "     FAIL src/b.test.ts", ...box].join("\n"));
  assert.equal(run.kind, "run");
  assert.equal(run.title, "Bash(npm test)");
  assert.deepEqual(run.out, ["PASS src/a.test.ts", "FAIL src/b.test.ts"]);
  assert.equal(live(box.join("\n")), null);
});

test("a picker on the terminal: its question, options and the selected one; keys to pick another", () => {
  const screen = ["─".repeat(30), "Do you want to make this edit?", "❯ 1. Yes", "  2. Yes, allow all edits", "  3. No", "Esc to cancel"].join("\n");
  assert.deepEqual(parsePrompt(screen), { question: "Do you want to make this edit?", options: ["Yes", "Yes, allow all edits", "No"], selected: 0 });
  assert.deepEqual(choose(0, 2), ["down", "down", "enter"]);
  assert.equal(parsePrompt("just text\nno menu"), null);
  assert.equal(menuAtBottom(["Pick one", "❯ 1. A", "  2. B", "Enter to confirm · Esc to cancel"].join("\n")), "menu");
  assert.equal(menuAtBottom("a reply that ends\nwith no hint"), null);
});
