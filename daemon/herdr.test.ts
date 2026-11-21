import { test, expect, afterEach } from "bun:test";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { sh, startTicket, mergeTicket, type Run } from "./runner.ts";
import { watchSessions } from "./cli.ts";
import { branchSlug, openAgent, sessionState, worktreePath, worktreeRoot } from "./herdr.ts";

const realHome = process.env.HERDR_APP_HOME!;
const realTrees = process.env.FACTORY_WORKTREES!;
afterEach(() => { process.env.HERDR_APP_HOME = realHome; process.env.FACTORY_WORKTREES = realTrees; });

// An app home that looks like a running Herdr (the socket is only a file: every
// herdr-app call goes to the fake `run`, never a real app).
function fakeApp(settings: object = {}) {
  const home = mkdtempSync(join(tmpdir(), "app-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(home, "herdr-app.sock"), "");
  process.env.HERDR_APP_HOME = home;
  return home;
}

test("worktrees go where Herdr's New worktree puts them", () => {
  expect(branchSlug("factory/412-rate-limit")).toBe("factory-412-rate-limit");
  delete process.env.FACTORY_WORKTREES;
  fakeApp({ worktrees: { directory: "~/Developer/worktrees" } });
  expect(worktreeRoot()).toBe(join(homedir(), "Developer/worktrees"));
  expect(worktreePath("/code/acme-api", "factory/412-rate-limit")).toBe(join(homedir(), "Developer/worktrees/acme-api/factory-412-rate-limit"));
  fakeApp();
  expect(worktreeRoot()).toBe(join(homedir(), ".herdr/worktrees"));
});

test("an agent opens as a tab in the ticket's space, else a new space, else nothing (no app)", () => {
  const calls: string[][] = [];
  const made = { space: "sp1", tab: "tb1", terminal: "t5" };
  const run = (tabWorks: boolean): Run => (argv) => {
    calls.push(argv);
    if (argv[2] === "tab.new" && !tabWorks) return { code: 1, out: '{"error":"no space sp0"}' };
    return { code: 0, out: JSON.stringify(made) };
  };
  const o = { folder: "/wt", space: "sp0", name: "plan", argv: ["claude", "go"] };
  expect(openAgent(run(true), { ...o, space: null })).toBeNull(); // the preload's home has no app
  fakeApp();
  expect(openAgent(run(true), o)).toEqual(made);
  expect(calls.at(-1)).toEqual(["herdr-app", "do", "tab.new", '{"space":"sp0","name":"plan","argv":["claude","go"],"focus":false}']);
  expect(openAgent(run(false), o)).toEqual(made); // the person closed sp0
  expect(calls.at(-1)).toEqual(["herdr-app", "do", "space.new", '{"folder":"/wt","argv":["claude","go"],"focus":false}']);
});

test("a shell's agent is running while it's in front; the shell back in front means done", () => {
  expect(sessionState({ exit_code: 0, pid: 1 })).toBe("exited");
  expect(sessionState({ exit_code: null, pid: 1, foreground: { pid: 1 } })).toBe("shell");
  expect(sessionState({ exit_code: null, pid: 1, foreground: { pid: 2 } })).toBe("agent");
});

function factory() {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setMeta(db, "repo_path", repo);
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', 'feature', '2026-11-21T10:00:00Z')").run();
  return { db, dir, repo, p: { dir, db: join(dir, "factory.db"), status: join(dir, "status.json") } };
}

test("with Herdr running, a ticket's agents are tabs in its worktree space, and a stage ends when the shell is back", () => {
  fakeApp();
  const { db, dir, repo, p } = factory();
  const calls: string[][] = [];
  let fg = 1;
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "herdr-app") return (calls.push(argv), { code: 0, out: JSON.stringify({ space: "sp9", tab: `tb${n}`, terminal: `t${++n}` }) });
    if (argv[0] === "hc") return (calls.push(argv), { code: 0, out: JSON.stringify({ exit_code: null, pid: 1, foreground: { pid: fg } }) });
    return sh(argv, cwd);
  };
  expect(startTicket(db, { dir, repo, id: 7, run })).toBe("t1");
  const t = db.query("SELECT worktree, space FROM tickets").get() as any;
  expect(t).toEqual({ worktree: join(realTrees, require("node:path").basename(repo), "factory-7-wire-it"), space: "sp9" });
  expect(existsSync(join(t.worktree, ".factory"))).toBe(true);
  expect(calls[0][2]).toBe("space.new");
  expect(calls[1]).toEqual(["hc", "label", "t1", "factory.ticket=7", "factory.stage=spec"]);
  const tick = () => watchSessions(db, p, run, () => {});
  const stage = () => (db.query("SELECT stage FROM tickets").get() as any).stage;
  tick(); // the shell is in front, the agent not seen yet: still starting
  expect(stage()).toBe("spec");
  fg = 2; tick(); // the agent is in front
  fg = 1; tick(); // the shell is back: spec is over, plan opens as a tab in sp9
  expect(stage()).toBe("plan");
  expect(calls.filter((c) => c[0] === "herdr-app").at(-1)!.slice(2, 3)).toEqual(["tab.new"]);
  expect(JSON.parse(calls.filter((c) => c[0] === "herdr-app").at(-1)![3])).toMatchObject({ space: "sp9", name: "plan" });
});

test("merging closes the ticket's space and removes its worktree; the branch stays", () => {
  fakeApp();
  const { db, dir, repo } = factory();
  const closed: string[][] = [];
  const run: Run = (argv, cwd) =>
    argv[0] === "herdr-app" ? (argv[2] === "space.close" && closed.push(argv), { code: 0, out: '{"space":"sp9","tab":"tb1","terminal":"t1"}' })
    : argv[0] === "hc" || argv[0] === "gh" ? { code: 0, out: "" } : sh(argv, cwd);
  startTicket(db, { dir, repo, id: 7, run });
  const wt = (db.query("SELECT worktree FROM tickets").get() as any).worktree;
  db.query("UPDATE tickets SET state = 'ready', pr_number = 42 WHERE id = 7").run();
  mergeTicket(db, { repo, id: 7, run });
  expect(closed).toEqual([["herdr-app", "do", "space.close", '{"id":"sp9","confirmed":true}']]);
  expect(existsSync(wt)).toBe(false);
  expect(db.query("SELECT worktree, space FROM tickets").get()).toEqual({ worktree: null, space: null });
  expect(sh(["git", "-C", repo, "branch", "--list", "factory/7-wire-it"]).out).toContain("factory/7-wire-it");
});

test("a start that failed after making the worktree can simply be run again", () => {
  const { db, dir, repo } = factory();
  const broken: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 1, out: "hc: no server" } : sh(argv, cwd));
  expect(() => db.transaction(() => startTicket(db, { dir, repo, id: 7, run: broken }))()).toThrow("hc run failed");
  expect((db.query("SELECT state FROM tickets").get() as any).state).toBe("queued"); // rolled back; the checkout stays
  const ok: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: '{"address":"t3"}' } : sh(argv, cwd));
  expect(startTicket(db, { dir, repo, id: 7, run: ok })).toBe("t3");
  sh(["git", "-C", repo, "worktree", "remove", "--force", (db.query("SELECT worktree FROM tickets").get() as any).worktree]);
  db.query("UPDATE tickets SET state = 'queued', worktree = NULL").run();
  expect(startTicket(db, { dir, repo, id: 7, run: ok })).toBe("t3"); // the branch alone is left: checked out again
});
