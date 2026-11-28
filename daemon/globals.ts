// The global agents' live sessions (plan: The agents). Overwatch and the maintainer each run
// as one long-lived Claude Code session for every factory on this machine, in FACTORY_HOME,
// acting through the `factory` CLI (with --name per factory). Which terminal each is in
// lives in <FACTORY_HOME>/<agent>.json, so every factory finds the same one.
//
// A global agent's session never commits, pushes or opens a PR for a factory change: the
// factory's configuration is local files, edited in place. The guard hook holds it to that
// (guard.ts, `local`), whatever its prompt says.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listRepos, open, type Repo } from "./db.ts";
import { argvFor, type Run } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { withAccount } from "./herdr.ts";
import { giveAccess } from "./skills.ts";
import { DEFAULT_MODEL } from "./models.ts";
import { guardSettings } from "./guard.ts";
import { planStatusLine } from "./planline.ts";

export const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");

export const SESSIONS = ["overwatch", "maintainer"] as const;
export type Session = (typeof SESSIONS)[number];
export const stateFile = (home = factoryHome(), agent: Session = "overwatch") => join(home, `${agent}.json`);

export type FactoryInfo = { name: string; dir: string; repos: Repo[] };

// Every factory under the home, with its repos (lead first).
export function factoriesOf(home = factoryHome()): FactoryInfo[] {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db"))).sort().map((name) => {
    const db = open(join(home, name, "factory.db"));
    try { return { name, dir: join(home, name), repos: listRepos(db) }; } finally { db.close(); }
  });
}

export const factoryLine = (f: FactoryInfo) =>
  `- ${f.name}: ${f.repos.length ? f.repos.map((r) => `${r.slug} (${r.path}${r.lead ? ", lead" : ""})`).join(", ") : "no repo yet"}; data ${f.dir}`;

// The repos every factory has, once each: a global agent may ask (and read) any of them.
export const allRepos = (fs: FactoryInfo[]) => [...new Map(fs.flatMap((f) => f.repos).map((r) => [r.slug, r])).values()];

// The factory app's own checkout (its mods, themes, lib, layouts): the one repo a look change
// is committed in, on a local branch. FACTORY_APP_REPO points elsewhere (tests).
export const appCheckout = () => process.env.FACTORY_APP_REPO ?? resolve(import.meta.dir, "..");

// A terminal Herdr stopped (state "finished", e.g. stopped_by_restart) keeps a null exit_code,
// so the exit code alone would call it alive, and the page would focus a dead terminal.
const alive = (run: Run, terminal: string) => {
  const r = run(["hc", "get", terminal, "--json"]);
  try { const t = JSON.parse(r.out); return r.code === 0 && t.exit_code == null && t.state !== "finished"; } catch { return false; }
};

export const readState = (home: string, agent: Session = "overwatch"): { terminal?: string; started_at?: string } => {
  try { return JSON.parse(readFileSync(stateFile(home, agent), "utf8")); } catch { return {}; }
};

// The live session's terminal, or null: notes for it are typed there (ask.ts).
export function liveSession(run: Run, agent: Session, home = factoryHome()) {
  const known = readState(home, agent).terminal;
  return known && alive(run, known) ? known : null;
}

// Finds the live session, or starts one with `brief`.
export function startSession(o: { run: Run; now: string; agent: Session; brief: string; home: string; factories: FactoryInfo[] }) {
  const known = liveSession(o.run, o.agent, o.home);
  if (known) return { terminal: known, started: false };
  const agent = loadAgent(null, o.agent);
  // A factory agent's skills come from ~/.factory/skills/ only; its plugin sits in the factory home (skills.ts).
  const argv = giveAccess(argvFor(agent, { harness: "claude", model: DEFAULT_MODEL }, o.brief), agent, join(o.home, ".skills", o.agent), []);
  // --add-dir: it reads (and the maintainer edits) every repo's .factory/; Claude Code asks
  // before leaving its working directories.
  const dirs = [...new Set(o.factories.flatMap((f) => f.repos.map((r) => r.path)))];
  if (argv[0] === "claude") {
    // Auto mode, like every factory agent: it never stops at a permission prompt.
    // skipAutoPermissionPrompt: registering the repos was the consent to auto mode (handoff-hook.ts).
    // The guard hook joins it in the one settings file Claude Code takes.
    const guard = JSON.parse(guardSettings({ stops: [], roots: [o.home, ...dirs], log: join(o.home, `${o.agent}.hard-stops.jsonl`), local: { app: appCheckout() } })!);
    argv.splice(1, 0, "--permission-mode", "auto", "--settings", JSON.stringify({ skipAutoPermissionPrompt: true, statusLine: planStatusLine(), ...guard }), ...dirs.flatMap((d) => ["--add-dir", d]));
  }
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f-${o.agent}`,
    "--cwd", o.home, "--label", `factory.${o.agent}=1`, ...withAccount(argv, o.home, o.agent)]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal: string;
  try { terminal = JSON.parse(hc.out).address; } catch { throw new Error(`hc run printed no address: ${hc.out.slice(0, 200)}`); }
  mkdirSync(o.home, { recursive: true });
  const tmp = `${stateFile(o.home, o.agent)}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ terminal, started_at: o.now }) + "\n");
  renameSync(tmp, stateFile(o.home, o.agent)); // whole or not at all: every factory's window reads it
  return { terminal, started: true };
}
