// Factory skills (docs/flow-stack-skills.md, "How a skill comes into the factory"). A skill is a
// folder with a SKILL.md, in Claude Code's own format. The shipped ones live in examples/skills/
// here and are installed into <FACTORY_HOME>/skills/, where your own skills sit beside them. A repo
// may keep its own in .factory/skills/<name>/, which wins over the account's for that repo's agents.
//
// An agent gets only the skills its frontmatter lists (`skills: [tour]`) and, when it lists
// `tools:`, only those tools. A session's skills are copied into a plugin folder of its own,
// outside the repo checkout and outside ~/.claude, and the session starts with
// `--plugin-dir=<that folder>`, so it sees them as factory:<name>. `tools:` becomes `--tools=…`.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SHIPPED_SKILLS = join(import.meta.dir, "../examples/skills");
const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");
export const skillsDir = (home = factoryHome()) => join(home, "skills");
// The plugin's name: a session sees each skill as factory:<name>.
export const PLUGIN = "factory";

const isSkill = (dir: string) => existsSync(join(dir, "SKILL.md"));
const skillNames = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory() && isSkill(join(dir, n))).sort() : []);

// Setup: the shipped skills into <FACTORY_HOME>/skills/, once each. A skill folder already there
// is yours and is never overwritten, not even a file of it; one shipped later is added.
export function installSkills(home?: string) {
  const dir = skillsDir(home);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const name of skillNames(SHIPPED_SKILLS)) {
    const to = join(dir, name);
    if (existsSync(to)) continue;
    cpSync(join(SHIPPED_SKILLS, name), to, { recursive: true });
    written.push(name);
  }
  return written;
}

// The skills you have in <FACTORY_HOME>/skills/ (yours and the shipped ones), for `factory validate`.
export const skillFiles = (home?: string) => skillNames(skillsDir(home)).map((n) => join(skillsDir(home), n, "SKILL.md"));

// A skill's name is a folder name: no path in it.
export const badSkillName = (name: string) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..");

// Where the skill `name` is for an agent of `repos` (the repo the agent loads from first): each
// repo's .factory/skills/<name>/, then <FACTORY_HOME>/skills/<name>/. A factory agent passes no repo.
export function skillDir(repos: (string | null | undefined)[], name: string): string | null {
  for (const repo of repos) if (repo && isSkill(join(repo, ".factory", "skills", name))) return join(repo, ".factory", "skills", name);
  const own = join(skillsDir(), name);
  return isSkill(own) ? own : null;
}

export const missingSkill = (name: string, repo: boolean) =>
  `no skill "${name}": looked in ${repo ? `.factory/skills/${name}/SKILL.md, then ` : ""}~/.factory/skills/${name}/SKILL.md`;

// The listed skills that aren't there, as errors.
export function skillErrors(skills: unknown, repos: (string | null | undefined)[]): string[] {
  if (!Array.isArray(skills)) return [];
  return skills.filter((s): s is string => typeof s === "string").flatMap((s) =>
    badSkillName(s) ? [`skills: "${s}" is not a skill name (a folder name under skills/)`]
    : skillDir(repos, s) ? [] : [`skills: ${missingSkill(s, repos.some(Boolean))}`]);
}

// A SKILL.md: Claude Code's format, a YAML header with name and description, then the instructions.
export function skillFileErrors(text: string): string[] {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return ["skill: SKILL.md needs a YAML header between --- lines (name, description), then the instructions"];
  let doc: any;
  try { doc = Bun.YAML.parse(m[1]); } catch (e) { return [`YAML: ${(e as Error).message.split("\n")[0]}`]; }
  const errors: string[] = [];
  if (typeof doc?.description !== "string" || !doc.description.trim()) errors.push("description: the skill needs one; it is how a session knows when to use it");
  if (!m[2].trim()) errors.push("skill: the instructions after the header are empty");
  return errors;
}

export type Access = { skills?: unknown; tools?: unknown };

// The session's own plugin folder at `at`, holding exactly the listed skills; null when the agent
// lists none. Rewritten whole each time, so a skill dropped from the list is gone from the session.
export function sessionPlugin(at: string, skills: string[], repos: (string | null | undefined)[]): string | null {
  if (!skills.length) {
    rmSync(at, { recursive: true, force: true });
    return null;
  }
  const errors = skillErrors(skills, repos);
  if (errors.length) throw new Error(errors[0]);
  const tmp = `${at}.${process.pid}-${Date.now()}`;
  mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
  writeFileSync(join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN, description: "The skills this factory agent's frontmatter lists", version: "0.0.0" }, null, 2) + "\n");
  for (const s of skills) cpSync(skillDir(repos, s)!, join(tmp, "skills", s), { recursive: true });
  mkdirSync(dirname(at), { recursive: true });
  rmSync(at, { recursive: true, force: true });
  renameSync(tmp, at);
  return at;
}

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// The brief's one line naming the agent's skills; "" when it has none.
export const skillsLine = (agent: Access | null) => {
  const s = list(agent?.skills);
  return s.length ? `Your skills: ${s.map((n) => `${PLUGIN}:${n}`).join(", ")}. Load one with the Skill tool when the work fits its description; you have no other factory skills.` : "";
};
export const withSkillsLine = (prompt: string | null | undefined, agent: Access | null) => [prompt ?? "", skillsLine(agent)].filter(Boolean).join("\n\n") || null;

// A claude argv with the agent's skills and tools: `--plugin-dir=` for its session plugin, and
// `--tools=` when it lists tools (with Skill added when it has skills, or it couldn't load them).
// The `=` form, since both flags take several values and would swallow the brief after them.
// Another harness, or an agent that lists neither, runs as it is.
export function withAccess(argv: string[], agent: Access | null, plugin: string | null) {
  if (argv[0] !== "claude") return argv;
  const tools = list(agent?.tools);
  const all = plugin && !tools.includes("Skill") ? [...tools, "Skill"] : tools;
  const flags = [...(plugin ? [`--plugin-dir=${plugin}`] : []), ...(Array.isArray(agent?.tools) ? [`--tools=${all.join(",")}`] : [])];
  return flags.length ? [argv[0], ...flags, ...argv.slice(1)] : argv;
}

// Both at once, for a session starting: its plugin at `at` and the flags for it.
export function giveAccess(argv: string[], agent: Access | null, at: string, repos: (string | null | undefined)[]) {
  if (argv[0] !== "claude") return argv;
  return withAccess(argv, agent, sessionPlugin(at, list(agent?.skills), repos));
}
