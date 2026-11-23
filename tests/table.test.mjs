import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Runs the Tickets page's and the sidebar's real render() against tests/fake-gpui.mjs, with a
// ticket whose title is 300+ characters of mixed CJK, emoji and Latin text and a full set of
// labels, then lays the tree out and checks the table holds its shape.
const FAKE = pathToFileURL("tests/fake-gpui.mjs").href;
const LIB = pathToFileURL("lib/").href;
const EMPTY = `data:text/javascript,${encodeURIComponent("export default null;")}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "gpui-kit" || spec === "gpui-base" || spec === "herdr") return { url: FAKE, shortCircuit: true };
    // A mod's ./lib/ is a copy of lib/ that scripts/sync.sh makes; sample*.js are written there too.
    if (spec === "./sample.js" || spec === "./sample-reviews.js") return { url: EMPTY, shortCircuit: true };
    if (spec.startsWith("./lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(6), LIB).href, ctx);
    return next(spec, ctx);
  },
});

const { fake, cx, layoutWidths, find, text, textWidth } = await import(FAKE);
const { default: FactoryList } = await import("../mods/factory-list/main.js");
const { default: FactoryTickets } = await import("../mods/factory-tickets/main.js");

const LONG = `Rebuild the search index without downtime ${"検索インデックスを再構築する 🚀🔥 ".repeat(6)}and keep every old query working while ${"the new index warms up, ".repeat(6)}🧪✅ done`;

function sample() {
  const s = JSON.parse(readFileSync("fixtures/acme-api/status.json", "utf8"));
  const t = s.tickets.find((x) => x.state === "running") ?? s.tickets[0];
  Object.assign(t, { title: LONG, warning: "92% of budget", repos: [{ slug: "acme/api", lead: true }, { slug: "acme/web" }] });
  return { s, id: t.id };
}

function renderList(width) {
  const { s, id } = sample();
  fake.status = s;
  const view = new FactoryList();
  view.init({}, cx);
  return { root: layoutWidths(view.render(), width), id };
}

const right = (n) => n.x + n.width;
// The heading row: the one just above the rows.
const headerOf = (rows, path) => { const kids = path.at(-1).kids.map((k) => k.node); return kids[kids.indexOf(rows) - 1]; };

for (const width of [1400, 700]) {
  test(`Tickets page at ${width}px: a 300+ char title keeps every column under its heading`, () => {
    assert.ok(LONG.length > 300);
    const { root, id } = renderList(width);
    const [{ n: rows, path }] = find(root, (n) => n.calls.id?.[0] === "rows");
    const header = headerOf(rows, path);
    assert.equal(text(header.kids[0].node), "Ticket");
    const cols = header.kids.map((k) => k.node);
    const rowNodes = rows.kids.map((k) => k.node).filter((n) => n.calls.id?.[0]?.startsWith("row-"));
    assert.ok(rowNodes.length > 1);
    for (const row of rowNodes) {
      const cells = row.kids.map((k) => k.node);
      assert.equal(cells.length, cols.length, `row ${row.calls.id[0]} has one cell per heading`);
      // Same x and width as the heading above it, and the row no wider than the header.
      cells.forEach((c, i) => {
        assert.equal(Math.round(c.x), Math.round(cols[i].x), `${row.calls.id[0]} column ${i} starts under its heading`);
        assert.equal(Math.round(c.width), Math.round(cols[i].width), `${row.calls.id[0]} column ${i} is its heading's width`);
      });
      assert.ok(row.used <= row.width + 0.5, `${row.calls.id[0]}'s cells fit the row (${row.used} > ${row.width})`);
      assert.equal(Math.round(row.width), Math.round(header.width));
    }
    // The long ticket: its title is cut with an ellipsis inside the column, its labels stay in it.
    const long = rowNodes.find((r) => r.calls.id[0] === `row-${id}`);
    const titleCol = long.kids[0].node;
    assert.ok(titleCol.used <= titleCol.width + 0.5, "title, warning and repo badge fit the Ticket column");
    const [{ n: title }] = find(titleCol, (n) => text(n) === `#${id} ${LONG}`);
    assert.ok(textWidth(text(title)) > title.width, "the title is wider than its cell");
    assert.ok("truncate" in title.calls, "so it is truncated with an ellipsis");
    assert.equal(title.calls.tooltip?.[0], `#${id} ${LONG}`, "and the full title shows on hover");
    for (const label of titleCol.kids.map((k) => k.node).slice(2)) {
      assert.ok(label.x >= right(title) - 0.5 && right(label) <= right(titleCol) + 0.5, `label "${text(label)}" stays in the Ticket column`);
      assert.ok("flex_none" in label.calls, "labels never shrink");
    }
    // Any text wider than its box must be a truncating one: nothing spills into the next column.
    for (const { n } of find(rows, (n) => text(n))) {
      if (textWidth(text(n)) > n.width + 0.5) assert.ok("truncate" in n.calls, `"${text(n).slice(0, 30)}" overflows its cell without truncating`);
    }
    // Header and rows scroll sideways together: the same overflow_x area holds both.
    const scroller = path.findLast((n) => "overflow_x_scrollbar" in n.calls || "overflow_x_scroll" in n.calls);
    assert.ok(scroller, "the table sits in a sideways scroll area");
    assert.ok(find(scroller, (n) => n === header).length, "with its header");
    if (width < 1000) assert.ok(header.width > scroller.width, "a pane too narrow for the table scrolls it rather than squeezing it");
    else assert.equal(Math.round(header.width), Math.round(scroller.width), "a wide pane shows the whole table, no scrolling");
  });
}

test("Runs view: a long run title is truncated in its column, which lines up with the heading", () => {
  const view = new FactoryList();
  view.init({}, cx);
  view.view = "runs";
  view.doc = { runs: [{ id: "r1", ticket: 7, title: LONG, kind: "build", harness: "claude", model: "opus", started_at: "2026-11-21T09:40:00Z", duration_s: 60, tokens_in: 1, tokens_out: 1, usd: 1 }] };
  fake.status = sample().s;
  const root = layoutWidths(view.render(), 900);
  const [{ n: rows, path }] = find(root, (n) => n.calls.id?.[0] === "rows");
  const header = headerOf(rows, path);
  const row = rows.kids[0].node;
  row.kids.forEach((k, i) => assert.equal(Math.round(k.node.x), Math.round(header.kids[i].node.x)));
  assert.ok(row.used <= row.width + 0.5);
  assert.equal(row.kids[0].node.calls.tooltip?.[0], `#7 ${LONG}`);
});

test("sidebar: a long title is truncated and its labels stay inside the 260px sidebar", () => {
  const { s, id } = sample();
  
  fake.status = s;
  const view = new FactoryTickets();
  view.init({}, cx);
  const root = layoutWidths(view.render(), 260);
  const [{ n: row }] = find(root, (n) => n.calls.id?.[0] === `t-${id}`);
  const line = row.kids[0].node;
  assert.ok(line.used <= line.width + 0.5, `the title line fits (${line.used} > ${line.width})`);
  assert.ok(right(line) <= 260);
  const title = line.kids[1].node;
  assert.ok("truncate" in title.calls && title.calls.tooltip?.[0] === `#${id} ${LONG}`);
});
