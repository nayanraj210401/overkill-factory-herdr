// The maintainer (plan: Changing the factory) makes every change to the factory itself, and
// it is a live global session like Overwatch (globals.ts). A request, from the person through
// Overwatch or `factory request`, from another agent (`factory ask maintainer`) or from the
// learner, is a note typed into its terminal, or given in its brief when it next starts
// (ask.ts). No ticket, no worktree, no PR, nothing to merge: the factory's configuration is
// local files, and the maintainer edits them in place:
//
//   .factory/ in a repo's main checkout, ~/.factory/config.yaml, ~/.factory/agents/,
//   ~/.factory/examples/agents/
//
// It runs `factory validate` before and after, backs up each file first (`factory backup`,
// below), and says what it changed to whoever asked. Its session's guard refuses a commit,
// push or PR for a factory change (guard.ts); a look change, the factory app's own code, is
// committed on a local branch of the app's checkout only.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadAgent, neighbourMap } from "./agents.ts";
import { loadPrompt, render } from "./prompts.ts";
import { withSkillsLine } from "./skills.ts";
import type { Run } from "./runner.ts";
import { allRepos, appCheckout, factoriesOf, factoryHome, factoryLine, liveSession, startSession, type FactoryInfo } from "./globals.ts";
import { deliveredInBrief, noteText, openAsks, type Ask } from "./ask.ts";
import { closeTicket } from "./lifecycle.ts";

// Requests were tickets on this shipped blueprint once. Old ones still in a database are
// closed (closeRetiredRequests); a repo's copy of it is never groomed (groom.ts).
export const RETIRED_BLUEPRINT = "factory";

export function maintainerBrief(o: { home: string; factories: FactoryInfo[]; prompt?: string | null; neighbours?: string; notes?: Ask[]; name?: string }) {
  return render(loadPrompt(null, "maintainer"), { // a factory agent: no repo's prompts/ apply
    neighbours: o.neighbours ?? neighbourMap(allRepos(o.factories), null),
    "agent.prompt": o.prompt ?? loadAgent(null, "maintainer")?.prompt ?? "",
    home: o.home,
    factories: o.factories.length ? o.factories.map(factoryLine).join("\n") : "- none yet: factory init makes one",
    app: appCheckout(),
    notes: (o.notes ?? []).map((a) => `- ${noteText(a, o.name)}`).join("\n"),
  });
}

export const liveMaintainer = (run: Run, home = factoryHome()) => liveSession(run, "maintainer", home);

// `factory maintainer`, and every request when it isn't live: finds it, or starts it with this
// factory's waiting requests in its brief (other factories' are typed in by their daemons).
export function maintainer(o: { db: Database; run: Run; now: string; name?: string; home?: string; factories?: FactoryInfo[] }) {
  const home = o.home ?? factoryHome();
  const known = liveMaintainer(o.run, home);
  if (known) return { terminal: known, started: false };
  const factories = o.factories ?? factoriesOf(home);
  const agent = loadAgent(null, "maintainer");
  const notes = openAsks(o.db, "maintainer").filter((a) => !a.delivered_at);
  const r = startSession({ run: o.run, now: o.now, agent: "maintainer", home, factories,
    brief: maintainerBrief({ home, factories, prompt: withSkillsLine(agent?.prompt, agent), notes, name: o.name }) });
  deliveredInBrief(o.db, notes, o.now);
  return r;
}

// ---- backups -----------------------------------------------------------------------------
// One place for every backup: <FACTORY_HOME>/backups/<when>/<the file's absolute path>, so a
// repo's .factory/ never holds a stray copy, and a change is undone by copying it back
// (`factory restore <backup>`). Cleanup removes old ones, never a file's newest.
export const backupsDir = (home = factoryHome()) => join(home, "backups");
// To the millisecond, so a restore right after a backup never writes over it.
const stamp = (now: string) => new Date(now).toISOString().replace(/[^0-9]/g, "").slice(0, 17);

// The backup's path; null when there is no file yet (undoing it is deleting the new one).
export function backup(file: string, now: string, home = factoryHome()): string | null {
  const abs = resolve(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const to = join(backupsDir(home), stamp(now), abs.slice(1));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(abs, to);
  return to;
}

// The file a backup is of.
export function backedUp(path: string, home = factoryHome()) {
  const rel = relative(backupsDir(home), resolve(path));
  const parts = rel.split(sep);
  if (rel.startsWith("..") || parts.length < 2 || !/^\d{17}$/.test(parts[0])) throw new Error(`${path} isn't a backup in ${backupsDir(home)}`);
  return sep + parts.slice(1).join(sep);
}

// Puts a backup back, backing up what is there now first.
export function restore(path: string, now: string, home = factoryHome()) {
  const file = backedUp(path, home);
  if (!existsSync(path)) throw new Error(`no backup ${path}`);
  const was = resolve(path) === join(backupsDir(home), stamp(now), file.slice(1)) ? null : backup(file, now, home);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(path, file);
  return { file, was };
}

// Every backup, grouped by the file it is of, newest first.
export function backupsByFile(home = factoryHome()) {
  const groups = new Map<string, { path: string; at: string }[]>();
  const root = backupsDir(home);
  if (!existsSync(root)) return groups;
  for (const at of readdirSync(root).filter((d) => /^\d{17}$/.test(d)).sort().reverse()) {
    const walk = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else { const file = backedUp(p, home); groups.set(file, [...(groups.get(file) ?? []), { path: p, at }]); }
      }
    };
    walk(join(root, at));
  }
  return groups;
}

// ---- requests from before ------------------------------------------------------------------
// A request that was a ticket on the retired blueprint is closed, once, with a note: its agent
// stops and its worktree goes (one with uncommitted work stays); its notes and decisions stay.
// A PR it opened stays open for the person to close.
export function closeRetiredRequests(db: Database, o: { run: Run; now: string }) {
  const open = db.query("SELECT id FROM tickets WHERE blueprint = ? AND state NOT IN ('merged', 'closed') ORDER BY id").all(RETIRED_BLUEPRINT) as { id: number }[];
  for (const t of open) closeTicket(db, { id: t.id, run: o.run, now: o.now, who: "daemon", what: "closed the maintainer request",
    why: "requests no longer run as tickets: the maintainer edits the factory's files in place. Ask it again (factory request) if this is still wanted; a PR this ticket opened stays for you to close" });
  return open.map((t) => t.id);
}
