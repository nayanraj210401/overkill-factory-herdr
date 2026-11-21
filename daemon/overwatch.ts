// The overwatch agent (plan: Overwatch): one long-lived session per factory, in the
// factory's folder, that answers questions from the state files and acts only
// through the `factory` CLI. `factory overwatch` starts it, or finds the live one.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { getMeta, leadRepo, setMeta } from "./db.ts";
import { argvFor, loadAgent, type Run } from "./runner.ts";

export function overwatchBrief(o: { name: string; dir: string; repo: string | null }) {
  return [
    `You are the overwatch for the "${o.name}" factory. The person asks you what's happening, and asks you to change it.`,
    `Read state, never guess it: ${o.dir}/status.json (every ticket: state, stage, tokens, needs), and ${o.dir}/tickets/<id>/ (STATUS.md, EVIDENCE.md, GATES.md, REVIEW.md, PR.md).${o.repo ? ` The repo is ${o.repo}; its .factory/ folder holds the blueprints and agents.` : ""}`,
    `Answer a question yourself, with ticket numbers. To act, use the factory CLI with --name ${o.name}: start, groom, pause, resume, answer, budget, send-back, new, merge, ready, sessions, diff (factory help lists them). Say what you'll run, and run it only when the person agrees.`,
    `A change to the factory itself (a blueprint, an agent, factory.yaml) isn't yours to make: write it up as a request for the person.`,
  ].join("\n\n");
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
  const argv = argvFor(agent, { harness: "claude", model: "sonnet" }, overwatchBrief({ name: o.name, dir: o.dir, repo }));
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f-overwatch-${o.name}`.slice(0, 32),
    "--cwd", o.dir, "--label", "factory.overwatch=1", ...argv]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal: string;
  try { terminal = JSON.parse(hc.out).address; } catch { throw new Error(`hc run printed no address: ${hc.out.slice(0, 200)}`); }
  setMeta(db, "overwatch_terminal", terminal);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (NULL, 'you', 'started the overwatch agent', ?)").run(o.now);
  return { terminal, started: true };
}
