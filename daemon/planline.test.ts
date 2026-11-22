import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readingOf, usedNow, planFile } from "./planline.ts";
import { planMeters, planKnown } from "./metrics.ts";
import { open } from "./db.ts";
import { withHandoffHook } from "./handoff-hook.ts";
import { writeIfChanged } from "./files.ts";

const home = () => (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "plan-")));
const db = () => open(join(mkdtempSync(join(tmpdir(), "db-")), "factory.db"));

test("the status line saves Claude Code's plan reading, and the meters use it over the estimate", () => {
  home();
  const now = new Date("2026-11-22T03:00:00Z");
  const input = { rate_limits: { five_hour: { used_percentage: 62, resets_at: Date.parse("2026-11-22T05:00:00Z") / 1000 }, seven_day: { used_percentage: 19.4 } }, context_window: { used_percentage: 15 } };
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "planline.ts"), planFile()], { stdin: Buffer.from(JSON.stringify(input)), env: process.env });
  expect(r.stdout.toString()).toContain("5h 62%");
  expect(JSON.parse(readFileSync(planFile(), "utf8")).five_hour).toEqual({ used: 0.62, resets_at: "2026-11-22T05:00:00.000Z" });
  const d = db();
  expect(planKnown(d)).toBe(true);
  expect(planMeters(d, now)).toMatchObject({ window_5h: 0.62, week: 0.194, source: "claude", as_of: expect.any(String) });
  // Past its reset, the 5-hour window reads 0 until a new reading comes in.
  expect(planMeters(d, new Date("2026-11-22T05:01:00Z")).window_5h).toBe(0);
});

test("no reading and no limits: the meters read 0 and the plan guard has nothing to go on", () => {
  home();
  const d = db();
  expect(planKnown(d)).toBe(false);
  expect(planMeters(d, new Date())).toEqual({ window_5h: 0, week: 0, source: "none", as_of: null });
  expect(readingOf({ context_window: { used_percentage: 3 } })).toBeNull();
  expect(usedNow(null, new Date())).toBeNull();
});

test("a Claude worker's settings carry the plan status line beside the hooks", () => {
  home();
  const dir = mkdtempSync(join(tmpdir(), "f-"));
  const argv = withHandoffHook(["claude", "do it"], dir, 7);
  const settings = JSON.parse(readFileSync(argv[2], "utf8"));
  expect(settings.statusLine.command).toContain("planline.ts");
  expect(settings.statusLine.command).toContain(planFile());
  expect(settings.hooks.PreToolUse.length).toBe(1);
});

test("writeIfChanged leaves a file alone when only generated_at differs", () => {
  const f = join(mkdtempSync(join(tmpdir(), "w-")), "status.json");
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:00Z", n: 1 }))).toBe(true);
  const before = statSync(f).mtimeMs;
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:05Z", n: 1 }))).toBe(false);
  expect(statSync(f).mtimeMs).toBe(before);
  expect(writeIfChanged(f, JSON.stringify({ generated_at: "2026-11-22T03:00:10Z", n: 2 }))).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf8")).n).toBe(2);
});
