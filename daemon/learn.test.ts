import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { main, paths } from "./cli.ts";
import { buildStatus } from "./status.ts";
import { validateFile } from "./validate.ts";
import { validateStatus } from "../lib/status.js";
import { activeOverrides, addLesson, exportPatch, lessonsFor, listLessons, retireLesson, setOverride, settingOf } from "./learn.ts";
import { brief, sh, startTicket, type Run } from "./runner.ts";

const TUNABLE = ["agents.spec-writer.model", "agents.reviewer.model", "budget.handoff_at_context"];

function repo(learn = true) {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", dir, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: echo\nmodel: haiku\n---\nWrite INTENT.md.\n");
  if (learn) {
    const f = join(dir, ".factory/factory.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace(/^learn:[\s\S]*$/m, `learn:\n  tunable: [${TUNABLE.join(", ")}]\n`));
  }
  sh(["git", "-C", dir, "add", "."]);
  sh(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9","state":"live"}' }) : sh(argv, cwd));
  for (const id of [1, 2]) db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run(id);
  const r = repo();
  setRepo(db, { slug: "acme/api", path: r, lead: true });
  return { dir, db, calls, run, repo: r };
}

const NOW = "2026-11-21T10:00:00Z";

test("the validator accepts a learn block, and refuses a tunable key that steers the work", () => {
  expect(validateFile("factory.yaml", "name: x\nlearn:\n  target: cost_per_pr\n  tunable: [agents.builder.model, budget.handoff_at_context]\n  warmup_tickets: 20\n  pause_above: 70%\n  promote_after: 30\n")).toEqual([]);
  const bad = validateFile("factory.yaml", "name: x\nlearn:\n  target: vibes\n  tunable: [ready, agents.reviewer.prompt, hard_stops, blueprints.feature.max_retries, merge, Bad Key]\n  speed: 3\n");
  expect(bad.filter((e) => e.startsWith("learn.tunable"))).toHaveLength(6);
  expect(bad).toContain('learn.target: "vibes" is not one of cost_per_pr, time_to_pr, interactions_per_pr, review_rounds_per_pr');
  expect(bad.some((e) => e.startsWith("learn.speed: unknown key"))).toBe(true);
});

test("an override replaces the one before it, undo drops it, and a key learn.tunable doesn't list is refused", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "ov-")), "factory.db"));
  setOverride(db, { key: "agents.reviewer.model", value: "sonnet", reason: "cheaper", tunable: TUNABLE, now: NOW });
  setOverride(db, { key: "agents.reviewer.model", value: "haiku", tunable: TUNABLE, now: "2026-11-21T11:00:00Z" });
  expect(activeOverrides(db)).toEqual([{ key: "agents.reviewer.model", value: "haiku", reason: null, at: "2026-11-21T11:00:00Z" }]);
  expect(db.query("SELECT COUNT(*) AS n FROM overrides").get()).toEqual({ n: 2 }); // the first is kept, undone
  expect(() => setOverride(db, { key: "ready", value: "x", tunable: TUNABLE, now: NOW })).toThrow("isn't in factory.yaml's learn.tunable");
  expect(() => setOverride(db, { key: "ready", value: "x", tunable: ["ready"], now: NOW })).toThrow("never changes");
  expect(() => setOverride(db, { key: "agents.reviewer.model", value: "x", tunable: undefined, now: NOW })).toThrow("learn.tunable");
});

test("a ticket's settings are fixed when it starts: a later override or undo doesn't reach its next stage", () => {
  const { dir, db, calls, run, repo: r } = setup();
  setOverride(db, { key: "agents.spec-writer.model", value: "opus", tunable: TUNABLE, now: NOW });
  setOverride(db, { key: "agents.reviewer.model", value: "haiku", tunable: ["agents.reviewer.model"], now: NOW });
  startTicket(db, { dir, repo: r, id: 1, run, now: NOW });
  // spec-writer's file says haiku and harness echo (which takes no --model): look at the stored session argv instead
  const settings = (db.query("SELECT settings FROM tickets WHERE id = 1").get() as any).settings;
  expect(JSON.parse(settings)).toEqual({ "agents.spec-writer.model": "opus", "agents.reviewer.model": "haiku" });
  expect(settingOf({ settings }, "agents.spec-writer.model", "haiku")).toBe("opus");
  expect(settingOf({ settings }, "agents.spec-writer.effort", "medium")).toBe("medium");
  // Change the override after the start: ticket 1 keeps opus, ticket 2 (started after) gets the new value.
  setOverride(db, { key: "agents.spec-writer.model", value: "sonnet", tunable: TUNABLE, now: "2026-11-21T10:05:00Z" });
  expect(JSON.parse((db.query("SELECT settings FROM tickets WHERE id = 1").get() as any).settings)["agents.spec-writer.model"]).toBe("opus");
  startTicket(db, { dir, repo: r, id: 2, run, now: NOW });
  expect(JSON.parse((db.query("SELECT settings FROM tickets WHERE id = 2").get() as any).settings)["agents.spec-writer.model"]).toBe("sonnet");
  expect(calls.length).toBe(2);
});

test("the runner starts the agent on the overridden model, and on the file's when there is none", () => {
  for (const model of [undefined, "opus"]) {
    const { dir, db, run, repo: r } = setup();
    // A claude agent, so the model shows up in its command line.
    writeFileSync(join(r, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: claude\nmodel: haiku\n---\nWrite INTENT.md.\n");
    const calls: string[][] = [];
    const fake: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9"}' }) : run(argv, cwd));
    if (model) setOverride(db, { key: "agents.spec-writer.model", value: model, tunable: TUNABLE, now: NOW });
    startTicket(db, { dir, repo: r, id: 1, run: fake, now: NOW });
    const argv = calls[0];
    const i = argv.indexOf("claude");
    expect(argv[argv.indexOf("--model", i) + 1]).toBe(model ? "claude-opus-5-5" : "claude-haiku-5-5"); // aliases launch pinned
  }
});

test("the handoff threshold comes from the ticket's snapshot", async () => {
  const { handoffAt } = await import("./handoff.ts");
  expect(handoffAt({ handoff_at_context: settingOf({ settings: '{"budget.handoff_at_context":"50%"}' }, "budget.handoff_at_context", "70%") })).toBe(0.5);
  expect(handoffAt({ handoff_at_context: settingOf({ settings: "{}" }, "budget.handoff_at_context", "70%") })).toBe(0.7);
});

test("learn export prints the edits as a patch, for agent headers, nested keys and missing ones, and writes nothing", () => {
  const r = repo();
  const before = readFileSync(join(r, ".factory/factory.yaml"), "utf8");
  const ov = (key: string, value: unknown) => ({ key, value, reason: null, at: NOW });
  const { patch, notes } = exportPatch(r, [ov("agents.reviewer.model", "sonnet"), ov("budget.handoff_at_context", "50%"), ov("agents.spec-writer.effort", "high"), ov("defaults.model", "opus"), ov("agents.ghost.model", "x")]);
  expect(patch).toContain("--- a/.factory/agents/reviewer.md\n+++ b/.factory/agents/reviewer.md\n@@ -4 +4 @@\n-model: claude-opus-5-5\n+model: sonnet");
  expect(patch).toContain("--- a/.factory/agents/spec-writer.md");
  expect(patch).toContain("+effort: high"); // not in the file: added to the header
  expect(patch).toContain("--- a/.factory/factory.yaml");
  expect(patch).toContain("+budget:\n+  handoff_at_context: 50%".replace("+budget:\n", "")); // budget exists: only the child is added
  expect(notes).toEqual([".factory/factory.yaml defaults.model: defaults is an inline map; set opus by hand", expect.stringContaining("agents/ghost.md doesn't exist")]);
  expect(readFileSync(join(r, ".factory/factory.yaml"), "utf8")).toBe(before);
  // The patch applies.
  writeFileSync(join(r, "o.patch"), patch + "\n");
  expect(sh(["git", "-C", r, "apply", "--unidiff-zero", "--check", "o.patch"]).code).toBe(0);
});

test("factory learn: set refuses a non-tunable key, list/undo/export work, and status.json shows each override beside the file's value", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const lead = repo();
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], (s) => out.push(s));
  run("init", "--repo", "acme/api", "--path", lead);
  expect(() => run("learn", "set", "ready", "[evidence]")).toThrow("isn't in factory.yaml's learn.tunable");
  expect(() => run("learn", "set", "agents.reviewer.model")).toThrow("usage");
  run("learn", "set", "agents.reviewer.model", "sonnet", "--why", "cheaper and as good");
  run("learn", "set", "budget.handoff_at_context", "0.5");
  out.length = 0;
  run("learn", "list");
  expect(out).toEqual(['agents.reviewer.model = "sonnet"  (' + new Date().toISOString().slice(0, 10) + ": cheaper and as good)", "budget.handoff_at_context = 0.5  (" + new Date().toISOString().slice(0, 10) + ")"]);

  const db = open(paths("acme-api").db);
  const status = buildStatus(db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.overrides).toEqual([
    { key: "agents.reviewer.model", value: "sonnet", file: "claude-opus-5-5", reason: "cheaper and as good", at: expect.any(String) },
    { key: "budget.handoff_at_context", value: 0.5, file: null, reason: null, at: expect.any(String) },
  ]);
  db.close();

  out.length = 0;
  run("learn", "export");
  expect(out.join("\n")).toContain("-model: claude-opus-5-5\n+model: sonnet");
  run("learn", "undo", "agents.reviewer.model");
  expect(() => run("learn", "undo", "agents.reviewer.model")).toThrow("no override to undo");
  out.length = 0;
  run("learn", "list", "--json");
  expect(JSON.parse(out[0]).map((o: any) => o.key)).toEqual(["budget.handoff_at_context"]);
});

test("a status with a malformed override is refused by the contract", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "ov-")), "factory.db"));
  const s: any = buildStatus(db);
  expect(validateStatus({ ...s, overrides: [{ key: "a.b", value: { x: 1 }, file: null, reason: null, at: NOW }] })[0]).toMatch(/overrides\[0\]/);
  expect(validateStatus({ ...s, overrides: [] })).toEqual([]);
});

// ---- lessons ----------------------------------------------------------------------

test("lessons: near-duplicates are marked on add, retire takes one out, FTS finds by words", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "les-")), "factory.db"));
  const a = addLesson(db, { area: "src/auth/**", text: "Always hash tokens before storing them.", now: NOW });
  expect(a.dup_of).toBeNull();
  expect(addLesson(db, { area: "src/auth/**", text: "always HASH tokens before storing them", now: NOW }).dup_of).toBe(a.id);
  expect(addLesson(db, { area: "src/auth/**", text: "Always hash tokens before storing them, with the pepper.", now: NOW }).dup_of).toBe(a.id); // holds the other's text
  expect(addLesson(db, { area: "src/web/**", text: "Always hash tokens before storing them.", now: NOW }).dup_of).toBeNull(); // another area
  expect(addLesson(db, { area: "src/auth/**", text: "Rotate keys yearly.", now: NOW }).dup_of).toBeNull();
  expect(listLessons(db, "hash pepper").map((l) => l.id)).toEqual([3]);
  expect(listLessons(db, "src").length).toBeGreaterThan(0); // area is indexed too
  retireLesson(db, 5, NOW);
  expect(() => retireLesson(db, 5, NOW)).toThrow("no active lesson 5");
  expect(listLessons(db).at(-1)!.retired_at).toBe(NOW);
  // A retired lesson stops being a duplicate target.
  retireLesson(db, 1, NOW);
  expect(addLesson(db, { area: "src/auth/**", text: "Always hash tokens before storing them.", now: NOW }).dup_of).toBeNull();
});

test("a stage's brief carries the lessons whose area matches touched files or INTENT.md paths, a handful at most, and counts their hits", () => {
  const { dir, db, run, repo: r } = setup();
  const calls: string[][] = [];
  const fake: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9"}' }) : run(argv, cwd));
  const auth = addLesson(db, { area: "src/auth/**", text: "Hash tokens first.", now: NOW }).id;
  const web = addLesson(db, { area: "src/web/", text: "Web pages need a loading state.", now: NOW }).id;
  const retired = addLesson(db, { area: "src/auth/**", text: "Old advice.", now: NOW }).id;
  retireLesson(db, retired, NOW);
  addLesson(db, { area: "docs/**", text: "Docs lesson.", now: NOW });
  const folder = join(dir, "tickets", "1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "INTENT.md"), "Change src/web/app.ts so it shows a spinner.\n");
  startTicket(db, { dir, repo: r, id: 1, run: fake, now: NOW });
  const text = calls[0].at(-1)!;
  expect(text).toContain("Web pages need a loading state.");
  expect(text).not.toContain("Hash tokens first."); // nothing touched src/auth yet
  expect(text).not.toContain("Old advice.");
  expect(text).not.toContain("Docs lesson.");
  const hits = (id: number) => (db.query("SELECT hits FROM lessons WHERE id = ?").get(id) as any).hits;
  expect([hits(auth), hits(web), hits(retired)]).toEqual([0, 1, 0]);

  // A file the ticket has touched in its worktree (uncommitted) matches too.
  const wt = (db.query("SELECT worktree FROM ticket_lead WHERE id = 1").get() as any).worktree;
  mkdirSync(join(wt, "src/auth"), { recursive: true });
  writeFileSync(join(wt, "src/auth/login.ts"), "export {}\n");
  expect(lessonsFor(db, ["src/auth/login.ts"]).map((l) => l.id)).toEqual([auth]);
  expect(hits(auth)).toBe(1);
  // No paths, no lessons: nothing is loaded for a ticket that touched nothing.
  expect(lessonsFor(db, [])).toEqual([]);
});

test("at most five lessons go into a brief", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "les-")), "factory.db"));
  for (let i = 0; i < 8; i++) addLesson(db, { area: "src/**", text: `Lesson number ${i} says something different.`, now: NOW });
  expect(lessonsFor(db, ["src/a.ts"])).toHaveLength(5);
  expect(brief({ id: 1, title: "t" }, "spec", null, "/f", undefined, [], ["(src/**) one"])).toContain("Lessons for the code this ticket touches");
  expect(brief({ id: 1, title: "t" }, "spec", null, "/f")).not.toContain("Lessons");
});

test("factory lesson: add, list, retire from the CLI", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], (s) => out.push(s));
  run("init", "--repo", "acme/api", "--path", repo());
  run("lesson", "add", "src/auth/**", "Hash", "tokens", "first.");
  run("lesson", "add", "src/auth/**", "hash tokens first");
  expect(out.slice(-2)).toEqual(["lesson 1 added", "lesson 2 added, a near-duplicate of 1; it stays out of briefs"]);
  out.length = 0;
  run("lesson", "list", "tokens");
  expect(out[0]).toContain("2  src/auth/**  hash tokens first  (you, 0 hits, near-duplicate of 1)");
  run("lesson", "retire", "1");
  expect(() => run("lesson", "retire", "1")).toThrow("no active lesson 1");
  expect(() => run("lesson", "add", "src/**")).toThrow("usage");
});
