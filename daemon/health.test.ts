import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, open, setMeta, setRepo } from "./db.ts";
import { change } from "./cli.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { sh } from "./runner.ts";
import { worktreePath } from "./herdr.ts";
import { dueHealth, firstFailure, healthTrigger, runHealth } from "./health.ts";

const git = (repo: string, ...args: string[]) => sh(["git", "-C", repo, ...args]);

// A repo whose suite passes while ok.txt is committed on main. The factory runs it as quality_floor.
function factory(o: { floor?: string[]; triggers?: Record<string, string> } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(repo, ...c);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  rmSync(join(repo, ".factory/triggers"), { recursive: true });
  const floor = o.floor ?? ["echo setting up", "test -f ok.txt || { echo 'ran 3 tests'; echo 'FAIL ok.test > ok.txt is there'; echo '  expected a file'; exit 1; }"];
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: [${floor.map((c) => JSON.stringify(c)).join(", ")}]\n`);
  if (o.triggers) {
    sh(["mkdir", "-p", join(repo, ".factory/triggers")]);
    for (const [n, text] of Object.entries(o.triggers)) writeFileSync(join(repo, ".factory/triggers", n), text);
  }
  writeFileSync(join(repo, "ok.txt"), "ok\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  setMeta(db, "name", "t");
  let clock = Date.parse("2026-11-21T06:00:00Z");
  const now = () => new Date((clock += 60_000)).toISOString();
  const check = () => runHealth(db, { dir, repo, trigger: healthTrigger(repo), run: sh, now, commit: (fn) => change(db, fn) });
  const breakMain = () => { git(repo, "rm", "-q", "ok.txt"); git(repo, "commit", "-q", "-m", "break"); };
  const fixMain = () => { writeFileSync(join(repo, "ok.txt"), "ok\n"); git(repo, "add", "ok.txt"); git(repo, "commit", "-q", "-m", "fix"); };
  return { db, dir, repo, check, breakMain, fixMain };
}

const tickets = (db: ReturnType<typeof open>) => db.query("SELECT id, title, state, blueprint, trigger_name, groomed_at FROM tickets ORDER BY id").all() as any[];

test("a failing suite files one bugfix ticket with its first failure; another failure files none; a pass closes it", () => {
  const f = factory();
  f.breakMain();
  const [h] = f.check();
  expect(h).toMatchObject({ repo: "acme/api", ok: false, branch: "main", command: expect.stringContaining("test -f ok.txt"), error: null });
  expect(h.failure).toStartWith("FAIL ok.test > ok.txt is there");
  expect(tickets(f.db)).toEqual([{ id: h.ticket, title: expect.stringContaining("Repo health: acme/api main fails"), state: "queued", blueprint: "bugfix", trigger_name: "health", groomed_at: null }]);
  const intent = readFileSync(join(f.dir, "tickets", String(h.ticket), "INTENT.md"), "utf8");
  expect(intent).toContain("FAIL ok.test > ok.txt is there");
  expect(intent).toContain(h.commit!);
  // The throwaway worktree is gone, and the repo's own checkout untouched.
  expect(existsSync(worktreePath(f.repo, "health-main"))).toBe(false);
  expect(git(f.repo, "worktree", "list").out.split("\n").length).toBe(1);

  // Still red: the same ticket. Home shows the result.
  const [again] = f.check();
  expect(again.ticket).toBe(h.ticket);
  expect(tickets(f.db).length).toBe(1);
  const s = buildStatus(f.db);
  expect(validateStatus(s)).toEqual([]);
  expect(s.health).toEqual([again]);

  // Green again: the ticket nobody started closes, and the next failure files a new one.
  f.fixMain();
  const [pass] = f.check();
  expect(pass).toMatchObject({ ok: true, ticket: null, command: null, failure: null });
  expect(tickets(f.db)[0].state).toBe("closed");
  expect(f.db.query("SELECT who, what FROM decisions WHERE ticket = ? ORDER BY id").all(h.ticket)).toEqual([
    { who: "health", what: "added a goal" }, { who: "health", what: "health: the full suite fails" }, { who: "health", what: "closed: the full suite passes again" },
  ]);
  f.breakMain();
  const [next] = f.check();
  expect(next.ticket).not.toBe(h.ticket);
  expect(tickets(f.db).map((t) => t.state)).toEqual(["closed", "queued"]);
});

test("a different failure is noted on the open ticket; a pass leaves a ticket being worked on to you", () => {
  const f = factory();
  f.breakMain();
  const [h] = f.check();
  writeFileSync(join(f.repo, "ok.txt"), "now it's there\n");
  writeFileSync(join(f.repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"echo 'error: lint failed'; exit 2\"]\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-q", "-m", "another way to fail");
  const [other] = f.check();
  expect(other).toMatchObject({ ok: false, ticket: h.ticket, failure: "error: lint failed" });
  expect(f.db.query("SELECT what FROM decisions WHERE ticket = ? AND what LIKE '%differently'").all(h.ticket).length).toBe(1);
  f.db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(h.ticket);
  writeFileSync(join(f.repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"true\"]\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-q", "-m", "green");
  const [pass] = f.check();
  expect(pass).toMatchObject({ ok: true, ticket: h.ticket });
  expect(tickets(f.db)[0].state).toBe("running");
  expect(f.db.query("SELECT what FROM decisions WHERE ticket = ? ORDER BY id DESC LIMIT 1").get(h.ticket)).toEqual({ what: "health: main passes again" });
});

test("a suite that can't run files nothing: no commands, or a setup command that fails", () => {
  const none = factory({ floor: [] });
  expect(none.check()).toEqual([expect.objectContaining({ ok: null, error: "no quality_floor commands in its factory.yaml" })]);
  const setup = factory({ triggers: { "health.yaml": "on: schedule\nevery: 1d\nrun: health\nblueprint: bugfix\nsetup: [\"echo no network; exit 3\"]\n" } });
  setup.breakMain();
  const [h] = setup.check();
  expect(h).toMatchObject({ ok: null, ticket: null, error: "setup `echo no network; exit 3` exited 3: no network" });
  expect(tickets(setup.db)).toEqual([]);
  expect(validateStatus(buildStatus(setup.db))).toEqual([]);
});

test("the suite runs on origin's default branch as fetched, not the local checkout", () => {
  const f = factory();
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "clone", "-q", "--bare", f.repo, origin]);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  const clone = mkdtempSync(join(tmpdir(), "clone-"));
  sh(["git", "clone", "-q", origin, clone]);
  // origin breaks after the clone; the clone's own main still passes.
  git(f.repo, "remote", "add", "origin", origin);
  f.breakMain();
  git(f.repo, "push", "-q", "origin", "main");
  f.db.query("UPDATE repos SET path = ? WHERE slug = 'acme/api'").run(clone);
  const [h] = runHealth(f.db, { dir: f.dir, repo: clone, trigger: healthTrigger(clone), run: sh, now: () => new Date().toISOString(), commit: (fn) => change(f.db, fn) });
  expect(h).toMatchObject({ ok: false, branch: "main", commit: git(f.repo, "rev-parse", "--short", "HEAD").out });
  expect(existsSync(join(clone, "ok.txt"))).toBe(true);
});

test("the daemon's health clock: stamped on first sight, due a day later, never for on: manual", () => {
  const f = factory();
  expect(dueHealth(f.db, f.repo, "2026-11-21T10:00:00Z")).toEqual([]);
  expect(getMeta(f.db, "trigger_at:health")).toBe("2026-11-21T10:00:00Z");
  expect(dueHealth(f.db, f.repo, "2026-11-22T09:00:00Z")).toEqual([]);
  expect(dueHealth(f.db, f.repo, "2026-11-22T10:00:00Z")).toEqual(["health"]);
  expect(dueHealth(f.db, f.repo, "2026-11-22T10:05:00Z")).toEqual([]);
  const manual = factory({ triggers: { "health.yaml": "on: manual\nrun: health\nblueprint: bugfix\n" } });
  expect(dueHealth(manual.db, manual.repo, "2026-11-21T10:00:00Z")).toEqual([]);
  expect(dueHealth(manual.db, manual.repo, "2026-12-21T10:00:00Z")).toEqual([]);
  expect(healthTrigger(manual.repo).on).toBe("manual");
});

test("the first failure starts at the first line that reports one, not at a zero-failures summary", () => {
  expect(firstFailure("ran 4 tests\n0 failed\nnot ok 2 - adds\n  got 3")).toBe("not ok 2 - adds\n  got 3");
  expect(firstFailure("Segmentation fault?\nno\n")).toBe("Segmentation fault?\nno");
  expect(firstFailure("line a\nline b")).toBe("line a\nline b");
  expect(firstFailure("")).toBe("(no output)");
});
