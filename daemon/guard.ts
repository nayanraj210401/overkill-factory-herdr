// Hard stops, enforced (plan: Autonomy). A worker's Claude Code session gets a PreToolUse
// hook, `bun daemon/guard.ts`, through --settings. The hook blocks the action, tells the
// agent why, and notes it in the ticket's hard-stops.jsonl; the daemon parks the ticket.
// The checks are pattern rules on the tool's input, so they catch the usual ways to do
// each thing, not every way. Codex sessions get no hook, so they aren't covered.
// A global agent's live session (Overwatch, the maintainer: globals.ts) always gets the hook,
// with the factory-local stop: no commit, push or PR for a factory change (localHit).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

export const STOPS = ["push-to-main", "outside-worktree", "destructive-commands", "secrets-in-output"] as const;
// Not one factory.yaml lists: every global agent's session has it (localHit).
export type Hit = { stop: (typeof STOPS)[number] | "factory-local"; reason: string };
// `local`: a global agent's session (Overwatch, the maintainer). Factory changes are local
// files, so it never pushes, opens or edits a PR, or commits; `app` is the factory app's own
// checkout, where a look change may be committed on a local branch (and still never pushed).
export type Guard = { stops: string[]; roots: string[]; cwd: string; local?: { app: string | null } };

const SECRETS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/sk-(ant-)?[A-Za-z0-9_-]{24,}/, "an API key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/AIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

// Words of one simple command; quotes group, and the quote marks are dropped.
const words = (cmd: string) => (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
const segments = (cmd: string) => cmd.split(/&&|\|\||[;|\n]/).map((s) => words(s.trim())).filter((w) => w.length);
const isPath = (w: string) => /^(\/|~)/.test(w) || /(^|\/)\.\.(\/|$)/.test(w);

// git's subcommand and the folder it works in: `git -C dir commit` commits in dir.
function gitCall(args: string[], cwd: string) {
  let dir = cwd;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C") { dir = resolve(dir, (args[++i] ?? "").replace(/^~(?=\/|$)/, homedir())); continue; }
    if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i++; continue; }
    if (a.startsWith("-")) continue;
    return { sub: a, dir };
  }
  return { sub: undefined, dir };
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const within = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/$/, "") + "/");

// gh pr commands that only read.
const GH_PR_READS = new Set(["view", "list", "status", "diff", "checks"]);

function localHit(w: string[], g: Guard): Hit | null {
  const [prog, ...args] = w[0] === "sudo" || w[0] === "env" || w[0] === "command" ? w.slice(1) : w;
  const app = g.local!.app;
  if (prog === "git") {
    const { sub, dir } = gitCall(args, g.cwd);
    if (sub === "push") return stop("factory-local", "a global agent never pushes: factory changes are local files, edited in place");
    if (sub === "commit" && !(app && (within(dir, app) || within(real(dir), real(app)))))
      return stop("factory-local", "a global agent never commits into a repo: factory changes are local files, edited in place (a look change is committed only in the factory app's own checkout)");
  }
  if (prog === "gh" && args[0] === "pr" && args[1] && !GH_PR_READS.has(args[1])) return stop("factory-local", `a global agent never runs gh pr ${args[1]}: factory changes are local, with nothing to review or merge`);
  return null;
}

const abs = (path: string, g: Guard) => resolve(g.cwd, path.replace(/^~(?=\/|$)/, homedir()));
export function inside(path: string, g: Guard) {
  const p = abs(path, g);
  return [...g.roots, tmpdir(), "/tmp", "/private/tmp", "/dev/null"].some((r) => p === r || p.startsWith(r.replace(/\/$/, "") + "/"));
}

const WRITES = new Set(["cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "tee", "install", "chmod", "chown", "truncate", "dd", "rsync", "shred", "patch"]);
const stop = (stop: Hit["stop"], reason: string): Hit => ({ stop, reason });

function bashHit(cmd: string, g: Guard): Hit | null {
  const on = (s: string) => g.stops.includes(s);
  for (const w of segments(cmd)) {
    const local = g.local ? localHit(w, g) : null;
    if (local) return local;
    const sudo = w[0] === "sudo";
    const [prog, ...args] = sudo || w[0] === "env" || w[0] === "command" ? w.slice(1) : w;
    if (!prog) continue;
    const pos = args.filter((a) => !a.startsWith("-")); // `git -C dir push` is rare; the first word after git's flags is the subcommand
    const sub = prog === "git" ? pos[0] : undefined;
    if (on("push-to-main")) {
      if (sub === "push") return stop("push-to-main", "agents don't push; the daemon opens the PR");
      if (prog === "gh" && pos[0] === "pr" && pos[1] === "merge") return stop("push-to-main", "agents don't merge PRs; you do");
    }
    if (on("destructive-commands")) {
      if (sudo) return stop("destructive-commands", "sudo");
      const recursive = args.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive");
      if ((prog === "rm" && recursive) || prog === "rmdir" || prog === "shred")
        for (const a of pos)
          if (!inside(a, g) || g.roots.includes(abs(a, g)) || /(^|\/)\.git\/?$/.test(a) || a === "*" || a === "/") return stop("destructive-commands", `${prog} -r on ${a}`);
      if (sub === "reset" && args.includes("--hard")) return stop("destructive-commands", "git reset --hard");
      if (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) return stop("destructive-commands", "git clean -f");
      if (sub === "branch" && args.some((a) => a === "-D" || a === "--force")) return stop("destructive-commands", "git branch -D");
      if ((sub === "checkout" || sub === "restore") && pos.includes(".")) return stop("destructive-commands", `git ${sub} . throws away changes`);
      if (sub === "stash" && ["drop", "clear"].includes(pos[1])) return stop("destructive-commands", `git stash ${pos[1]}`);
      if (["mkfs", "fdisk", "diskutil"].includes(prog) || (prog === "dd" && args.some((a) => a.startsWith("of=/dev/")))) return stop("destructive-commands", prog);
    }
    if (on("outside-worktree")) {
      const targets = WRITES.has(prog) ? args.map((x) => x.replace(/^(of|--target-directory)=/, "")) : prog === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) ? args : [];
      for (const a of targets.filter((x) => !x.startsWith("-") && isPath(x)))
        if (!inside(a, g)) return stop("outside-worktree", `${prog} writes ${a}, outside the ticket's worktree`);
    }
  }
  if (on("outside-worktree"))
    for (const m of cmd.matchAll(/(?:^|[^<>&\d])\d?>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&)]+)/g)) {
      const t = m[1].replace(/^(["'])(.*)\1$/, "$2");
      if (!inside(t, g)) return stop("outside-worktree", `redirects into ${t}, outside the ticket's worktree`);
    }
  return null;
}

// What the hook is given: the tool's name and input. Returns why it must stop, or null.
export function guardHit(tool: string, input: Record<string, any>, g: Guard): Hit | null {
  const path = input.file_path ?? input.notebook_path;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) && g.stops.includes("outside-worktree") && typeof path === "string" && !inside(path, g))
    return stop("outside-worktree", `${tool} on ${path}, outside the ticket's worktree`);
  if (g.stops.includes("secrets-in-output")) {
    const text = [input.command, input.content, input.new_string, input.new_source, ...(input.edits ?? []).map((e: any) => e.new_string)].filter((x) => typeof x === "string").join("\n");
    for (const [re, what] of SECRETS) if (re.test(text)) return stop("secrets-in-output", `it holds ${what}`);
  }
  if (tool === "Bash" && typeof input.command === "string") return bashHit(input.command, g);
  return null;
}

// The settings JSON a worker's `claude` takes with --settings. No listed stops, no hook.
// `local`: a global agent's session, which always gets the hook (see Guard).
export function guardSettings(o: { stops: string[]; roots: string[]; log: string; script?: string; bun?: string; local?: { app: string | null } }) {
  const stops = o.stops.filter((s) => (STOPS as readonly string[]).includes(s));
  if (!stops.length && !o.local) return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = [q(o.bun ?? process.execPath), q(o.script ?? import.meta.path), "--stops", q(stops.join(",")), "--roots", q(o.roots.join(":")), "--log", q(o.log),
    ...(o.local ? ["--local", q(o.local.app ?? "")] : [])].join(" ");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command }] }] } });
}

export const hardStopLog = (dir: string, id: number) => join(dir, "tickets", String(id), "hard-stops.jsonl");
export const hasHardStop = (log: string) => existsSync(log);

// The first hard stop the guard noted, as a sentence; reading it clears the note.
export function takeHardStop(log: string): string | null {
  if (!existsSync(log)) return null;
  const first = readFileSync(log, "utf8").split("\n").find(Boolean);
  unlinkSync(log);
  try { const h = JSON.parse(first ?? "") as Hit; return `${h.stop}: ${h.reason}`; } catch { return "a hard stop (the note was unreadable)"; }
}

// The hook itself: stdin is Claude Code's event; exit 2 blocks the call and shows stderr to the agent.
if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? "" : process.argv[i + 1] ?? ""; };
  const event = JSON.parse(await Bun.stdin.text());
  const local = process.argv.includes("--local") ? { app: arg("local") || null } : undefined;
  const g: Guard = { stops: arg("stops").split(",").filter(Boolean), roots: arg("roots").split(":").filter(Boolean), cwd: event.cwd ?? process.cwd(), local };
  const hit = guardHit(event.tool_name, event.tool_input ?? {}, g);
  if (hit) {
    mkdirSync(dirname(arg("log")), { recursive: true });
    appendFileSync(arg("log"), JSON.stringify({ ...hit, tool: event.tool_name, at: new Date().toISOString() }) + "\n");
    console.error(local
      ? `Hard stop (${hit.stop}): ${hit.reason}. Don't try another way around it; tell whoever asked which hard stop this was.`
      : `Hard stop (${hit.stop}): ${hit.reason}. This ticket is parked for a person to look at; stop work and don't try another way around it.`);
    process.exit(2);
  }
}
