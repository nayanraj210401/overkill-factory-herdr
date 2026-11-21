import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { overwatch } from "./overwatch.ts";
import type { Run } from "./runner.ts";

test("overwatch starts once in the factory's folder, and the live one is reused until it exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-"));
  const db = open(join(dir, "factory.db"));
  const calls: string[][] = [];
  let exited = false;
  let n = 0;
  const run: Run = (argv) => {
    calls.push(argv);
    if (argv[1] === "get") return { code: 0, out: JSON.stringify({ exit_code: exited ? 0 : null }) };
    return { code: 0, out: JSON.stringify({ address: `t${++n}` }) };
  };
  const now = "2026-11-21T10:00:00Z";
  expect(overwatch(db, { name: "acme-api", dir, run, now })).toEqual({ terminal: "t1", started: true });
  const argv = calls[0];
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(dir);
  expect(argv.at(-1)).toContain(`${dir}/status.json`);
  expect(argv.at(-1)).toContain("factory CLI with --name acme-api");
  expect(overwatch(db, { name: "acme-api", dir, run, now })).toEqual({ terminal: "t1", started: false });
  exited = true;
  expect(overwatch(db, { name: "acme-api", dir, run, now })).toEqual({ terminal: "t2", started: true });
});
