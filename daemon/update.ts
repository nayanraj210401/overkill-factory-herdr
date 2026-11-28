// The factory's own updates (the About popup's Factory row, and `factory update`).
// The daemon runs from a git checkout, so updating it is a fast-forward to origin/develop,
// then resyncing the mods (scripts/sync.sh, so the window runs the same code) and
// reinstalling the service (so the daemon restarts on the new code). Checking is read-only.
// Running refuses everything it can't undo first: an uncommitted worktree is local work a
// merge would tangle with, and every factory's database is backed up (maintainer.ts's
// backup, so `factory restore` puts one back) before anything changes.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sleepSync } from "bun";
import { sh, type Run } from "./runner.ts";
import { appCheckout, factoryHome } from "./globals.ts";
import { backup } from "./maintainer.ts";

// What a check found: `commit` is the checkout the CLI runs from, `commits` the ones it
// would take (newest first, cut at 10 for a popup row).
export type UpdateCheck = { upToDate: boolean; behind: number; commit: string | null; commits: { short: string; subject: string }[] };

// `git log --format=%h%x09%s` lines: "<short>\t<subject>", newest first. The cap keeps
// a popup from listing a week's worth of commits.
export function parseCommits(out: string, cap = 10) {
  return out.trim().split("\n").filter(Boolean).slice(0, cap).map((line) => {
    const at = line.indexOf("\t");
    return { short: line.slice(0, at).trim(), subject: line.slice(at + 1).trim() };
  });
}

// `factory update --check`: fetch, then count what develop has that we don't. The root is
// the checkout the CLI file is in — the daemon's own code — never the caller's cwd.
export function checkUpdate(o: { root?: string; run?: Run }): UpdateCheck {
  const root = o.root ?? appCheckout();
  const run = o.run ?? sh;
  const git = (argv: string[]) => run(["git", "-C", root, ...argv]);
  const fetched = git(["fetch", "origin", "develop"]);
  if (fetched.code !== 0) throw new Error(`couldn't fetch origin/develop: ${fetched.out.trim() || "git failed"}`);
  const count = git(["rev-list", "--count", "HEAD..origin/develop"]);
  const behind = Number.parseInt(count.out.trim(), 10);
  if (!Number.isFinite(behind)) throw new Error(`couldn't count the commits origin/develop has: ${count.out.trim()}`);
  const commit = git(["rev-parse", "--short", "HEAD"]);
  return {
    upToDate: behind === 0,
    behind,
    commit: commit.code === 0 ? commit.out.trim().split("\n")[0] || null : null,
    commits: behind > 0 ? parseCommits(git(["log", "--format=%h%x09%s", "HEAD..origin/develop"]).out) : [],
  };
}

// Every factory's database under FACTORY_HOME (<home>/<name>/factory.db), the files an
// update must be able to undo (migrations run on them the moment the new daemon starts).
export function factoryDbs(home = factoryHome()) {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db"))).sort().map((n) => join(home, n, "factory.db"));
}

// Why an update can't run. Dirty worktree first: with local changes a fast-forward may
// still be refused, or worse, merged halfway, and the update can't undo either.
export function updateRefusal(check: UpdateCheck, dirty: boolean): string | null {
  if (dirty) return "the service worktree has uncommitted changes; commit or stash them first";
  if (check.upToDate) return `already up to date (${check.commit ?? "unknown commit"})`;
  return null;
}

// What an update would do, in order, without doing it: the dry-run's answer, and the log
// the real run walks through.
export function updateSteps(check: UpdateCheck, dbs: string[], root: string) {
  return [
    `back up every factory database (${dbs.length})`,
    `git merge --ff-only origin/develop into ${root} (${check.behind} commit${check.behind === 1 ? "" : "s"})`,
    "scripts/sync.sh (HERDR_APP_HOME)",
    `${process.execPath} ${join(root, "daemon", "cli.ts")} service install`,
  ];
}

// `factory update --run`: the check's guard, then the steps for real. Dry-run reports the
// same steps and runs nothing (not even the backups). `backupFile` and `run` are injected,
// so tests fake the whole thing; the log lines are what a real run says as it goes.
// `service install` is retried: launchd's bootstrap answers error 5 ("Input/output error")
// now and then, and the same command a moment later succeeds — a manual step so far, and
// the one thing that would make a one-click update report a failure that wasn't one.
export function runUpdate(o: {
  dryRun?: boolean; root?: string; home?: string; now?: string; run?: Run; backupFile?: typeof backup; pause?: () => void;
}): { dry: boolean; refused: string | null; steps: string[] } {
  const root = o.root ?? appCheckout();
  const run = o.run ?? sh;
  const check = checkUpdate({ root, run });
  const dirty = run(["git", "-C", root, "status", "--porcelain"]).out.trim().length > 0;
  const refused = updateRefusal(check, dirty);
  if (refused && o.dryRun) return { dry: true, refused, steps: [] };
  if (refused) throw new Error(`not updating: ${refused}`);
  const dbs = factoryDbs(o.home);
  if (o.dryRun) return { dry: true, refused: null, steps: updateSteps(check, dbs, root) };
  const backupFile = o.backupFile ?? backup;
  const now = o.now ?? new Date().toISOString();
  const steps: string[] = [];
  for (const db of dbs) {
    const to = backupFile(db, now, o.home);
    steps.push(to ? `backed up ${db} → ${to}` : `${db}: no file yet, nothing to back up (undo is deleting it)`);
  }
  const merge = run(["git", "-C", root, "merge", "--ff-only", "origin/develop"]);
  if (merge.code !== 0) throw new Error(`the fast-forward to origin/develop failed: ${merge.out.trim()}`);
  steps.push(`merged origin/develop into ${root}${merge.out.trim() ? `: ${merge.out.trim().split("\n")[0]}` : ""}`);
  const sync = run(["bash", join(root, "scripts", "sync.sh")]);
  if (sync.code !== 0) throw new Error(`scripts/sync.sh failed: ${sync.out.trim()}`);
  steps.push(`synced the mods (HERDR_APP_HOME: ${process.env.HERDR_APP_HOME ?? "~/.config/herdr-app"})`);
  const pause = o.pause ?? (() => sleepSync(1500));
  const installArgv = [process.execPath, join(root, "daemon", "cli.ts"), "service", "install"];
  let install = run(installArgv);
  let tries = 1;
  while (install.code !== 0 && tries < 3) {
    tries++;
    pause();
    install = run(installArgv);
  }
  if (install.code !== 0) throw new Error(`service install failed after ${tries} tries: ${install.out.trim()}`);
  steps.push(`reinstalled the factory service${tries > 1 ? ` (launchd took ${tries} tries)` : ""}; the daemon restarts on the new code`);
  return { dry: false, refused: null, steps };
}
