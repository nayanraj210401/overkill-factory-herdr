import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { buildStatus } from "./status.ts";
import { argvFor, plannedPath, loadBlueprint, sh, startTicket, type Run } from "./runner.ts";
import { validateStatus } from "../lib/status.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", dir, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: echo\n---\nWrite INTENT.md.\n");
  sh(["git", "-C", dir, "add", "."]);
  sh(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const calls: string[][] = [];
  // Real git; hc is faked and answers like `hc run --bg --json`.
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9","state":"live"}' }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (412, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  return { dir, db, calls, run, repo: repo() };
}

test("the planned path follows each stage's first next", () => {
  const b = loadBlueprint(join(import.meta.dir, "../fixtures/acme-api"), "feature");
  expect(plannedPath(b, "spec")).toEqual(["plan", "implement", "verify", "review", "pr", "merge"]);
});

test("start: own worktree and branch, first stage, its agent in a herdr-core terminal", () => {
  const { dir, db, calls, run, repo: r } = setup();
  const terminal = startTicket(db, { dir, repo: r, id: 412, run, now: "2026-11-21T10:00:00Z" });
  expect(terminal).toBe("t9");
  const t = db.query("SELECT state, stage, worktree, branch FROM tickets WHERE id = 412").get() as any;
  expect(t).toMatchObject({ state: "running", stage: "spec", branch: "factory/412-rate-limit-login" });
  expect(existsSync(join(t.worktree, ".factory/factory.yaml"))).toBe(true);
  expect(sh(["git", "-C", t.worktree, "branch", "--show-current"]).out).toBe("factory/412-rate-limit-login");
  const hc = calls[0];
  expect(hc.slice(0, 5)).toEqual(["hc", "run", "--bg", "--json", "--no-parent"]);
  expect(hc).toContain("--outlive-parent");
  expect(hc[hc.indexOf("--cwd") + 1]).toBe(t.worktree);
  expect(hc).toContain("factory.ticket=412");
  expect(hc.at(-2)).toBe("echo"); // spec-writer's harness
  expect(hc.at(-1)).toContain("Ticket #412: Rate-limit login. You run its spec stage.");
  expect(hc.at(-1)).toContain("Write INTENT.md.");
  const s = buildStatus(db);
  expect(validateStatus(s)).toEqual([]);
  expect(s.tickets[0].terminal).toBe("t9");
  expect(db.query("SELECT stage, agent, terminal FROM sessions").all()).toEqual([{ stage: "spec", agent: "spec-writer", terminal: "t9" }]);
});

test("start refuses tickets that aren't ready, and names a missing blueprint", () => {
  const { dir, db, run, repo: r } = setup();
  db.query("UPDATE tickets SET state = 'grooming', needs_kind = 'question', needs_text = 'x' WHERE id = 412").run();
  expect(() => startTicket(db, { dir, repo: r, id: 412, run })).toThrow(/open questions/);
  db.query("UPDATE tickets SET state = 'queued', needs_kind = NULL, blueprint = 'nope' WHERE id = 412").run();
  expect(() => startTicket(db, { dir, repo: r, id: 412, run })).toThrow(/no blueprint "nope"/);
});

test("argv: claude and codex get --model; any other program gets the brief last", () => {
  expect(argvFor(null, { harness: "claude", model: "sonnet" }, "go")).toEqual(["claude", "--model", "sonnet", "go"]);
  expect(argvFor({ harness: "codex" }, { harness: "claude" }, "go")).toEqual(["codex", "go"]);
  expect(argvFor({ harness: "echo" }, { harness: "claude", model: "sonnet" }, "go")).toEqual(["echo", "go"]);
});
