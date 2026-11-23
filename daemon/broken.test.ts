import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, fileRepair, repairFor } from "./broken.ts";
import { open } from "./db.ts";
import { prBody } from "./ready.ts";

test("a check that can't run is broken; one that ran and failed, or is ambiguous, fails", () => {
  const cases: [number, string, string][] = [
    [0, "12 pass\n0 fail", "pass"],
    [1, "3 failed, 9 passed", "fail"],
    [1, "", "fail"],
    [127, "", "broken"],
    [127, "sh: npm: command not found", "broken"],
    [2, "sh: 1: pytest: not found", "broken"],
    [1, "Error: ENOENT: no such file or directory, open 'jest.config.js'", "broken"],
    [1, "connect ECONNREFUSED 127.0.0.1:5432", "broken"],
    [5, "collected 0 items\n\nno tests ran in 0.01s", "broken"],
    [1, "No tests found, exiting with code 1", "broken"],
    [0, "No tests found", "broken"],                              // exit 0, but it tested nothing
    [0, "packages/a: No tests found\npackages/b: 14 passed", "pass"], // tests ran elsewhere: not broken
    [1, "connect ECONNREFUSED 127.0.0.1:5432\n2 failed, 10 passed", "fail"], // ambiguous: tests did fail
    [1, "AssertionError: expected 1 to be 2 (ENOENT in fixture name)", "fail"],
    [1, "expected element not found", "fail"],                    // a test's own words, not the shell's
  ];
  for (const [code, out, want] of cases) expect([code, out, classify(code, out)]).toEqual([code, out, want]);
});

test("one repair chore per broken check, however often it breaks; a new one once the last is done", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const now = "2026-11-21T10:00:00Z";
  const a = fileRepair(db, { dir, check: "npm test", detail: "exit 127: sh: npm: command not found", from: 7, now });
  expect(a).toEqual({ id: 10000, filed: true });
  expect(fileRepair(db, { dir, check: "npm test", detail: "exit 127", from: 8, now })).toEqual({ id: 10000, filed: false });
  expect(fileRepair(db, { dir, check: "npm run lint", detail: "exit 127", from: 7, now })).toEqual({ id: 10001, filed: true });
  expect(db.query("SELECT id, title, state, blueprint, trigger_name, groomed_at FROM tickets ORDER BY id").all()).toEqual([
    { id: 10000, title: "Repair check: npm test", state: "queued", blueprint: "chore", trigger_name: "broken-check", groomed_at: now },
    { id: 10001, title: "Repair check: npm run lint", state: "queued", blueprint: "chore", trigger_name: "broken-check", groomed_at: now },
  ]);
  expect(readFileSync(join(dir, "tickets/10000/BROKEN-CHECK.md"), "utf8")).toContain("sh: npm: command not found");
  db.query("UPDATE tickets SET state = 'merged' WHERE id = 10000").run();
  expect(repairFor(db, "npm test")).toBeNull();
  expect(fileRepair(db, { dir, check: "npm test", detail: "exit 127", from: 9, now }).id).toBe(10002);
});

test("the PR body says a check is broken up front", () => {
  const body = prBody("Adds it.", [{ rule: "evidence", result: "broken", detail: "check broken: npm test (repair #10000)" }, { rule: "budget", result: "pass", detail: "ok" }]);
  expect(body).toContain("**⚠ check broken.**");
  expect(body).toContain("- ⚠ evidence: check broken: npm test (repair #10000)");
  expect(prBody("Adds it.", [{ rule: "budget", result: "pass", detail: "ok" }])).not.toContain("check broken");
});
