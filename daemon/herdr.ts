// The factory inside Herdr, as its shipped `worktree` mod does it: a ticket's
// checkout goes where New worktree puts one (<worktrees.directory>/<repo>/<branch>),
// and opens as an unnamed space, which Herdr nests under the repo's space. Each
// stage's agent is a tab there. When the app isn't running (the daemon runs from
// launchd), callers fall back to a free-floating `hc run`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Run } from "./runner.ts";

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
  return (o.space && tryDo("tab.new", { space: o.space, name: o.name, argv: o.argv, focus: false }))
    || tryDo("space.new", { folder: o.folder, argv: o.argv, focus: false });
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
