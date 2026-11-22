// The overwatch agent (plan: Overwatch): one long-lived session for every factory on this
// machine, in FACTORY_HOME, that answers questions from the state files and acts only
// through the `factory` CLI (with --name per factory). `factory overwatch`, from any
// factory, starts it or finds the live one; which terminal it is lives in
// <FACTORY_HOME>/overwatch.json, so every factory's Overwatch page shows the same one.
import { DEFAULT_MODEL } from "./models.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listRepos, open, type Repo } from "./db.ts";
import { argvFor, type Run } from "./runner.ts";
import { loadAgent, neighbourMap } from "./agents.ts";
import { withAccount } from "./herdr.ts";
import { loadPrompt, render } from "./prompts.ts";

export const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");
export const stateFile = (home = factoryHome()) => join(home, "overwatch.json");

export type FactoryInfo = { name: string; dir: string; repos: Repo[] };

// Every factory under the home, with its repos (lead first).
export function factoriesOf(home = factoryHome()): FactoryInfo[] {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db"))).sort().map((name) => {
    const db = open(join(home, name, "factory.db"));
    try { return { name, dir: join(home, name), repos: listRepos(db) }; } finally { db.close(); }
  });
}

const factoryLine = (f: FactoryInfo) =>
  `- ${f.name}: ${f.repos.length ? f.repos.map((r) => `${r.slug} (${r.path}${r.lead ? ", lead" : ""})`).join(", ") : "no repo yet"}; data ${f.dir}`;

// The repos whose agents the map lists: each factory's lead, once.
const leads = (fs: FactoryInfo[]) => [...new Map(fs.flatMap((f) => f.repos.filter((r) => r.lead)).map((r) => [r.slug, r])).values()];

export function overwatchBrief(o: { home: string; factories: FactoryInfo[]; prompt?: string | null; neighbours?: string }) {
  return render(loadPrompt(null, "overwatch"), { // a factory agent: no repo's prompts/ apply
    neighbours: o.neighbours ?? neighbourMap(leads(o.factories)),
    "agent.prompt": o.prompt ?? loadAgent(null, "overwatch")?.prompt ?? "",
    home: o.home,
    factories: o.factories.length ? o.factories.map(factoryLine).join("\n") : "- none yet: factory init makes one",
  });
}

const alive = (run: Run, terminal: string) => {
  const r = run(["hc", "get", terminal, "--json"]);
  try { return r.code === 0 && JSON.parse(r.out).exit_code == null; } catch { return false; }
};

const readState = (home: string): { terminal?: string; started_at?: string } => {
  try { return JSON.parse(readFileSync(stateFile(home), "utf8")); } catch { return {}; }
};

// The live Overwatch's terminal, or null: notes for it are typed there (ask.ts).
export function liveOverwatch(run: Run, home = factoryHome()) {
  const known = readState(home).terminal;
  return known && alive(run, known) ? known : null;
}

export function overwatch(o: { run: Run; now: string; home?: string; factories?: FactoryInfo[] }) {
  const home = o.home ?? factoryHome();
  const known = liveOverwatch(o.run, home);
  if (known) return { terminal: known, started: false };
  const factories = o.factories ?? factoriesOf(home);
  const agent = loadAgent(null, "overwatch");
  const argv = argvFor(agent, { harness: "claude", model: DEFAULT_MODEL }, overwatchBrief({ home, factories, prompt: agent?.prompt }));
  // Auto mode, like every factory agent: it still asks before acting (its brief), never at a permission prompt.
  // skipAutoPermissionPrompt: registering the repos was the consent to auto mode (handoff-hook.ts).
  // --add-dir: it reads every repo's .factory/ too (the data folders are under its cwd), and
  // Claude Code asks before leaving its working directories.
  const dirs = [...new Set(factories.flatMap((f) => f.repos.map((r) => r.path)))];
  if (argv[0] === "claude") argv.splice(1, 0, "--permission-mode", "auto", "--settings", JSON.stringify({ skipAutoPermissionPrompt: true }), ...dirs.flatMap((d) => ["--add-dir", d]));
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", "f-overwatch",
    "--cwd", home, "--label", "factory.overwatch=1", ...withAccount(argv, home, "overwatch")]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal: string;
  try { terminal = JSON.parse(hc.out).address; } catch { throw new Error(`hc run printed no address: ${hc.out.slice(0, 200)}`); }
  mkdirSync(home, { recursive: true });
  const tmp = `${stateFile(home)}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ terminal, started_at: o.now }) + "\n");
  renameSync(tmp, stateFile(home)); // whole or not at all: every factory's window reads it
  return { terminal, started: true };
}
