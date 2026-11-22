// Agent files, in two tiers (plan: The agents). Repo agents (triage, spec, planner,
// builder, reviewer…) live in each repo's .factory/agents/ and can differ per repo. The
// factory agents (Overwatch, babysitter, maintainer, learner) are one set for every repo:
// <FACTORY_HOME>/agents/<name>.md, else the default shipped in this repo's agents/. A
// repo's own copy of a factory agent is never read; `factory validate` warns about it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateFile } from "./validate.ts";
import type { Database } from "bun:sqlite";
import { leadRepo } from "./db.ts";

export const FACTORY_AGENTS = ["overwatch", "babysitter", "maintainer", "learner"] as const;
export type FactoryAgent = (typeof FACTORY_AGENTS)[number];
export const isFactoryAgent = (name: string): name is FactoryAgent => (FACTORY_AGENTS as readonly string[]).includes(name);

export const SHIPPED_AGENTS = join(import.meta.dir, "../agents");
export const factoryAgentsDir = (home = process.env.FACTORY_HOME ?? join(homedir(), ".factory")) => join(home, "agents");

// The file an agent loads from, and how to name it in an error; null when there is none.
export function agentFile(repo: string | null, name: string): { file: string; label: string } | null {
  if (isFactoryAgent(name)) {
    const own = join(factoryAgentsDir(), `${name}.md`);
    if (existsSync(own)) return { file: own, label: `~/.factory/agents/${name}.md` };
    return { file: join(SHIPPED_AGENTS, `${name}.md`), label: `agents/${name}.md (shipped)` };
  }
  const file = repo ? join(repo, ".factory", "agents", `${name}.md`) : null;
  return file && existsSync(file) ? { file, label: `.factory/agents/${name}.md` } : null;
}

export type Agent = Record<string, any> & { prompt: string; role?: string; territory?: string };

export function parseAgent(text: string): Agent {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  return { ...(Bun.YAML.parse(m[1]) as Record<string, any>), prompt: m[2].trim() };
}

// The agent `name` as `repo` runs it, checked; null when the repo has no such agent.
export function loadAgent(repo: string | null, name: string): Agent | null {
  const at = agentFile(repo, name);
  if (!at) return null;
  const text = readFileSync(at.file, "utf8");
  const errors = validateFile(`agents/${name}.md`, text);
  if (errors.length) throw new Error(`${at.label}: ${errors[0]}`);
  return parseAgent(text);
}

// Setup: the factory agents into <FACTORY_HOME>/agents/, once each. A file already there is
// yours (or the maintainer's) and is never overwritten. Returns the names written.
export function installFactoryAgents(home?: string) {
  const dir = factoryAgentsDir(home);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const name of FACTORY_AGENTS) {
    const to = join(dir, `${name}.md`);
    if (existsSync(to)) continue;
    copyFileSync(join(SHIPPED_AGENTS, `${name}.md`), to);
    written.push(name);
  }
  return written;
}

// The factory agents you have in <FACTORY_HOME>/agents/, for `factory validate`.
export const factoryAgentFiles = (home?: string) => {
  const dir = factoryAgentsDir(home);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir, f)) : [];
};

// ---- the neighbour map ---------------------------------------------------------------
// Every brief opens with the factory's agents: name, tier, territory, and how to ask each.
// It's built from the agents' headers only, sorted, so it reads the same in every session
// and stays in the cached front of the brief (plan: Cache-friendly order).

// An agent with no `territory:` gets its role's.
const ROLE_TERRITORY: Record<string, string> = {
  orchestrator: "Which stage runs next, when a blueprint offers more than one",
  triage: "Grooming one ticket before it starts", spec: "INTENT.md for its ticket", plan: "SLICES.md for its ticket",
  build: "Its ticket's work, in the ticket's worktree", review: "The review verdict on its ticket's diff", verify: "Hidden checks and the holdout verdict for its ticket",
  scorer: "Scoring benchmark runs", maintain: "The factory itself", overwatch: "Talking with you, and the state of every ticket",
  babysit: "Every PR the factory opened", learn: "What would move learn.target",
};
const HOW: Record<FactoryAgent, string> = {
  overwatch: 'factory ask overwatch "<what the person should hear or decide>"; the only agent that talks to the person',
  babysitter: 'factory ask babysitter "<text>"; read on its next run',
  maintainer: 'factory ask maintainer "<the change, and why>" --why "<evidence>"; it comes back as a PR',
  learner: 'factory ask learner "<text>" --why "<evidence>"; read on its next run',
};

const territoryOf = (a: Agent | null) => (a?.territory ?? (a?.role ? ROLE_TERRITORY[a.role] : undefined) ?? "Its own stage of its own ticket").replace(/\.$/, "");

function safeLoad(repo: string | null, name: string) {
  try { return loadAgent(repo, name); } catch { return null; } // a bad file fails its own stage, not every brief
}

// The repo agents of one repo, by name.
export function repoAgents(repo: string) {
  const dir = join(repo, ".factory", "agents");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((n) => !isFactoryAgent(n)).sort() : [];
}

export function neighbourMap(repos: { slug: string; path: string }[]) {
  const lines = [
    "## The factory's agents",
    "",
    "Each agent acts only in its own territory. When something belongs to another agent, ask it rather than doing it yourself.",
    "",
    "Factory agents, one each for every repo:",
    ...FACTORY_AGENTS.map((n) => `- ${n}: ${territoryOf(safeLoad(null, n))}. Ask: ${HOW[n]}.`),
  ];
  for (const r of [...repos].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const names = repoAgents(r.path);
    if (!names.length) continue;
    lines.push("", `Repo agents in ${r.slug}, each running one stage of one ticket; ask overwatch to route work to them:`);
    for (const n of names) {
      const a = safeLoad(r.path, n);
      lines.push(`- ${n}${a?.role ? ` (${a.role})` : ""}: ${territoryOf(a)}.`);
    }
  }
  return lines.join("\n");
}

// The map in one factory's briefs: the factory agents and its lead repo's agents, whose
// .factory/agents/ every ticket's stages run from.
export const factoryMap = (db: Database) => {
  const lead = leadRepo(db);
  return neighbourMap(lead ? [lead] : []);
};
