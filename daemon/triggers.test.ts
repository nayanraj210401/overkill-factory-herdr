import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { runTriggers } from "./cli.ts";
import { pollQueue } from "./intake.ts";
import { sh, type Run } from "./runner.ts";
import { DEFAULT_TRIGGERS, capsOf, isDue, matchesFilter, readTriggers, withinCaps } from "./triggers.ts";
import { parseEvery, validateFile } from "./validate.ts";

test("every reads 30m, 6h and 1d; anything else is no schedule", () => {
  expect(parseEvery("30m")).toBe(1_800_000);
  expect(parseEvery("6h")).toBe(21_600_000);
  expect(parseEvery("1d")).toBe(86_400_000);
  for (const bad of ["", "0m", "soon", "5", "1w", 30, undefined]) expect(parseEvery(bad)).toBeNull();
});

test("a schedule trigger needs a valid every, and no other trigger has one", () => {
  expect(validateFile("triggers/n.yaml", "on: schedule\nblueprint: chore\nevery: 6h\n")).toEqual([]);
  expect(validateFile("triggers/n.yaml", "on: schedule\nblueprint: chore\n")[0]).toContain("needs every");
  expect(validateFile("triggers/n.yaml", "on: schedule\nblueprint: chore\nevery: often\n")[0]).toContain("needs every");
  expect(validateFile("triggers/n.yaml", "on: manual\nblueprint: chore\nevery: 6h\n")[0]).toContain("only a schedule trigger");
});

test("a trigger is due when it never ran, or its interval has passed", () => {
  const t = Date.parse("2026-11-21T10:00:00Z");
  expect(isDue(null, t, 60_000)).toBe(true);
  expect(isDue("2026-11-21T09:59:30Z", t, 60_000)).toBe(false);
  expect(isDue("2026-11-21T09:59:00Z", t, 60_000)).toBe(true);
});

test("a filter's repos and labels each narrow what counts; no filter passes all", () => {
  const item = { repo: "Acme/API", labels: ["Bug", "p1"] };
  expect(matchesFilter(undefined, item)).toBe(true);
  expect(matchesFilter({ repos: ["acme/api"] }, item)).toBe(true);
  expect(matchesFilter({ repos: ["acme/web"] }, item)).toBe(false);
  expect(matchesFilter({ labels: ["bug"] }, item)).toBe(true);
  expect(matchesFilter({ labels: ["docs", "chore"] }, item)).toBe(false);
  expect(matchesFilter({ labels: ["bug"] }, { repo: "acme/api" })).toBe(false);
  expect(matchesFilter({ repos: ["acme/api"], labels: ["docs"] }, item)).toBe(false);
});

test("concurrency leaves room for its running tickets, and uncapped triggers start freely", () => {
  const waiting = [{ id: 1, trigger: "nightly" }, { id: 2, trigger: "nightly" }, { id: 3, trigger: "nightly" }, { id: 4, trigger: "queue" }, { id: 5, trigger: null }];
  expect(withinCaps(waiting, { nightly: 1 }, { nightly: 2 }).map((w) => w.id)).toEqual([1, 4, 5]);
  expect(withinCaps(waiting, {}, { nightly: 2 }).map((w) => w.id)).toEqual([1, 2, 4, 5]);
  expect(withinCaps(waiting, { nightly: 5 }, { nightly: 2 }).map((w) => w.id)).toEqual([4, 5]);
  expect(withinCaps(waiting, {}, {}).length).toBe(5);
});

function factory(triggers: Record<string, string> | null) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nqueue: { github_project: acme/7, column: Ready }\n");
  rmSync(join(repo, ".factory/triggers"), { recursive: true });
  if (triggers) {
    mkdirSync(join(repo, ".factory/triggers"));
    for (const [n, text] of Object.entries(triggers)) writeFileSync(join(repo, ".factory/triggers", n), text);
  }
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return calls.push(argv), { code: 0, out: '{"address":"t1"}' };
    if (argv[0] === "gh") return calls.push(argv), { code: 0, out: argv[1] === "project" && argv[2] === "item-list" ? JSON.stringify({ items: [
      { status: "Ready", labels: ["bug"], content: { type: "Issue", number: 5, title: "A bug", repository: "acme/api" } },
      { status: "Ready", labels: ["docs"], content: { type: "Issue", number: 6, title: "Docs", repository: "acme/api" } }] }) : "" };
    return sh(argv, cwd);
  };
  const logs: string[] = [];
  const tick = (now: string) => runTriggers(db, { dir, repo, slug: "acme/api", run, now, log: (s) => logs.push(s) });
  return { db, repo, calls, logs, tick };
}

test("no triggers folder keeps the built-ins: the queue and the PR watcher", () => {
  const { repo } = factory(null);
  expect(readTriggers(repo)).toEqual({ triggers: DEFAULT_TRIGGERS, skipped: [] });
  expect(DEFAULT_TRIGGERS.map((t) => t.on)).toEqual(["project_ready", "pr_review_comment"]);
});

test("a project_ready trigger's filter and blueprint decide which issues join, and as what", () => {
  const { db, repo, tick } = factory({ "bugs.yaml": "on: project_ready\nfilter: { labels: [bug] }\nblueprint: bugfix\n" });
  // bugs.yaml takes the place of the built-in queue trigger; the built-in watcher stays.
  expect(readTriggers(repo).triggers.map((t) => t.name)).toEqual(["bugs", "review-comments"]);
  tick("2026-11-21T10:00:00Z");
  expect(db.query("SELECT id, blueprint, trigger_name, state FROM tickets").all()).toEqual([{ id: 5, blueprint: "bugfix", trigger_name: "bugs", state: "grooming" }]);
});

test("the loop starts a scheduled ticket when due, and not again before the interval passes", () => {
  const { db, calls, logs, tick } = factory({ "nightly.yaml": "on: schedule\nevery: 1h\nblueprint: feature\nconcurrency: 1\n" });
  tick("2026-11-21T10:00:00Z");
  expect(db.query("SELECT trigger_name, state, blueprint FROM tickets WHERE trigger_name = 'nightly'").all()).toEqual([{ trigger_name: "nightly", state: "running", blueprint: "feature" }]);
  expect(logs.some((l) => l.includes("started by nightly"))).toBe(true);
  expect(calls.filter((c) => c[0] === "hc").length).toBeGreaterThan(0);
  tick("2026-11-21T10:30:00Z"); // not due
  expect(db.query("SELECT COUNT(*) AS n FROM tickets WHERE trigger_name = 'nightly'").get()).toEqual({ n: 1 });
  tick("2026-11-21T11:00:01Z"); // due, but its one ticket is still running
  expect(db.query("SELECT COUNT(*) AS n FROM tickets WHERE trigger_name = 'nightly'").get()).toEqual({ n: 1 });
  db.query("UPDATE tickets SET state = 'merged' WHERE trigger_name = 'nightly'").run();
  tick("2026-11-21T12:00:02Z");
  expect(db.query("SELECT COUNT(*) AS n FROM tickets WHERE trigger_name = 'nightly'").get()).toEqual({ n: 2 });
});

test("pollQueue without a trigger still joins every Ready issue as before", () => {
  const { db, repo } = factory(null);
  const run: Run = () => ({ code: 0, out: JSON.stringify({ items: [{ status: "Ready", content: { type: "Issue", number: 9, title: "x", repository: "acme/api" } }] }) });
  pollQueue(db, { queue: { github_project: "acme/7" }, repo: "acme/api", run, now: "2026-11-21T10:00:00Z" });
  expect(db.query("SELECT id, blueprint, trigger_name FROM tickets").all()).toEqual([{ id: 9, blueprint: "feature", trigger_name: "queue" }]);
  expect(repo).toBeTruthy();
});
