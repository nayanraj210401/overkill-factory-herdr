import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "./runner.ts";
import { checkUpdate, parseCommits, updateRefusal, updateSteps, runUpdate, factoryDbs } from "./update.ts";

// A fake git (and shell), matched by a word or two of the command: `git -C <root> fetch …`
// matches "fetch origin develop". Every call is recorded, so tests can prove nothing
// destructive ran.
function fakeSh(routes: Record<string, string | { code: number; out: string }>) {
  const calls: string[][] = [];
  const run: Run = (argv) => {
    calls.push(argv);
    const line = argv.join(" ");
    for (const [k, v] of Object.entries(routes)) if (line.includes(k)) return typeof v === "string" ? { code: 0, out: v } : v;
    return { code: 1, out: `fake sh: no route for ${line}` };
  };
  return { run, calls };
}
// A checkout 2 behind, clean, that fast-forwards.
const BEHIND = {
  "fetch origin develop": "",
  "status --porcelain": "",
  "rev-list --count HEAD..origin/develop": "2",
  "rev-parse --short HEAD": "abc1234",
  "log --format=%h%x09%s HEAD..origin/develop": "b02\tPlan meters stay fresh\nC03\tSwitching factories keeps your place",
  "merge --ff-only origin/develop": "Updating abc1234..def5678\nFast-forward",
  "sync.sh": "synced",
  "service install": "",
};

test("checkUpdate counts what origin/develop has and parses its commits", () => {
  const { run, calls } = fakeSh(BEHIND);
  const r = checkUpdate({ root: "/repo", run });
  expect(r).toEqual({
    upToDate: false, behind: 2, commit: "abc1234",
    commits: [{ short: "b02", subject: "Plan meters stay fresh" }, { short: "C03", subject: "Switching factories keeps your place" }],
  });
  // The checkout the CLI runs from, never the caller's cwd: -C is always <root>.
  expect(calls.every((a) => a[0] === "git" && a[1] === "-C" && a[2] === "/repo")).toBe(true);
  expect(calls[0]).toEqual(["git", "-C", "/repo", "fetch", "origin", "develop"]);
});

test("checkUpdate is up to date with no log to show, and a failed fetch is the error", () => {
  const up = checkUpdate({ root: "/repo", run: fakeSh({ ...BEHIND, "rev-list --count HEAD..origin/develop": "0" }).run });
  expect(up.upToDate).toBe(true);
  expect(up.behind).toBe(0);
  expect(up.commits).toEqual([]);
  const { run } = fakeSh({ "fetch origin develop": { code: 128, out: "fatal: could not read from remote" } });
  expect(() => checkUpdate({ root: "/repo", run })).toThrow(/could not read from remote/);
});

test("parseCommits keeps short and subject, newest first, cut at 10", () => {
  const lines = Array.from({ length: 13 }, (_, i) => `h${String(i).padStart(2, "0")}\tSubject ${i}`).join("\n");
  const commits = parseCommits(lines);
  expect(commits.length).toBe(10);
  expect(commits[0]).toEqual({ short: "h00", subject: "Subject 0" });
  expect(commits[9]!.subject).toBe("Subject 9");
  expect(parseCommits("")).toEqual([]);
  // A subject with tabs is still one subject: the first tab is the separator.
  expect(parseCommits("h1\tFix a\tb")).toEqual([{ short: "h1", subject: "Fix a\tb" }]);
});

test("a dirty worktree refuses an update before the up-to-date check does", () => {
  const dirty = updateRefusal({ upToDate: false, behind: 2, commit: "abc1234", commits: [] }, true);
  expect(dirty).toMatch(/uncommitted changes/);
  expect(dirty).toMatch(/commit or stash/);
  // Up to date, clean: nothing to do, said plainly.
  expect(updateRefusal({ upToDate: true, behind: 0, commit: "abc1234", commits: [] }, false)).toMatch(/up to date/);
  expect(updateRefusal({ upToDate: false, behind: 2, commit: "abc1234", commits: [] }, false)).toBeNull();
});

test("runUpdate refuses a dirty worktree and an up-to-date checkout before touching anything", () => {
  for (const [routes, why] of [
    [{ ...BEHIND, "status --porcelain": " M daemon/cli.ts\n" }, /uncommitted changes/],
    [{ ...BEHIND, "rev-list --count HEAD..origin/develop": "0" }, /up to date/],
  ] as [Record<string, string>, RegExp][]) {
    const { run, calls } = fakeSh(routes);
    expect(() => runUpdate({ root: "/repo", home: "/no-such-home-xyz", run, backupFile: () => null })).toThrow(why);
    expect(calls.some((a) => a.join(" ").includes("merge"))).toBe(false);
    expect(calls.some((a) => a[0] === "bash")).toBe(false);
  }
});

test("a dry run lists the steps in order and runs none of them", () => {
  const { run, calls } = fakeSh(BEHIND);
  const r = runUpdate({ dryRun: true, root: "/repo", home: "/no-such-home-xyz", run, backupFile: () => null });
  expect(r.dry).toBe(true);
  expect(r.refused).toBeNull();
  expect(r.steps).toEqual([
    "back up every factory database (0)",
    "git merge --ff-only origin/develop into /repo (2 commits)",
    "scripts/sync.sh (HERDR_APP_HOME)",
    expect.stringContaining("service install"),
  ]);
  // Nothing changed: no merge, no sync, no backups — only reads.
  expect(calls.some((a) => a.join(" ").includes("merge"))).toBe(false);
  expect(calls.some((a) => a[0] === "bash")).toBe(false);
});

test("a real run backs up first, then merges, syncs and reinstalls, saying so", () => {
  // Two real factories under a throwaway home: the backups are of real files' paths.
  const home = mkdtempSync(join(tmpdir(), "update-"));
  for (const n of ["one", "two"]) { mkdirSync(join(home, n), { recursive: true }); writeFileSync(join(home, n, "factory.db"), ""); }
  const { run, calls } = fakeSh(BEHIND);
  const backed: string[] = [];
  const r = runUpdate({ root: "/repo", home, run, backupFile: (f) => (backed.push(f), `/bk${f}`) });
  expect(r.dry).toBe(false);
  expect(r.steps.slice(0, 3)).toEqual([
    `backed up ${join(home, "one", "factory.db")} → /bk${join(home, "one", "factory.db")}`,
    `backed up ${join(home, "two", "factory.db")} → /bk${join(home, "two", "factory.db")}`,
    "merged origin/develop into /repo: Updating abc1234..def5678",
  ]);
  expect(r.steps[3]).toContain("HERDR_APP_HOME");
  expect(r.steps[4]).toContain("service");
  // The backups come before anything that could change the world.
  expect(backed).toEqual([join(home, "one", "factory.db"), join(home, "two", "factory.db")]);
  const merge = calls.findIndex((a) => a.includes("merge"));
  expect(merge).toBeGreaterThan(calls.findIndex((a) => a.includes("status")));
  expect(merge).toBeLessThan(calls.findIndex((a) => a[0] === "bash"));
  expect(calls.at(-1)).toEqual([process.execPath, "/repo/daemon/cli.ts", "service", "install"]);
});

test("a failed merge stops the run and says why; a failed sync leaves the service alone", () => {
  const bad = fakeSh({ ...BEHIND, "merge --ff-only origin/develop": { code: 1, out: "fatal: Not possible to fast-forward" } });
  expect(() => runUpdate({ root: "/repo", run: bad.run, backupFile: () => null })).toThrow(/Not possible to fast-forward/);
  expect(bad.calls.some((a) => a[0] === "bash")).toBe(false);
  const badSync = fakeSh({ ...BEHIND, "sync.sh": { code: 1, out: "gen.mjs is stale" } });
  expect(() => runUpdate({ root: "/repo", run: badSync.run, backupFile: () => null })).toThrow(/sync\.sh failed: gen\.mjs is stale/);
  expect(badSync.calls.some((a) => a.join(" ").includes("service install"))).toBe(false);
});

test("factoryDbs lists every factory's database under the home, sorted, and none when there is no home", () => {
  expect(factoryDbs("/no-such-home-xyz")).toEqual([]);
  const home = mkdtempSync(join(tmpdir(), "dbs-"));
  for (const n of ["b", "a"]) { mkdirSync(join(home, n), { recursive: true }); writeFileSync(join(home, n, "factory.db"), ""); }
  mkdirSync(join(home, "empty"));
  expect(factoryDbs(home)).toEqual([join(home, "a", "factory.db"), join(home, "b", "factory.db")]);
});

test("updateSteps says what an update would do, in order, for a check it was given", () => {
  const steps = updateSteps({ upToDate: false, behind: 1, commit: "abc1234", commits: [] }, ["/home/one/factory.db"], "/repo");
  expect(steps[0]).toBe("back up every factory database (1)");
  expect(steps[1]).toContain("merge --ff-only origin/develop");
  expect(steps[2]).toContain("sync.sh");
  expect(steps[3]).toContain("service install");
});
