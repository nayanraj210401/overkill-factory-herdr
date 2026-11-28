// .factory/ stays local (plan: .factory/ stays local). The factory's files in a repo are yours,
// on this machine: never pushed, never in a PR. Adopting a repo puts /.factory/ in its
// .git/info/exclude (the common git dir, so every worktree shares it); the factory never
// writes or commits a .gitignore there. A repo that already tracks .factory/ keeps it: the
// factory says how to stop (UNTRACK) and marks those files skip-worktree in the checkout, so
// a local edit is never staged; a ticket branch that changes .factory/ never reaches a PR.
// TICKET-MEMORY.md, the ticket's digest the factory writes into each worktree (digest.ts), is
// kept out the same way: its own exclude line, and the same PR guard.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sh, type Run } from "./runner.ts";

export const EXCLUDE_LINE = "/.factory/";
export const MEMORY_FILE = "TICKET-MEMORY.md";
const LINES: [string, string[]][] = [[EXCLUDE_LINE, ["/.factory/", "/.factory", ".factory/", ".factory"]], [`/${MEMORY_FILE}`, [`/${MEMORY_FILE}`, MEMORY_FILE]]];
export const UNTRACK = 'git rm -r --cached .factory && git commit -m "Stop tracking .factory/"';
export const LOCAL_REASON = `this ticket changed the factory's local files (.factory/, ${MEMORY_FILE}), which stay local`;

// True when `repo` is a checkout's top folder. A folder inside another repo (a fixture, a
// subfolder) is not: git resolves `.factory` against it, so skip-worktree and the exclude line
// would land in the enclosing repo and hide its tracked files from git.
export function isCheckout(repo: string, run: Run = sh) {
  const r = run(["git", "-C", repo, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0 || !r.out.trim()) return false;
  try { return realpathSync(r.out.trim()) === realpathSync(repo); } catch { return false; }
}

// The exclude file every worktree of `repo` reads; null when `repo` isn't a checkout's top folder.
export function excludeFile(repo: string, run: Run = sh) {
  if (!isCheckout(repo, run)) return null;
  const r = run(["git", "-C", repo, "rev-parse", "--git-common-dir"]);
  return r.code === 0 && r.out.trim() ? join(resolve(repo, r.out.trim()), "info", "exclude") : null;
}

// Adds /.factory/ and /TICKET-MEMORY.md, each once. True when it wrote a line.
export function excludeFactory(repo: string, run: Run = sh) {
  const file = excludeFile(repo, run);
  if (!file) return false;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const has = text.split("\n").map((l) => l.trim());
  const missing = LINES.filter(([, forms]) => !forms.some((f) => has.includes(f))).map(([line]) => line);
  if (!missing.length) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# the factory's files stay on this machine (overkill factory)\n${missing.join("\n")}\n`);
  return true;
}

// Before the factory writes TICKET-MEMORY.md into a worktree of `repo`: its exclude line is there
// (added now if not). False when `repo` isn't a checkout's top folder, so nothing would keep it out.
export function excludeLocal(repo: string, run: Run = sh) {
  if (!excludeFile(repo, run)) return false;
  excludeFactory(repo, run);
  return true;
}

// The .factory/ files git tracks in `repo`; [] when none, or no checkout.
export function trackedFactory(repo: string, run: Run = sh) {
  const r = run(["git", "-C", repo, "ls-files", "--", ".factory"]);
  return r.code === 0 ? r.out.split("\n").map((f) => f.trim()).filter(Boolean) : [];
}

// What adopting a repo does, and what the daemon does for each repo when it starts. Idempotent.
// Tracked files get skip-worktree in this checkout only: `git status` and `git add -A` there
// pass over your local edits; `git update-index --no-skip-worktree <file>` undoes it.
export function keepLocal(repo: string, run: Run = sh) {
  if (!isCheckout(repo, run)) return { excluded: false, tracked: [] as string[] };
  const excluded = excludeFactory(repo, run);
  const tracked = trackedFactory(repo, run);
  if (tracked.length) run(["git", "-C", repo, "update-index", "--skip-worktree", "--", ...tracked]);
  return { excluded, tracked };
}

// The warning `factory validate` and Home show for a repo that tracks .factory/.
export const trackedWarning = (slug: string, n: number) =>
  `${slug} tracks .factory/ in git (${n} file${n === 1 ? "" : "s"}), so it can reach a PR; it should stay local. Run this yourself in the checkout: ${UNTRACK}`;

// Files under .factory/, and TICKET-MEMORY.md, the ticket's branch committed since it left `from`
// (the repo's checkout HEAD when not given): what a push would send.
export function factoryChanges(run: Run, repo: string, worktree: string, from?: string) {
  const head = from ?? run(["git", "-C", repo, "rev-parse", "HEAD"]).out.trim();
  const fork = run(["git", "-C", worktree, "merge-base", "HEAD", head]);
  if (fork.code !== 0) return [];
  return run(["git", "-C", worktree, "diff", "--name-only", fork.out.trim(), "HEAD", "--", ".factory", MEMORY_FILE]).out.split("\n").map((f) => f.trim()).filter(Boolean);
}
