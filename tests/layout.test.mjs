import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, keys } from "../scripts/gen.mjs";
import { PAGES, STACK } from "../lib/pages.js";

const ids = (n) => [n.id, ...(n.children ?? []).flatMap(ids)];

test("every layout node id is unique (Herdr resolves commands by id)", () => {
  const all = ids(layout());
  assert.deepEqual(all.filter((id, i) => all.indexOf(id) !== i), []);
});

test("the stack holds every page, and each menu page has a key", () => {
  const stack = (function find(n) { return n.id === STACK ? n : (n.children ?? []).map(find).find(Boolean); })(layout());
  assert.deepEqual(stack.children.map((c) => c.id), PAGES.map((p) => p.id));
  const bound = Object.values(keys()["layout:factory"]).filter((a) => a.command === "layout.select").map((a) => a.args.child);
  assert.deepEqual(bound, PAGES.filter((p) => p.key).map((p) => p.id));
});
