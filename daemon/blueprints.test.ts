import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { buildBlueprints } from "./blueprints.ts";

const fixtures = join(import.meta.dir, "../fixtures/acme-api");

test("the sample blueprints.json matches the fixture YAML, apart from its made-up counts", () => {
  const RUNS = { runs: 0, pass: 0, fail: 0, median_s: null, last: [], recent: [] };
  const strip = (d: any) => d.blueprints.map((b: any) => ({ ...b, grooming_runs: 0, stats: null, grooming: null, stages: b.stages.map((s: any) => ({ ...s, ...RUNS })) }));
  const sample = JSON.parse(readFileSync(join(fixtures, "blueprints.json"), "utf8"));
  const built = buildBlueprints(null, fixtures);
  expect(strip(sample)).toEqual(strip(built));
  // The sample's step files are relative to it (the page opens them from its root); the daemon's are absolute.
  expect(Object.fromEntries(Object.entries(sample.steps).map(([n, s]: any) => [n, { ...s, file: join(fixtures, s.file) }]))).toEqual(built.steps);
});

test("each stage's last runs, pass/fail and median come from what the ticket did next; the strip from its tickets", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "bp-")), "factory.db"));
  const now = new Date("2026-11-21T12:00:00Z");
  const ticket = (id: number, state = "merged", needs: string | null = null) =>
    db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at, needs_text) VALUES (?, ?, ?, 'feature', ?, ?)").run(id, `t${id}`, state, now.toISOString(), needs);
  const stage = (t: number, name: string, at: string, end: string | null) => db.query("INSERT INTO stages (ticket, name, started_at, ended_at) VALUES (?, ?, ?, ?)").run(t, name, at, end);
  const said = (t: number, who: string, what: string, at: string) => db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(t, who, what, at);
  // #1 fails verify once, goes back to implement, then opens its PR; #2 runs clean; #3 runs now.
  ticket(1); said(1, "you", "added issue #1", "2026-11-21T08:00:00Z");
  stage(1, "Implement", "2026-11-21T08:10:00Z", "2026-11-21T08:40:00Z"); stage(1, "Verify", "2026-11-21T08:40:00Z", "2026-11-21T08:42:00Z");
  stage(1, "Implement", "2026-11-21T08:42:00Z", "2026-11-21T09:00:00Z"); stage(1, "Verify", "2026-11-21T09:00:00Z", "2026-11-21T09:04:00Z");
  stage(1, "PR", "2026-11-21T09:04:00Z", "2026-11-21T09:10:00Z"); said(1, "daemon", "opened PR #5", "2026-11-21T09:10:00Z");
  db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES ('m1', 1, ?, 'x', 0, 0, 0, 0, 0, 3)").run(now.toISOString());
  ticket(2); stage(2, "Implement", "2026-11-20T08:00:00Z", "2026-11-20T08:20:00Z"); stage(2, "Verify", "2026-11-20T08:20:00Z", "2026-11-20T08:30:00Z");
  stage(2, "PR", "2026-11-20T08:30:00Z", "2026-11-20T09:00:00Z"); said(2, "daemon", "opened PR #6", "2026-11-20T09:00:00Z");
  ticket(3, "running"); stage(3, "Implement", "2026-11-21T11:00:00Z", null);
  ticket(4, "parked", "Verify failed 4 times: flaky"); stage(4, "Verify", "2026-11-01T00:00:00Z", "2026-11-01T00:05:00Z");
  const f = buildBlueprints(db, fixtures, now).blueprints.find((b) => b.name === "feature")!;
  const by = Object.fromEntries(f.stages.map((s: any) => [s.id, s]));
  expect(by.verify.last).toEqual(["fail", "pass", "fail", "pass"]); // #4's old fail counts in the bars, not the week
  expect([by.verify.pass, by.verify.fail, by.verify.median_s]).toEqual([2, 1, 240]);
  expect(by.implement.last).toEqual(["pass", "pass", "pass", "running"]);
  expect(by.implement.recent[0]).toMatchObject({ ticket: 3, outcome: "running", duration_s: null });
  // Three tickets this week, one failed back; asks to PR: 70m (#1) and 60m (#2, from its first stage); spend $3 and $0.
  expect(f.stats).toEqual({ tickets: 3, clean: 0.667, ask_to_pr_min: 65, usd: 1.5 });
});

test("runs count each stage entered in the last 7 days, per blueprint, retries again", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "bp-")), "factory.db"));
  const now = new Date("2026-11-21T12:00:00Z");
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (1, 'a', 'feature', ?), (2, 'b', 'chore', ?)").run(now.toISOString(), now.toISOString());
  const stage = (t: number, name: string, at: string) => db.query("INSERT INTO stages (ticket, name, started_at) VALUES (?, ?, ?)").run(t, name, at);
  stage(1, "Groom", "2026-11-21T09:00:00Z"); stage(1, "Implement", "2026-11-21T10:00:00Z"); stage(1, "Implement", "2026-11-21T11:00:00Z");
  stage(1, "PR", "2026-11-21T11:30:00Z"); stage(1, "Spec", "2026-11-01T00:00:00Z"); stage(2, "Implement", "2026-11-21T10:00:00Z");
  const feature = buildBlueprints(db, fixtures, now).blueprints.find((b) => b.name === "feature")!;
  const runs = Object.fromEntries(feature.stages.map((s) => [s.id, s.runs]));
  expect(runs).toMatchObject({ implement: 2, pr: 1, spec: 0 });
  expect(feature.grooming_runs).toBe(1);
});

test("a pending maintainer request's changed blueprint shows as a draft; an unchanged one and a finished request don't", () => {
  const repo = mkdtempSync(join(tmpdir(), "bp-repo-"));
  const wt = mkdtempSync(join(tmpdir(), "bp-wt-"));
  for (const d of [repo, wt]) cpSync(join(fixtures, ".factory"), join(d, ".factory"), { recursive: true });
  const chore = join(wt, ".factory/blueprints/chore.yaml");
  writeFileSync(chore, readFileSync(chore, "utf8").replace("next: [verify]", "next: [pr]").replace(/\n  verify:.*/, ""));
  writeFileSync(join(wt, ".factory/blueprints/docs.yaml"), "name: docs\nstart: write\nstages:\n  write: { agent: builder, next: [end] }\n");
  const db = open(join(mkdtempSync(join(tmpdir(), "bp-")), "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const ticket = (id: number, state: string) => { db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (?, 'change', ?, 'factory', 'x')").run(id, state); setWork(db, id, { worktree: wt }); };
  ticket(7, "running"); ticket(8, "merged");
  const drafts = buildBlueprints(db, repo).drafts;
  expect(drafts.map((d) => [d.ticket, d.name, d.error])).toEqual([[7, "chore", null], [7, "docs", null]]);
  expect(drafts[0].stages.map((s) => s.id)).toEqual(["implement", "pr", "merge"]);
  expect(buildBlueprints(db, repo).blueprints.find((b) => b.name === "chore")!.stages.map((s) => s.id)).toContain("verify");
  writeFileSync(chore, "name: chore\nstart: nope\nstages:\n  a: { agent: builder, nxt: [] }\n");
  expect(buildBlueprints(db, repo).drafts.find((d) => d.name === "chore")!.error).toContain("unknown key");
});
