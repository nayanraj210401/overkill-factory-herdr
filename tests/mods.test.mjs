import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Herdr's rule: never keep a cx and use it later; every callback gets its own. An async
// method handed a cx uses it after its first await, where cx.notify() is ignored and the
// view never repaints (Config's file list did that: a click showed nothing). Spawn instead:
// on_click((_e, cx) => cx.spawn(async (cx) => this.load(x, cx))).
test("no mod has an async method or function that takes a cx", () => {
  const bad = [];
  for (const dir of readdirSync("mods").filter((d) => d.startsWith("factory-"))) {
    const text = readFileSync(`mods/${dir}/main.js`, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/\basync\s+(function\s+)?\w*\s*\([^)]*\bcx\b[^)]*\)\s*\{/.test(line) && !/cx\.spawn\(\s*async/.test(line)) bad.push(`mods/${dir}/main.js:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
