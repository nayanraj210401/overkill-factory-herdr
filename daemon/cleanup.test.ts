// Housekeeping (cleanup.ts): what a cleanup lists, what it never touches, and the run that
// removes what the list holds, each entry re-checked. Temp repos, worktrees and FACTORY_HOME; gh, hc stubbed.
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { worktreeRoot } from "./herdr.ts";
import { sh, type Run } from "./runner.ts";
import { backup } from "./maintainer.ts";
import { cleanupDir, cleanupPlan, describe, keyOf, performCleanup, proposeCleanup } from "./cleanup.ts";

const now = new Date(Date.now() + 60_000).toISOString();
const OLD = "2026-01-01T00:00:00Z";
const g = (repo: string, ...a: string[]) => sh(["git", "-C", repo, ...a]);

function setup() {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const repo = mkdtempSync(join(tmpdir(), "api-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) g(repo, ...c);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"true\"]\n");
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  g(repo, "remote", "add", "origin", origin);
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "push", "-q", "origin", "main");
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => {
    calls.push(argv);
    if (argv[0] === "hc") return argv[1] === "rm" ? { code: 0, out: "" } : { code: 0, out: '{"address":"t1"}' };
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return { code: 1, out: "no such PR" };
    if (argv[0] === "gh") return argv[2] === "create" ? { code: 0, out: "https://github.com/acme/api/pull/9" } : { code: 0, out: "" };
    return sh(argv, cwd);
  };
  // A ticket that worked on a factory branch, in a worktree under the worktree root.
  const ticket = (id: number, state: string, opts: { merge?: boolean; push?: boolean; dirty?: boolean; at?: string; pr?: number; space?: string } = {}) => {
    const branch = `factory/${id}-t${id}`;
    const wt = join(worktreeRoot(), "api", `factory-${id}-t${id}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(join(wt, ".."), { recursive: true });
    g(repo, "worktree", "add", "-q", "-b", branch, wt);
    writeFileSync(join(wt, `f${id}.txt`), `${id}\n`);
    g(wt, "add", ".");
    g(wt, "commit", "-q", "-m", `work ${id}`);
    if (opts.push) g(wt, "push", "-q", "origin", branch);
    if (opts.merge) g(repo, "merge", "-q", "--no-ff", "-m", `merge ${id}`, branch);
    if (opts.dirty) writeFileSync(join(wt, "scratch.txt"), "not committed\n");
    db.query("INSERT INTO tickets (id, title, state, blueprint, space, updated_at) VALUES (?, ?, ?, 'feature', ?, ?)").run(id, `t${id}`, state, opts.space ?? null, opts.at ?? OLD);
    setWork(db, id, { worktree: wt, branch, pr_number: opts.pr ?? null, merged_at: state === "merged" ? OLD : null });
    db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, ended_at) VALUES (?, 'implement', 'builder', ?, '[]', ?, ?)").run(id, `term-${id}`, OLD, OLD);
    return { wt, branch, sha: g(wt, "rev-parse", "HEAD").out };
  };
  const plan = () => cleanupPlan(db, { dir, run, now });
  return { db, dir, repo, run, calls, ticket, plan };
}

const keys = (p: { items: any[] }) => p.items.map(keyOf);

test("a cleanup lists an old finished ticket's worktree, terminal, space and merged branches, and nothing of an open one", () => {
  const s = setup();
  const a = s.ticket(1, "merged", { merge: true, push: true, space: "sp1" });
  const b = s.ticket(2, "running", { at: OLD, space: "sp2" }); // old, but still open
  const c = s.ticket(3, "merged", { merge: true, at: new Date().toISOString() }); // merged today: not old yet
  const p = s.plan();
  expect(keys(p)).toEqual([`terminal:term-1`, `space:sp1`, `worktree:${a.wt}`, `branch:acme/api:${a.branch}`, `remote-branch:acme/api:${a.branch}`, "vacuum"]);
  expect(p.items.find((i) => i.kind === "branch")).toMatchObject({ merged: "merged into main", sha: a.sha });
  for (const x of [b, c]) expect(keys(p).some((k) => k.includes(x.branch) || k.includes(x.wt))).toBe(false);
  expect(keys(cleanupPlan(s.db, { dir: s.dir, run: s.run, now, days: 0 }))).toContain(`worktree:${c.wt}`); // --days 0: today's too
  expect(describe(p.items[2])).toBe(`the worktree ${a.wt} in acme/api (#1)`);
});

test("a cleanup never lists an unmerged branch or a worktree with uncommitted changes, and says why it keeps them", () => {
  const s = setup();
  const closed = s.ticket(4, "closed", { push: true }); // closed unmerged
  const dirty = s.ticket(5, "merged", { merge: true, dirty: true });
  const p = s.plan();
  expect(keys(p).filter((k) => k.includes(closed.branch))).toEqual([]);
  expect(keys(p)).toContain(`worktree:${closed.wt}`); // its worktree is clean: it goes; its branch stays
  expect(keys(p)).not.toContain(`worktree:${dirty.wt}`);
  expect(p.kept).toEqual(expect.arrayContaining([
    { key: `branch:acme/api:${closed.branch}`, what: `the branch ${closed.branch} in acme/api (#4)`, why: "it isn't merged" },
    { key: `remote-branch:acme/api:${closed.branch}`, what: `the branch ${closed.branch} on acme/api's origin (#4)`, why: "it isn't merged" },
    { key: `worktree:${dirty.wt}`, what: `the worktree ${dirty.wt} (#5)`, why: "it has uncommitted changes" },
  ]));
});

test("a squash-merged branch counts as merged only when GitHub merged its PR at that very commit", () => {
  const s = setup();
  const t = s.ticket(6, "merged", { pr: 41 }); // never merged into main: a squash merge leaves no ancestry
  const withPr = (pr: object | null): Run => (argv, cwd) =>
    argv[0] === "gh" && argv[2] === "view" ? (pr ? { code: 0, out: JSON.stringify(pr) } : { code: 1, out: "no such PR" }) : s.run(argv, cwd);
  const branch = (run: Run) => cleanupPlan(s.db, { dir: s.dir, run, now }).items.find((i) => keyOf(i) === `branch:acme/api:${t.branch}`);
  expect(branch(withPr(null))).toBeUndefined();
  expect(branch(withPr({ state: "MERGED", headRefOid: "0000" }))).toBeUndefined(); // merged at another commit: this one has work GitHub never saw
  expect(branch(withPr({ state: "OPEN", headRefOid: t.sha }))).toBeUndefined();
  expect(branch(withPr({ state: "MERGED", headRefOid: t.sha }))).toMatchObject({ merged: "PR #41 merged at this commit", sha: t.sha });
});

test("orphaned factory worktrees go; another tool's worktree and a dirty orphan stay; old backups go but the newest stays", () => {
  const s = setup();
  const orphan = join(worktreeRoot(), "api", `orphan-${Math.random().toString(36).slice(2, 7)}`);
  g(s.repo, "worktree", "add", "-q", "-b", "factory/99-gone", orphan);
  const mine = join(worktreeRoot(), "api", `mine-${Math.random().toString(36).slice(2, 7)}`);
  g(s.repo, "worktree", "add", "-q", "-b", "my-own-work", mine);
  const dirtyOrphan = join(worktreeRoot(), "api", `dirty-${Math.random().toString(36).slice(2, 7)}`);
  g(s.repo, "worktree", "add", "-q", "-b", "factory/98-dirty", dirtyOrphan);
  writeFileSync(join(dirtyOrphan, "x.txt"), "uncommitted\n");
  const home = process.env.FACTORY_HOME!;
  const old = Date.parse(OLD) / 1000;
  for (const [f, t] of [["config.yaml.bak-1-1", old], ["config.yaml.bak-2-2", old + 10], ["config.yaml.bak-3-3", Date.now() / 1000]] as const) {
    writeFileSync(join(home, f), "x");
    utimesSync(join(home, f), t, t);
  }
  mkdirSync(join(home, "agents"));
  for (const [f, t] of [["maintainer.md.bak-1-1", old], ["maintainer.md.bak-2-2", old + 5]] as const) { writeFileSync(join(home, "agents", f), "x"); utimesSync(join(home, "agents", f), t, t); }
  // Backups in FACTORY_HOME/backups/ (maintainer.ts): the old one goes, the newest stays.
  const file = join(s.repo, ".factory/factory.yaml");
  const b1 = backup(file, "2026-01-01T00:00:00Z")!, b2 = backup(file, "2026-01-02T00:00:00Z")!;
  utimesSync(b1, old, old); utimesSync(b2, old + 20, old + 20);
  const p = s.plan();
  const real = (x: string) => sh(["realpath", x]).out;
  const wts = p.items.filter((i) => i.kind === "worktree").map((i) => real((i as any).path));
  expect(wts).toEqual([real(orphan)]);
  expect(p.kept.map((k) => k.why)).toEqual(expect.arrayContaining(["the factory didn't make its branch", "it has uncommitted changes"]));
  expect(p.items.filter((i) => i.kind === "backup").map((i) => (i as any).path)).toEqual([b1, join(home, "agents", "maintainer.md.bak-1-1"), join(home, "config.yaml.bak-1-1"), join(home, "config.yaml.bak-2-2")].sort());
  expect(existsSync(mine)).toBe(true);
});

test("a cleanup: --propose writes the list to the factory's cleanup/ folder, --run removes what it holds, and nothing needs a ticket", () => {
  const s = setup();
  const a = s.ticket(1, "merged", { merge: true, push: true, space: "sp1" });
  const keepDirty = s.ticket(2, "merged", { merge: true, dirty: true });
  expect(() => performCleanup(s.db, { dir: s.dir, run: s.run, now })).toThrow(/run factory cleanup --propose first/);
  const p = proposeCleanup(s.db, { dir: s.dir, run: s.run, now });
  const folder = cleanupDir(s.dir);
  expect(keys(p)).toContain(`worktree:${a.wt}`);
  expect(readFileSync(join(folder, "CLEANUP.md"), "utf8")).toContain(`- the worktree ${a.wt} in acme/api (#1)`);
  expect(readFileSync(join(folder, "CLEANUP.md"), "utf8")).toContain("Ticket folders and their .md files stay.");
  expect(existsSync(a.wt)).toBe(true); // listing removes nothing
  const r = performCleanup(s.db, { dir: s.dir, run: s.run, now, who: "maintainer" });
  expect(r.vacuum).toBe(true);
  expect(existsSync(a.wt)).toBe(false);
  expect(g(s.repo, "rev-parse", "--verify", "-q", `refs/heads/${a.branch}`).code).not.toBe(0);
  expect(g(s.repo, "ls-remote", "--heads", "origin", a.branch).out).toBe("");
  expect(s.calls).toContainEqual(["hc", "rm", "term-1"]);
  expect(s.db.query("SELECT worktree FROM ticket_repos WHERE ticket = 1").get()).toEqual({ worktree: null });
  expect(s.db.query("SELECT space FROM tickets WHERE id = 1").get()).toEqual({ space: null });
  // What it never touches: the dirty worktree and its branch.
  expect(existsSync(join(keepDirty.wt, "scratch.txt"))).toBe(true);
  expect(g(s.repo, "rev-parse", "--verify", "-q", `refs/heads/${keepDirty.branch}`).code).toBe(0); // its worktree stays, so its branch does
  expect(p.kept).toContainEqual({ key: `branch:acme/api:${keepDirty.branch}`, what: `the branch ${keepDirty.branch} in acme/api (#2)`, why: "its worktree stays" });
  expect(readFileSync(join(folder, "CLEANUP.md"), "utf8")).toContain("## Done");
  expect(s.db.query("SELECT ticket, who, what FROM decisions WHERE what = 'cleaned up'").get()).toEqual({ ticket: null, who: "maintainer", what: "cleaned up" });
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets WHERE blueprint = 'factory'").get()).toEqual({ n: 0 });
  // Once: the list is set aside, so a second run needs a new one.
  expect(() => performCleanup(s.db, { dir: s.dir, run: s.run, now })).toThrow(/--propose first/);
});

test("a list narrowed to what was asked removes only that; an entry no longer safe is kept and said", () => {
  const s = setup();
  const a = s.ticket(1, "merged", { merge: true });
  const b = s.ticket(3, "merged", { merge: true });
  const p = proposeCleanup(s.db, { dir: s.dir, run: s.run, now });
  // Narrowed: only ticket 1's and 3's worktrees, nothing else.
  const json = join(cleanupDir(s.dir), "CLEANUP.json");
  writeFileSync(json, JSON.stringify({ ...p, items: p.items.filter((i) => i.kind === "worktree") }));
  writeFileSync(join(a.wt, "late.txt"), "someone started work here\n");
  const r = performCleanup(s.db, { dir: s.dir, run: s.run, now });
  expect(existsSync(join(a.wt, "late.txt"))).toBe(true);
  expect(r.skipped.join("\n")).toContain("kept, it has uncommitted changes");
  expect(existsSync(b.wt)).toBe(false);
  expect(g(s.repo, "rev-parse", "--verify", "-q", `refs/heads/${b.branch}`).code).toBe(0); // not in the narrowed list
  expect(r.vacuum).toBe(false);
});

test("factory cleanup --dry-run lists and removes nothing; factory cleanup alone asks the maintainer", async () => {
  const { main, paths } = await import("./cli.ts");
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const repo = mkdtempSync(join(tmpdir(), "api-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) g(repo, ...c);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  g(repo, "add", "."); g(repo, "commit", "-q", "-m", "init");
  const out: string[] = [];
  const cli = (...a: string[]) => main([...a, "--name", "acme"], (l) => out.push(l));
  cli("init", "--repo", "acme/api", "--path", repo);
  cli("cleanup", "--dry-run", "--days", "3");
  expect(out.at(-1)).toContain("# Cleanup (dry run: nothing removed)");
  expect(out.at(-1)).toContain("more than 3 days ago");
  expect(() => cli("cleanup", "--days", "soon")).toThrow(/--days takes a number/);
  cli("cleanup");
  expect(out.at(-1)).toMatch(/^note #1: a cleanup for the maintainer; /);
  const db = open(paths("acme").db);
  expect(db.query("SELECT to_agent, text, request FROM asks").get()).toEqual({ to_agent: "maintainer", text: "Clean up tickets closed or merged more than 14 days ago", request: null });
  expect(db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  cli("cleanup", "--propose");
  expect(out.at(-1)).toContain(`→ ${join(paths("acme").dir, "cleanup", "CLEANUP.md")}`);
  cli("cleanup", "--run");
  expect(out.find((l) => l.startsWith("cleanup: "))).toMatch(/^cleanup: \d+ removed/);
});
