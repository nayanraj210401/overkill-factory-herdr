// Agent files, in two tiers (plan: The agents). Repo agents (triage, spec, planner,
// builder, reviewer…) live in each repo's .factory/agents/ and can differ per repo. The
// factory agents (Overwatch, babysitter, maintainer, learner) are one set for every repo:
// <FACTORY_HOME>/agents/<name>.md, else the default shipped in this repo's agents/. A
// repo's own copy of a factory agent is never read; `factory validate` warns about it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateFile } from "./validate.ts";

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
