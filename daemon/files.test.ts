import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIfChanged } from "./files.ts";

test("writeIfChanged leaves a file alone when only generated_at differs", () => {
  const f = join(mkdtempSync(join(tmpdir(), "w-")), "status.json");
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:00Z", n: 1 }))).toBe(true);
  const before = statSync(f).mtimeMs;
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:05Z", n: 1 }))).toBe(false);
  expect(statSync(f).mtimeMs).toBe(before);
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:10Z", n: 2 }))).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf8")).n).toBe(2);
});
