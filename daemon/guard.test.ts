import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, argvFor, sh, startTicket, type Run } from "./runner.ts";
import { watchSessions, paths } from "./cli.ts";
import { guardHit, guardSettings, hardStopLog, STOPS } from "./guard.ts";

const g = { stops: [...STOPS], roots: ["/work/wt", "/work/ticket"], cwd: "/work/wt" };
const bash = (command: string, guard = g) => guardHit("Bash", { command }, guard);
const stopOf = (command: string) => bash(command)?.stop ?? null;

test("git push and PR merges are the push-to-main stop", () => {
  expect(stopOf("git push origin main")).toBe("push-to-main");
  expect(stopOf("git push")).toBe("push-to-main");
  expect(stopOf("cd x && git push --force-with-lease origin HEAD:master")).toBe("push-to-main");
  expect(stopOf("gh pr merge 3 --squash")).toBe("push-to-main");
  expect(stopOf('git commit -m "do not git push"')).toBeNull();
  expect(stopOf("git status && git log --oneline")).toBeNull();
});

test("destructive commands stop; ordinary cleanup inside the worktree doesn't", () => {
  for (const c of ["git reset --hard HEAD~1", "git clean -fdx", "git branch -D x", "git checkout .", "rm -rf /", "rm -rf ~/Documents", "rm -rf /work/wt", "rm -rf .git", "rm -rf ../other", "sudo ls", "git stash clear"])
    expect(stopOf(c)).toBe("destructive-commands");
  for (const c of ["rm -rf node_modules", "rm -rf /work/wt/dist", "rm file.txt", "git reset --soft HEAD~1", "git clean -n", "rm -rf /tmp/scratch"])
    expect(stopOf(c)).toBeNull();
});

test("writes outside the ticket's worktrees stop, for tools and for Bash", () => {
  expect(guardHit("Write", { file_path: "/etc/hosts", content: "x" }, g)?.stop).toBe("outside-worktree");
  expect(guardHit("Edit", { file_path: "/work/wt/../secret.txt", new_string: "x" }, g)?.stop).toBe("outside-worktree");
  expect(guardHit("Edit", { file_path: "src/a.ts", new_string: "x" }, g)).toBeNull();
  expect(guardHit("Write", { file_path: "/work/ticket/INTENT.md", content: "x" }, g)).toBeNull();
  expect(stopOf("echo hi > /Users/me/.zshrc")).toBe("outside-worktree");
  expect(stopOf("cp a.txt ~/Desktop/")).toBe("outside-worktree");
  expect(stopOf("sed -i s/a/b/ /etc/hosts")).toBe("outside-worktree");
  expect(stopOf("echo hi > out.txt && ls 2>/dev/null")).toBeNull();
  expect(stopOf("cp a.txt /work/wt/b.txt")).toBeNull();
  expect(stopOf("bun test 2>&1 | tail")).toBeNull();
});

test("secrets in what the agent writes stop", () => {
  const key = "ghp_" + "a".repeat(36);
  expect(guardHit("Write", { file_path: "/work/wt/.env", content: `TOKEN=${key}` }, g)?.stop).toBe("secrets-in-output");
  expect(guardHit("Edit", { file_path: "/work/wt/a", new_string: "AKIAABCDEFGHIJKLMNOP" }, g)?.stop).toBe("secrets-in-output");
  expect(stopOf(`curl -H "Authorization: ${key}" x`)).toBe("secrets-in-output");
  expect(guardHit("Write", { file_path: "/work/wt/a", content: "const x = 1" }, g)).toBeNull();
});

test("only the stops factory.yaml lists are enforced", () => {
  const only = (s: string) => ({ ...g, stops: [s] });
  expect(bash("git push", only("destructive-commands"))).toBeNull();
  expect(bash("git reset --hard", only("push-to-main"))).toBeNull();
  expect(guardHit("Write", { file_path: "/etc/x", content: "" }, only("push-to-main"))).toBeNull();
  expect(guardHit("Write", { file_path: "/work/wt/a", content: "ghp_" + "a".repeat(36) }, only("outside-worktree"))).toBeNull();
  expect(guardSettings({ stops: [], roots: [], log: "/l" })).toBeNull();
  expect(guardSettings({ stops: ["nonsense"], roots: [], log: "/l" })).toBeNull();
});

test("a Claude worker gets the guard through --settings; Codex and other programs don't", () => {
  const settings = guardSettings({ stops: ["push-to-main"], roots: ["/a", "/b"], log: "/l/hard-stops.jsonl", bun: "/usr/bin/bun", script: "/d/guard.ts" })!;
  const hook = JSON.parse(settings).hooks.PreToolUse[0];
  expect(hook.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
  expect(hook.hooks[0].command).toBe("'/usr/bin/bun' '/d/guard.ts' --stops 'push-to-main' --roots '/a:/b' --log '/l/hard-stops.jsonl'");
  expect(argvFor(null, { harness: "claude", model: "sonnet" }, "go", settings)).toEqual(["claude", "--model", "sonnet", "--settings", settings, "go"]);
  expect(argvFor(null, { harness: "claude", model: "sonnet" }, "go")).toEqual(["claude", "--model", "sonnet", "go"]);
  expect(argvFor({ harness: "codex" }, { harness: "claude" }, "go", settings)).toEqual(["codex", "go"]);
});

test("a hit blocks the call, is noted, kills the session and parks the ticket", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\nhard_stops: [push-to-main, outside-worktree]\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', 'feature', '2026-11-21T10:00:00Z')").run();
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: argv[1] === "get" ? '{"state":"agent"}' : '{"address":"t1"}' }) : sh(argv, cwd));
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  const argv = calls[0];
  const settings = argv[argv.indexOf("--settings") + 1];
  const command = JSON.parse(settings).hooks.PreToolUse[0].hooks[0].command as string;
  const wt = (db.query("SELECT worktree FROM ticket_lead WHERE id = 7").get() as any).worktree as string;
  expect(command).toContain("--stops 'push-to-main,outside-worktree'");
  expect(command).toContain(wt);

  // The real hook, as Claude Code runs it: the event on stdin, exit 2 and a reason on stderr.
  const hook = (tool_name: string, tool_input: object) =>
    Bun.spawnSync(["sh", "-c", command], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name, tool_input, cwd: wt })) });
  expect(hook("Bash", { command: "git status" }).exitCode).toBe(0);
  expect(existsSync(hardStopLog(dir, 7))).toBe(false);
  const blocked = hook("Bash", { command: "git push origin main" });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr.toString()).toContain("push-to-main");

  // The daemon's next tick kills the session and parks the ticket with the reason.
  calls.length = 0;
  watchSessions(db, { ...paths("t", dir), dir }, run, () => {});
  expect(calls.some((c) => c[1] === "kill" && c[2] === "t1")).toBe(true);
  expect(db.query("SELECT state, needs_text FROM ticket_lead WHERE id = 7").get()).toEqual({ state: "parked", needs_text: "Hard stop hit: push-to-main: agents don't push; the daemon opens the PR" });
  expect(db.query("SELECT who, what FROM decisions WHERE ticket = 7").get()).toEqual({ who: "guard", what: "hard stop hit" });
  expect(existsSync(hardStopLog(dir, 7))).toBe(false); // read once, so answering and restarting doesn't park again
  expect(() => advance(db, { dir, repo, id: 7, run })).toThrow("isn't running");
});
