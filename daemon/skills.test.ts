import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_SKILLS, installSkills, sessionPlugin, skillDir, skillFileErrors, withAccess } from "./skills.ts";
import { validateDir, validateFile } from "./validate.ts";
import { main } from "./cli.ts";
import { open, setRepo } from "./db.ts";
import { sh, startTicket, type Run } from "./runner.ts";
import { overwatch } from "./overwatch.ts";

const before = process.env.FACTORY_HOME;
afterEach(() => { if (before === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = before; });

const FIXTURE = join(import.meta.dir, "../fixtures/acme-api/.factory");
const home = () => (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "skills-home-")));
const repo = () => {
  const r = mkdtempSync(join(tmpdir(), "skills-repo-"));
  cpSync(FIXTURE, join(r, ".factory"), { recursive: true });
  return r;
};
const skill = (dir: string, name: string, body = `Do ${name}.`) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${name}.\n---\n${body}\n`);
};
const agentText = (extra: string) => `---\nrole: spec\n${extra}---\nWrite the spec.\n`;
const errorsOf = (dir: string, path: string) => validateDir(dir).find((r) => r.path === path)!.errors;

test("validate: skills and tools are lists of text", () => {
  expect(validateFile("agents/x.md", agentText("skills: tour\n"))).toEqual(["skills: expected a list of text, got string"]);
  expect(validateFile("agents/x.md", agentText("tools: [Read, 3]\n"))).toEqual(["tools: expected a list of text, got a list"]);
  expect(validateFile("agents/x.md", agentText("skills: [tour]\ntools: [Read, Bash]\n"))).toEqual([]);
});

test("validate: a listed skill is found in the repo's .factory/skills, else ~/.factory/skills; a missing one names both", () => {
  const h = home();
  const r = repo();
  writeFileSync(join(r, ".factory/agents/spec-writer.md"), agentText("skills: [mine, shared, ghost, ../up]\n"));
  skill(join(r, ".factory/skills"), "mine");
  skill(join(h, "skills"), "shared");
  expect(errorsOf(join(r, ".factory"), "agents/spec-writer.md")).toEqual([
    'skills: no skill "ghost": looked in .factory/skills/ghost/SKILL.md, then ~/.factory/skills/ghost/SKILL.md',
    'skills: "../up" is not a skill name (a folder name under skills/)',
  ]);
  // The repo's skill files are checked too, and a skill's other files are left alone.
  writeFileSync(join(r, ".factory/skills/mine/helper.sh"), "echo hi\n");
  writeFileSync(join(r, ".factory/skills/mine/SKILL.md"), "no header\n");
  expect(errorsOf(join(r, ".factory"), "skills/mine/SKILL.md")[0]).toContain("needs a YAML header");
  expect(errorsOf(join(r, ".factory"), "skills/mine/helper.sh")).toEqual([]);
  expect(skillFileErrors("---\nname: x\n---\nDo it.\n")).toEqual(["description: the skill needs one; it is how a session knows when to use it"]);
});

test("setup installs the shipped skills once each, never overwriting one, and adds one removed", () => {
  const h = home();
  const shipped = readdirSync(SHIPPED_SKILLS).filter((n) => existsSync(join(SHIPPED_SKILLS, n, "SKILL.md"))).sort();
  expect(shipped).toContain("commit-message");
  expect(installSkills()).toEqual(shipped);
  for (const n of shipped) expect(skillFileErrors(readFileSync(join(h, "skills", n, "SKILL.md"), "utf8"))).toEqual([]);
  // Yours: an edited shipped one (one file of it gone, too) and one of your own. Neither is touched.
  writeFileSync(join(h, "skills/commit-message/SKILL.md"), "MINE");
  skill(join(h, "skills"), "own");
  expect(installSkills()).toEqual([]);
  expect(readFileSync(join(h, "skills/commit-message/SKILL.md"), "utf8")).toBe("MINE");
  rmSync(join(h, "skills/commit-message"), { recursive: true });
  expect(installSkills()).toEqual(["commit-message"]);
  expect(existsSync(join(h, "skills/own/SKILL.md"))).toBe(true);
});

test("factory init installs the skills, and factory validate lists them and checks the factory agents' skills", () => {
  const h = home();
  const r = repo();
  const out: string[] = [];
  const cwd = process.cwd();
  main(["init", "--repo", "acme/api", "--path", r, "--name", "sk"], (s) => out.push(s));
  expect(out.join("\n")).toMatch(/the factory skills \(commit-message, [a-z-, ]+\)/);
  try {
    process.chdir(r);
    out.length = 0;
    main(["validate", "--name", "sk"], (s) => out.push(s));
    expect(out.join("\n")).toMatch(/✓ .*skills\/commit-message\/SKILL\.md/);
    // A factory agent's skills come from ~/.factory/skills/ only.
    writeFileSync(join(h, "agents/learner.md"), readFileSync(join(h, "agents/learner.md"), "utf8").replace(/\n---\n/, "\nskills: [commit-message, ghost]\n---\n"));
    out.length = 0;
    expect(() => main(["validate", "--name", "sk"], (s) => out.push(s))).toThrow("1 of");
    expect(out.join("\n")).toContain('learner.md\n    skills: no skill "ghost": looked in ~/.factory/skills/ghost/SKILL.md');
  } finally { process.chdir(cwd); }
});

test("a session's plugin holds exactly the listed skills, and is rewritten when the list changes", () => {
  const h = home();
  const r = repo();
  skill(join(h, "skills"), "a");
  skill(join(h, "skills"), "b", "Home b.");
  skill(join(r, ".factory/skills"), "b", "Repo b.");
  skill(join(h, "skills"), "unlisted");
  const at = join(mkdtempSync(join(tmpdir(), "skills-folder-")), ".skills", "builder");
  expect(sessionPlugin(at, ["a", "b"], [r])).toBe(at);
  expect(readdirSync(join(at, "skills")).sort()).toEqual(["a", "b"]);
  expect(readFileSync(join(at, "skills/b/SKILL.md"), "utf8")).toContain("Repo b."); // the repo's wins
  expect(JSON.parse(readFileSync(join(at, ".claude-plugin/plugin.json"), "utf8")).name).toBe("factory");
  sessionPlugin(at, ["a"], [r]);
  expect(readdirSync(join(at, "skills"))).toEqual(["a"]);
  expect(sessionPlugin(at, [], [r])).toBeNull();
  expect(existsSync(at)).toBe(false);
  expect(() => sessionPlugin(at, ["ghost"], [r])).toThrow('no skill "ghost"');
});

test("the claude flags: --plugin-dir for skills, --tools for tools (with Skill when it has skills), nothing when neither", () => {
  const argv = ["claude", "--model", "m", "the brief"];
  expect(withAccess(argv, {}, null)).toEqual(argv);
  expect(withAccess(argv, { tools: ["Read", "Bash"] }, null)).toEqual(["claude", "--tools=Read,Bash", "--model", "m", "the brief"]);
  expect(withAccess(argv, { skills: ["a"], tools: ["Read"] }, "/p")).toEqual(["claude", "--plugin-dir=/p", "--tools=Read,Skill", "--model", "m", "the brief"]);
  expect(withAccess(argv, { skills: ["a"] }, "/p")).toEqual(["claude", "--plugin-dir=/p", "--model", "m", "the brief"]);
  expect(withAccess(["codex", "x"], { tools: ["Read"] }, null)).toEqual(["codex", "x"]);
});

test("a listed shipped skill resolves from the examples before setup installed it", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "skills-empty-"));
  expect(skillDir([], "commit-message")).toBe(join(SHIPPED_SKILLS, "commit-message"));
  expect(skillDir([], "ghost")).toBeNull();
  // The shipped examples all pass the SKILL.md check.
  for (const n of readdirSync(SHIPPED_SKILLS).filter((x) => existsSync(join(SHIPPED_SKILLS, x, "SKILL.md"))))
    expect([n, skillFileErrors(readFileSync(join(SHIPPED_SKILLS, n, "SKILL.md"), "utf8"))]).toEqual([n, []]);
});

const git = (dir: string) => {
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) sh(["git", "-C", dir, ...c]);
};

function stageArgv(agent: string) {
  const r = repo();
  git(r);
  writeFileSync(join(r, ".factory/agents/spec-writer.md"), agent);
  const db = open(join(mkdtempSync(join(tmpdir(), "skills-db-")), "factory.db"));
  setRepo(db, { slug: "acme/api", path: r, lead: true });
  db.query("INSERT INTO tickets (id, title, blueprint, state, updated_at) VALUES (1, 'Skills', 'feature', 'queued', 'x')").run();
  db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (1, 'acme/api', 1)").run();
  const dir = mkdtempSync(join(tmpdir(), "skills-factory-"));
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t1"}' }) : sh(argv, cwd));
  startTicket(db, { dir, repo: r, id: 1, run, now: "2026-11-23T10:00:00Z" });
  return { r, dir, argv: calls.find((c) => c[1] === "run")! };
}

test("a stage session gets exactly its agent's skills and tools, from a folder outside the repo", () => {
  const h = home();
  skill(join(h, "skills"), "tour");
  skill(join(h, "skills"), "deslop");
  skill(join(h, "skills"), "unlisted");
  const { r, dir, argv } = stageArgv(agentText("skills: [tour, deslop]\ntools: [Read, Grep, Bash]\n"));
  const plugin = join(dir, "tickets/1/.skills/spec-writer");
  expect(argv).toContain(`--plugin-dir=${plugin}`);
  expect(argv).toContain("--tools=Read,Grep,Bash,Skill");
  expect(readdirSync(join(plugin, "skills")).sort()).toEqual(["deslop", "tour"]);
  expect(argv.at(-1)).toContain("Your skills: factory:tour, factory:deslop.");
  // Nothing written into the repo checkout or the user's Claude folder.
  expect(sh(["git", "-C", r, "status", "--porcelain"]).out).not.toContain("skills");
  expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "skills"))).toBe(false);
});

test("an agent with neither skills nor tools runs as today: no plugin, no tool limit, no skills line", () => {
  const h = home();
  skill(join(h, "skills"), "tour");
  const { dir, argv } = stageArgv(agentText(""));
  expect(argv.some((a) => a.startsWith("--plugin-dir") || a.startsWith("--tools"))).toBe(false);
  expect(argv.at(-1)).not.toContain("Your skills");
  expect(existsSync(join(dir, "tickets/1/.skills"))).toBe(false);
});

test("Overwatch, a factory agent, gets the skills its file lists from ~/.factory/skills", () => {
  const h = home();
  skill(join(h, "skills"), "tour");
  mkdirSync(join(h, "agents"), { recursive: true });
  writeFileSync(join(h, "agents/overwatch.md"), `---\nrole: overwatch\nskills: [tour]\ntools: [Read]\n---\nTalk with the person.\n`);
  const calls: string[][] = [];
  const run: Run = (argv) => (calls.push(argv), argv[1] === "get" ? { code: 1, out: "" } : { code: 0, out: '{"address":"w1"}' });
  overwatch({ run, now: "2026-11-23T10:00:00Z", home: h, factories: [] });
  const argv = calls.find((c) => c[1] === "run")!;
  expect(argv).toContain(`--plugin-dir=${join(h, ".skills/overwatch")}`);
  expect(argv).toContain("--tools=Read,Skill");
  expect(readdirSync(join(h, ".skills/overwatch/skills"))).toEqual(["tour"]);
});
