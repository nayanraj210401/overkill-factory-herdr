import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Runs the V2 Ticket page's real render() (mods/factory-ticket/v2.js) against tests/fake-gpui.mjs
// for the prototype's four states, and checks each draws what its design says.
const FAKE = pathToFileURL("tests/fake-gpui.mjs").href;
const LIB = pathToFileURL("lib/").href;
const EMPTY = `data:text/javascript,${encodeURIComponent("export default null;")}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "gpui-kit" || spec === "gpui-base" || spec === "herdr") return { url: FAKE, shortCircuit: true };
    if (spec === "./sample.js" || spec === "./sample-reviews.js" || spec === "./lib/cli.js") return { url: EMPTY, shortCircuit: true };
    if (spec.startsWith("./lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(6), LIB).href, ctx);
    return next(spec, ctx);
  },
});

const { fake, cx, find, text } = await import(FAKE);
const { TicketV2 } = await import("../mods/factory-ticket/v2.js");

const status = JSON.parse(readFileSync("fixtures/acme-api/status.json", "utf8"));
const files = (id) => Object.fromEntries(["STATUS.md", "SLICES.md", "EVIDENCE.md", "GATES.md", "PR.md"].map((f) => {
  try { return [f, readFileSync(`fixtures/acme-api/tickets/${id}/${f}`, "utf8")]; } catch { return [f, null]; }
}));

// `tab`: the tab picked on this ticket; none, and the ticket opens on its state's own tab.
function draw(ticket, tab, source = "fixture") {
  const s = { ...structuredClone(status), source, ui: { v2: true } };
  fake.status = s;
  const v2 = new TicketV2();
  v2.init();
  if (tab) v2.opened = ticket.id;
  const page = { files: files(ticket.id), tab: tab ?? "1", handle: cx.focus_handle(), refresh() {} };
  const tree = v2.render(page, ticket, s, cx);
  const all = find(tree, () => true);
  return { tab: page.tab, ids: new Set(all.map(({ n }) => n.calls.id?.[0]).filter(Boolean)), words: all.map(({ n }) => text(n)).join("\n") };
}
const t = (id, o = {}) => ({ ...structuredClone(status.tickets.find((x) => x.id === id)), ...o });

test("working: the live terminal, the plan's slices, Open live terminal / Diff / Pause", () => {
  const { ids, words } = draw(t(412));
  for (const id of ["title", "chips", "strip", "tabs", "pane-plan", "agent", "live-terminal", "files", "activity", "btn-peek", "btn-diff", "btn-pause"]) assert.ok(ids.has(id), id);
  assert.ok(!ids.has("question"));
  assert.match(words, /S2 Middleware/);
  assert.match(words, /builder · implement · S2 of 3/);
  assert.match(words, /Sample data: no live terminal to show\./);
  assert.match(words, /implement session 2 started/);
});

test("asks: the inline question card types into the terminal; Answer in terminal / Diff / Pause", () => {
  const { ids, words, tab } = draw(t(412, { needs: { kind: "attention", text: "implement asks you in its terminal (t7): press e to answer" } }));
  assert.equal(tab, "3"); // waiting on you: it opens on its questions
  for (const id of ["question", "send", "answer-box", "btn-answer", "btn-diff", "btn-pause", "pane-questions"]) assert.ok(ids.has(id), id);
  assert.ok(!ids.has("live-terminal"));
  assert.match(words, /Typed into the live terminal/);
});

test("parked: the question card answers and resumes; Talk it through / Diff / Close", () => {
  const { ids, words } = draw(t(425, { questions: [{ n: 1, kind: "engineering", text: "Skip the flaky upload test?" }] }), "5");
  for (const id of ["question", "send", "btn-answer", "btn-diff", "btn-close", "pane-ask"]) assert.ok(ids.has(id), id);
  assert.match(words, /Answer & resume/);
  assert.match(words, /Skip the flaky upload test\?/);
  assert.match(words, /Talk it through/);
  assert.match(words, /GitHub issue #425 in acme\/api\./);
});

test("PR ready: the ready rules; Open PR / Diff / Send back", () => {
  const { ids, words, tab } = draw(t(409));
  assert.equal(tab, "4"); // a ready ticket opens on its PR
  for (const id of ["ready-rules", "btn-open-pr", "btn-diff", "btn-send-back", "btn-merge", "pane-pr"]) assert.ok(ids.has(id), id);
  assert.ok(!ids.has("question") && !ids.has("live-terminal"));
  assert.match(words, /6 of 6 ready rules/);
  assert.match(words, /#511 Bump dependencies/);
  assert.match(words, /done · waits for your merge/);
});
