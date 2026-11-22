import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, paths } from "./cli.ts";
import { statusMd, summary } from "./ticket.ts";
import { parseStatusMd } from "../lib/model.js";
import { validateStatus } from "../lib/status.js";
import { open } from "./db.ts";
import { buildStatus } from "./status.ts";

function factory() {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], () => {});
  run("init", "--repo", "acme/api");
  const file = (id: number, name: string) => readFileSync(join(paths("acme-api").dir, "tickets", String(id), name), "utf8");
  return { run, file };
}

test("the Ticket page parses exactly what the daemon writes", () => {
  const t: any = { title: "Rate-limit login", state: "running", stage: "implement", detail: "slice 2 of 3", usd: 1.8, pr: null, needs: null };
  const md = statusMd(t, [
    { name: "Spec", detail: "3 acceptance checks", started_at: "2026-11-21T10:00:00Z", ended_at: "2026-11-21T10:06:00Z" },
    { name: "Implement", detail: "slice 2 of 3", started_at: "2026-11-21T10:06:00Z", ended_at: null },
  ], ["Verify", "PR"], "2026-11-21T10:18:00Z");
  const { summary: s, stages } = parseStatusMd(md);
  expect(s).toBe("Rate-limit login is in implement, slice 2 of 3, at $1.80 so far.");
  expect(stages).toEqual([
    { state: "done", name: "Spec", time: "6m", detail: "3 acceptance checks" },
    { state: "now", name: "Implement", time: "12m", detail: "slice 2 of 3" },
    { state: "next", name: "Verify", time: null, detail: "" },
    { state: "next", name: "PR", time: null, detail: "" },
  ]);
});

test("stage moves end the last stage, keep the plan, and land in STATUS.md", () => {
  const { run, file } = factory();
  run("ticket", "add", "412", "Rate-limit", "login");
  run("ticket", "set", "412", "state=running");
  run("stage", "412", "Spec", "3", "acceptance", "checks", "--next", "Plan,Implement,Verify");
  run("stage", "412", "Plan", "3", "slices");
  const { stages } = parseStatusMd(file(412, "STATUS.md"));
  expect(stages.map((s: any) => [s.state, s.name])).toEqual([["done", "Spec"], ["now", "Plan"], ["next", "Implement"], ["next", "Verify"]]);
  expect(stages[1].detail).toBe("3 slices");
});

test("evidence rows become the Checks tab, and bad input is refused", () => {
  const { run, file } = factory();
  run("ticket", "add", "412", "Rate-limit", "login");
  expect(file(412, "EVIDENCE.md")).toContain("No checks have run yet.");
  run("evidence", "412", "npm test -- limit", "pass", "14 passed");
  run("evidence", "412", "C2: other users", "fail", "a|b");
  const md = file(412, "EVIDENCE.md");
  expect(md).toContain("| `npm test -- limit` | ✓ PASS | 14 passed |");
  expect(md).toContain("| `C2: other users` | ✗ FAIL | a\\|b |");
  expect(() => run("evidence", "412", "x", "maybe")).toThrow(/usage/);
  expect(() => run("stage", "999", "Spec")).toThrow(/no ticket 999/);
});

test("every state opens with one plain sentence", () => {
  const base: any = { title: "T", usd: 0.5, stage: null, detail: null, pr: null, needs: null, blocked_by: null };
  expect(summary({ ...base, state: "ready", pr: { number: 7 } })).toBe("T is ready: PR #7, at $0.50 so far.");
  expect(summary({ ...base, state: "parked", needs: { text: "retries used up" } })).toBe("T is parked: retries used up.");
  expect(summary({ ...base, state: "blocked", blocked_by: 425 })).toBe("T waits on #425.");
});

test("a stage entered again is one step with its rounds, in blueprint order", () => {
  const { run, file } = factory();
  run("ticket", "add", "412", "Rate-limit", "login");
  run("ticket", "set", "412", "state=running");
  run("stage", "412", "Implement", "round", "1", "--next", "Verify,PR");
  for (const round of [1, 2, 3]) {
    run("stage", "412", "Verify", "check: tests");
    run("stage", "412", "Implement", `round ${round + 1}`, "--next", "Verify,PR");
  }
  const md = file(412, "STATUS.md");
  expect(md.match(/^- .*Implement/gm)).toHaveLength(1);
  expect(md.match(/^- .*Verify/gm)).toHaveLength(1);
  let { stages } = parseStatusMd(md);
  expect(stages.map((s: any) => [s.state, s.name])).toEqual([["now", "Implement"], ["done", "Verify"], ["next", "PR"]]);
  expect(stages[0].detail).toBe("4 rounds · round 4");
  expect(stages[1].detail).toBe("failed 3× · check: tests");
  run("stage", "412", "Verify", "check: tests", "--next", "PR");
  run("stage", "412", "PR");
  stages = parseStatusMd(file(412, "STATUS.md")).stages;
  expect(stages.map((s: any) => s.name)).toEqual(["Implement", "Verify", "PR"]);
  expect(stages[1].detail).toBe("failed 3×, then passed · check: tests");
  expect(stages[0].detail).toBe("4 rounds · round 4");
});

test("status.json lists a grooming ticket's open questions, numbered", () => {
  const { run } = factory();
  run("ticket", "add", "421", "Search", "index");
  run("ticket", "set", "421", "state=grooming");
  run("question", "421", "product", "Per user?");
  run("question", "421", "engineering", "Keep old indexes?");
  const s = buildStatus(open(paths("acme-api").db));
  expect((s.tickets.find((t: any) => t.id === 421) as any).questions).toEqual([
    { n: 1, kind: "product", text: "Per user?" }, { n: 2, kind: "engineering", text: "Keep old indexes?" }]);
  expect(validateStatus(s)).toEqual([]);
});
