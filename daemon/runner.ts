// The graph runner's first half: a ticket gets its own worktree, enters its
// blueprint's first stage, and that stage's agent starts in a herdr-core terminal.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateFile } from "./validate.ts";
import { enterStage } from "./ticket.ts";

export type Run = (argv: string[], cwd?: string) => { code: number; out: string };
export const sh: Run = (argv, cwd) => {
  const r = Bun.spawnSync(argv, { cwd });
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

type Stage = { agent?: string; check?: string; next?: string[]; output?: string };
type Blueprint = { name: string; start: string; stages: Record<string, Stage> };

function readYaml(repo: string, path: string) {
  const file = join(repo, ".factory", path);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const errors = validateFile(path, text);
  if (errors.length) throw new Error(`.factory/${path}: ${errors[0]}`);
  return text;
}

export function loadBlueprint(repo: string, name: string): Blueprint {
  const text = readYaml(repo, `blueprints/${name}.yaml`) ?? (name === "default" ? readYaml(repo, "blueprint.yaml") : null);
  if (!text) throw new Error(`no blueprint "${name}" in ${repo}/.factory/blueprints/`);
  return Bun.YAML.parse(text) as Blueprint;
}

export function loadAgent(repo: string, name: string) {
  const text = readYaml(repo, `agents/${name}.md`);
  if (!text) return null;
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  return { ...(Bun.YAML.parse(m[1]) as Record<string, any>), prompt: m[2].trim() };
}

// The path the blueprint would take with no surprises: the first `next` each time.
export function plannedPath(b: Blueprint, from: string) {
  const path: string[] = [];
  for (let at = b.stages[from]?.next?.[0]; at && at !== "end" && !path.includes(at); at = b.stages[at]?.next?.[0]) path.push(at);
  return path;
}

const title = (id: string) => id[0].toUpperCase() + id.slice(1);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// A session starts from files, not chat: the brief names them (plan: Worktrees and sessions).
export function brief(t: { id: number; title: string }, stage: string, prompt: string | null, folder: string) {
  return [
    `Ticket #${t.id}: ${t.title}. You run its ${stage} stage.`,
    prompt ?? "",
    `Read ${folder}/STATUS.md and any INTENT.md, SLICES.md and HANDOFF.md there before you start.`,
    `When the stage's work is done, run: factory stage-done ${t.id}`,
  ].filter(Boolean).join("\n\n");
}

export function argvFor(agent: { harness?: string; model?: string } | null, defaults: { harness: string; model?: string }, text: string) {
  const harness = agent?.harness ?? defaults.harness;
  const model = agent?.model ?? defaults.model;
  if (harness === "claude") return ["claude", ...(model ? ["--model", model] : []), text];
  if (harness === "codex") return ["codex", ...(model ? ["--model", model] : []), text];
  return [harness, text]; // any other program gets the brief as its last argument
}

export function startTicket(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!["queued", "grooming"].includes(t.state) || t.needs_kind) throw new Error(`#${o.id} is ${t.state}${t.needs_kind ? " with open questions" : ""}; only a groomed or queued ticket starts`);
  const b = loadBlueprint(o.repo, t.blueprint);
  const branch = `factory/${o.id}-${slug(t.title)}`;
  const worktree = join(o.dir, "worktrees", String(o.id));
  mkdirSync(join(o.dir, "worktrees"), { recursive: true });
  const wt = run(["git", "-C", o.repo, "worktree", "add", "-b", branch, worktree]);
  if (wt.code !== 0) throw new Error(`git worktree add failed: ${wt.out}`);
  db.query("UPDATE tickets SET state = 'running', worktree = ?, branch = ? WHERE id = ?").run(worktree, branch, o.id);
  return startStage(db, { ...o, run, now, blueprint: b, stage: b.start });
}

export function startStage(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; blueprint: Blueprint; stage: string }) {
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any>;
  const s = o.blueprint.stages[o.stage];
  if (!s) throw new Error(`blueprint ${o.blueprint.name} has no stage "${o.stage}"`);
  enterStage(db, o.id, title(o.stage), s.agent ? `${s.agent} agent` : s.check ? `check: ${s.check}` : null, plannedPath(o.blueprint, o.stage).map(title), o.now);
  if (!s.agent) return null; // check and gate stages are the daemon's own (D4b)
  const agent = loadAgent(o.repo, s.agent);
  const defaults = { harness: "claude", model: "sonnet" };
  const argv = argvFor(agent, defaults, brief(t as any, o.stage, agent?.prompt ?? null, join(o.dir, "tickets", String(o.id))));
  const name = `f${o.id}-${o.stage}`.slice(0, 32);
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", t.worktree,
    "--label", `factory.ticket=${o.id}`, "--label", `factory.stage=${o.stage}`, ...argv]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  const terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(o.id, o.stage, s.agent, terminal, JSON.stringify(argv), o.now);
  return terminal;
}
