import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETUP_SAMPLE, setupProgress } from "../lib/setup.js";
import { validateStatus } from "../lib/status.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/acme-api/status.json", import.meta.url), "utf8"));

test("status.json may carry a setup checklist; the sample passes the contract", () => {
  assert.deepEqual(validateStatus({ ...fixture, setup: SETUP_SAMPLE }), []);
  assert.deepEqual(validateStatus(fixture), []); // optional
});

test("a setup step with an unknown status or no fix text is refused", () => {
  const bad = { steps: [{ id: "gh", label: "gh", status: "later", fix: "x" }, { id: "q", label: "q", status: "missing", fix: "" }] };
  assert.equal(validateStatus({ ...fixture, setup: bad }).length, 2);
  assert.deepEqual(validateStatus({ ...fixture, setup: { steps: [] } }), ["setup: needs {steps: [{id, label, status, fix}]}"]);
});

test("progress counts done steps and names the skipped ones", () => {
  assert.equal(setupProgress(SETUP_SAMPLE).text, "2 of 7 done, 1 skipped");
});
