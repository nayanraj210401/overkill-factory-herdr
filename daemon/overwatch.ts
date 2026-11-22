// The overwatch agent (plan: Overwatch): one long-lived session per factory, in the
// factory's folder, that answers questions from the state files and acts only
// through the `factory` CLI. `factory overwatch` starts it, or finds the live one.
import { DEFAULT_MODEL } from "./models.ts";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { getMeta, leadRepo, setMeta } from "./db.ts";
import { argvFor, loadAgent, type Run } from "./runner.ts";
import { withFactory } from "./herdr.ts";
import { loadPrompt, render } from "./prompts.ts";

export function overwatchBrief(o: { name: string; dir: string; repo: string | null }) {
  return render(loadPrompt(o.repo, "overwatch"), {
    name: o.name,
    dir: o.dir,
    repo: o.repo,
    repo_line: o.repo ? `The repo is ${o.repo}; its .factory/ folder holds the blueprints and agents.` : "",
  });
}

const alive = (run: Run, terminal: string) => {
  const r = run(["hc", "get", terminal, "--json"]);
  try { return r.code === 0 && JSON.parse(r.out).exit_code == null; } catch { return false; }
};

export function overwatch(db: Database, o: { name: string; dir: string; run: Run; now: string }) {
  const known = getMeta(db, "overwatch_terminal");
  if (known && alive(o.run, known)) return { terminal: known, started: false };
  const repo = leadRepo(db)?.path ?? null;
  const agent = repo ? loadAgent(repo, "overwatch") : null;
  const argv = argvFor(agent, { harness: "claude", model: DEFAULT_MODEL }, overwatchBrief({ name: o.name, dir: o.dir, repo }));
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f-overwatch-${o.name}`.slice(0, 32),
    "--cwd", o.dir, "--label", "factory.overwatch=1", ...withFactory(argv, o.dir)]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal: string;
  try { terminal = JSON.parse(hc.out).address; } catch { throw new Error(`hc run printed no address: ${hc.out.slice(0, 200)}`); }
  setMeta(db, "overwatch_terminal", terminal);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (NULL, 'you', 'started the overwatch agent', ?)").run(o.now);
  return { terminal, started: true };
}
