// The factory inside Herdr, as its shipped `worktree` mod does it: a ticket's
// checkout goes where New worktree puts one (<worktrees.directory>/<repo>/<branch>),
// and opens as an unnamed space, which Herdr nests under the repo's space. Each
// stage's agent is a tab there. When the app isn't running (the daemon runs from
// launchd), callers fall back to a free-floating `hc run`.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Run } from "./runner.ts";

// `bun test` started outside the repo root skips bunfig.toml's preload, and its tests
// would open spaces, agents and worktrees in the person's own Herdr. Refuse instead.
if (process.env.NODE_ENV === "test" && !process.env.FACTORY_TEST_SANDBOX)
  throw new Error("bun test ran without daemon/test-env.ts (bunfig.toml's preload); run it from the repo root");

// An agent reports through the factory CLI (factory pick, stage-done, verdict…), so it
// needs \`factory\` on its PATH and to know which factory it works for: its cwd (a ticket
// folder or a worktree) doesn't name one. \`dir\` is the factory's data folder,
// <FACTORY_HOME>/<name>; the command is a small script in <FACTORY_HOME>/bin that runs
// this checkout's CLI with bun.
// The PATH agents and checks run with: bun's own folder and Homebrew's first, so a
// daemon started by launchd (whose PATH is /usr/bin:/bin) still finds the repo's tools.
export const toolPath = () => [...new Set([dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "/usr/bin:/bin").split(":")])].join(":");

export function withFactory(argv: string[], dir: string) {
  const home = dirname(dir);
  const bin = join(home, "bin");
  const script = `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "cli.ts")}' "$@"\n`;
  const file = join(bin, "factory");
  if (!existsSync(file) || readFileSync(file, "utf8") !== script) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return ["env", `FACTORY_HOME=${home}`, `FACTORY_NAME=${basename(dir)}`, `PATH=${bin}:${toolPath()}`, ...argv];
}

const appHome = () => process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app");

// The worktree mod's slug: anything but letters, digits, . _ - becomes a dash.
export const branchSlug = (branch: string) =>
  branch.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "worktree";

export function worktreeRoot() {
  if (process.env.FACTORY_WORKTREES) return process.env.FACTORY_WORKTREES;
  let dir: string | undefined;
  try { dir = JSON.parse(readFileSync(join(appHome(), "settings.json"), "utf8")).worktrees?.directory; } catch {}
  if (!dir) return join(homedir(), ".herdr/worktrees");
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

export const worktreePath = (repo: string, branch: string) => join(worktreeRoot(), basename(repo), branchSlug(branch));

type Made = { space: string; tab: string; terminal: string };

// A new space for the ticket's worktree, or a tab in the one it has. null: Herdr
// isn't running (or refused), so the caller runs the agent outside it.
export function openAgent(run: Run, o: { folder: string; space: string | null; name: string; argv: string[] }): Made | null {
  if (!existsSync(join(appHome(), "herdr-app.sock"))) return null;
  const tryDo = (cmd: string, args: object) => {
    const r = run(["herdr-app", "do", cmd, JSON.stringify(args)]);
    try { const m = JSON.parse(r.out); return r.code === 0 && m.terminal ? (m as Made) : null; } catch { return null; }
  };
  // A space the person closed is gone; the ticket then gets a new one.
  // The tab opens in this agent's folder: a ticket's space starts in its ticket folder (grooming).
  return (o.space && tryDo("tab.new", { space: o.space, folder: o.folder, name: o.name, argv: o.argv, focus: false }))
    || tryDo("space.new", { folder: o.folder, argv: o.argv, focus: false });
}

// A shell tab in the ticket's space, in another repo's worktree (cross-repo tickets).
export function openTab(run: Run, o: { space: string; folder: string; name: string }) {
  if (existsSync(join(appHome(), "herdr-app.sock"))) run(["herdr-app", "do", "tab.new", JSON.stringify({ space: o.space, folder: o.folder, name: o.name, focus: false })]);
}

// A terminal is done when its program exited, or, for an agent run in a tab's shell
// (which stays open), when the agent was seen in front and the shell is back.
export function sessionState(info: { exit_code?: number | null; pid?: number; foreground?: { pid: number } | null }) {
  if (info.exit_code != null) return "exited";
  if (!info.foreground || info.foreground.pid === info.pid) return "shell";
  return "agent";
}

export function closeSpace(run: Run, space: string | null) {
  if (space && existsSync(join(appHome(), "herdr-app.sock"))) run(["herdr-app", "do", "space.close", JSON.stringify({ id: space, confirmed: true })]);
}
