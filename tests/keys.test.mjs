import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAction, clamp } from "../lib/keys.js";

const k = (key, modifiers = {}) => keyAction({ key, modifiers });

test("j/k/arrows move, enter opens", () => {
  assert.deepEqual(k("j"), { kind: "move", delta: 1 });
  assert.deepEqual(k("up"), { kind: "move", delta: -1 });
  assert.deepEqual(k("enter"), { kind: "open" });
  assert.deepEqual(k("e"), { kind: "terminal" });
  assert.deepEqual(k("n"), { kind: "new" });
  assert.deepEqual(k("d"), { kind: "diff" });
  assert.deepEqual(k("p"), { kind: "pause" });
  assert.deepEqual(k("m"), { kind: "merge" });
  assert.deepEqual(k("b"), { kind: "budget" });
  assert.deepEqual(k("x"), { kind: "send-back" });
  assert.deepEqual(k("u"), { kind: "answer" });
});

test("⇧C and ⇧L move a ticket to the cloud and back", () => {
  assert.deepEqual(k("c", { shift: true }), { kind: "cloud" });
  assert.deepEqual(k("l", { shift: true }), { kind: "local" });
  assert.deepEqual(k("c"), null);
});

test("chords and unknown keys are left alone", () => {
  assert.equal(k("m", { platform: true }), null);
  assert.equal(k("j", { control: true }), null);
  assert.equal(k("q"), null);
  assert.equal(clamp(5, 3), 2);
  assert.equal(clamp(-1, 3), 0);
  assert.equal(clamp(0, 0), 0);
});
