import { afterEach, test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_AGENTS, SHIPPED_AGENTS, SHIPPED_EXAMPLES, agentFile, agentRepos, exampleFile, installExamples, installFactoryAgents, loadAgent, neededAgents } from "./agents.ts";
import { validateDir, validateFile } from "./validate.ts";
import { main, paths } from "./cli.ts";
import { open, setRepo } from "./db.ts";
import { sh, startTicket, type Run } from "./runner.ts";

// Each test sets its own FACTORY_HOME; put it back, so no other file runs on this one's agents.
const before = process.env.FACTORY_HOME;
afterEach(() => { if (before === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = before; });

const FIXTURE = join(import.meta.dir, "../fixtures/acme-api/.factory");

const home = () => (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "agents-home-")));
const repo = () => {
  const r = mkdtempSync(join(tmpdir(), "agents-repo-"));
  cpSync(FIXTURE, join(r, ".factory"), { recursive: true });
  return r;
};
const agentText = (role: string, prompt: string, extra = "") => `---\nrole: ${role}\n${extra}---\n${prompt}\n`;

test("a factory agent loads from ~/.factory/agents, else the shipped default; a repo's copy is never read", () => {
  const h = home(), r = repo();
  writeFileSync(join(r, ".factory/agents/maintainer.md"), agentText("maintain", "REPO COPY"));
  expect(loadAgent(r, "maintainer")?.prompt).toBe(readFileSync(join(SHIPPED_AGENTS, "maintainer.md"), "utf8").split("\n---\n")[1].trim());
  expect(agentFile(r, "maintainer")?.label).toBe("agents/maintainer.md (shipped)");
  mkdirSync(join(h, "agents"));
  writeFileSync(join(h, "agents/maintainer.md"), agentText("maintain", "MINE", "model: claude-opus-5-5\n"));
  expect(loadAgent(r, "maintainer")).toMatchObject({ role: "maintain", model: "claude-opus-5-5", prompt: "MINE" });
  // No repo at all (Overwatch is for every repo): the same file.
  expect(loadAgent(null, "maintainer")?.prompt).toBe("MINE");
  // A bad file of yours fails loudly, naming it.
  writeFileSync(join(h, "agents/maintainer.md"), agentText("maintain", "x", "colour: blue\n"));
  expect(() => loadAgent(r, "maintainer")).toThrow("~/.factory/agents/maintainer.md: colour: unknown key");
});

test("a repo agent loads from the repo's .factory/agents, and differs per repo", () => {
  home();
  const a = repo(), b = repo();
  writeFileSync(join(b, ".factory/agents/reviewer.md"), agentText("review", "Be strict about payments.", 'territory: "Payments diffs"\n'));
  expect(loadAgent(a, "reviewer")?.prompt).toContain("Grade the diff against INTENT.md");
  expect(loadAgent(b, "reviewer")).toMatchObject({ role: "review", territory: "Payments diffs", prompt: "Be strict about payments." });
  expect(loadAgent(a, "ghost")).toBeNull();
  // No repo has it: nothing. The shipped examples are never run for a stage.
  expect(loadAgent(null, "reviewer")).toBeNull();
  // ~/.factory/agents holds factory agents only: a reviewer there is not read.
  const h = process.env.FACTORY_HOME!;
  mkdirSync(join(h, "agents"));
  writeFileSync(join(h, "agents/reviewer.md"), agentText("review", "GLOBAL"));
  expect(loadAgent(a, "reviewer")?.prompt).not.toBe("GLOBAL");
});

test("every shipped agent passes the schema check and names its territory", () => {
  expect(readdirSync(SHIPPED_AGENTS).sort()).toEqual([...FACTORY_AGENTS].map((n) => `${n}.md`).sort());
  for (const dir of [SHIPPED_AGENTS, SHIPPED_EXAMPLES, join(FIXTURE, "agents")])
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect([f, validateFile(`agents/${f}`, text)]).toEqual([f, []]);
      expect([f, typeof loadAgentText(text).territory]).toEqual([f, "string"]);
    }
  // The example library holds no factory agent, and the sample repo's agents are its copies (scripts/gen.mjs).
  for (const n of FACTORY_AGENTS) expect(existsSync(join(SHIPPED_EXAMPLES, `${n}.md`))).toBe(false);
  expect(readdirSync(join(FIXTURE, "agents")).sort()).toEqual(readdirSync(SHIPPED_EXAMPLES).sort());
  for (const f of readdirSync(SHIPPED_EXAMPLES)) expect(readFileSync(join(FIXTURE, "agents", f), "utf8")).toBe(readFileSync(join(SHIPPED_EXAMPLES, f), "utf8"));
  // Each example says, in a comment atop its header, what makes it a good one.
  for (const f of readdirSync(SHIPPED_EXAMPLES)) expect([f, readFileSync(join(SHIPPED_EXAMPLES, f), "utf8")]).toEqual([f, expect.stringMatching(/^---\n# Example [^\n]+\n(# [^\n]+\n)*# [^\n]*Never: /)]);
  expect(validateFile("agents/x.md", agentText("review", "p", "territory: [a]\n"))).toEqual(["territory: expected text, got a list"]);
});
const loadAgentText = (text: string) => Bun.YAML.parse(text.split("\n---\n")[0].slice(4)) as Record<string, unknown>;

test("setup writes the factory agents once, and never overwrites one", () => {
  const h = home();
  expect(installFactoryAgents()).toEqual([...FACTORY_AGENTS]);
  for (const n of FACTORY_AGENTS) expect(readFileSync(join(h, "agents", `${n}.md`), "utf8")).toBe(readFileSync(join(SHIPPED_AGENTS, `${n}.md`), "utf8"));
  writeFileSync(join(h, "agents/learner.md"), agentText("learn", "MY LEARNER"));
  expect(installFactoryAgents()).toEqual([]);
  expect(readFileSync(join(h, "agents/learner.md"), "utf8")).toContain("MY LEARNER");
  // One removed comes back, alone.
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(join(h, "agents/babysitter.md"));
  expect(installFactoryAgents()).toEqual(["babysitter"]);
});

test("setup installs the example library once each, never overwriting one, and adds new shipped ones", () => {
  const h = home();
  const shipped = readdirSync(SHIPPED_EXAMPLES).map((f) => f.slice(0, -3)).sort();
  expect(installExamples()).toEqual(shipped);
  const lib = join(h, "examples", "agents");
  for (const n of shipped) expect(readFileSync(join(lib, `${n}.md`), "utf8")).toBe(readFileSync(join(SHIPPED_EXAMPLES, `${n}.md`), "utf8"));
  // Yours: an edited shipped one and one of your own. Neither is touched; a removed one comes back alone.
  writeFileSync(join(lib, "reviewer.md"), agentText("review", "MY REVIEWER"));
  writeFileSync(join(lib, "migrator.md"), agentText("build", "MY MIGRATOR"));
  rmSync(join(lib, "planner.md"));
  expect(installExamples()).toEqual(["planner"]);
  expect(readFileSync(join(lib, "reviewer.md"), "utf8")).toContain("MY REVIEWER");
  expect(readFileSync(join(lib, "migrator.md"), "utf8")).toContain("MY MIGRATOR");
  // Looked up yours first, then the shipped one.
  expect(exampleFile("reviewer")).toEqual({ file: join(lib, "reviewer.md"), label: "~/.factory/examples/agents/reviewer.md" });
  rmSync(join(lib, "builder.md"));
  expect(exampleFile("builder")).toEqual({ file: join(SHIPPED_EXAMPLES, "builder.md"), label: "examples/agents/builder.md (shipped)" });
  expect(exampleFile("ghost")).toBeNull();
});

test("a repo needs only the agents its blueprints and grooming name", () => {
  const d = mkdtempSync(join(tmpdir(), "needed-"));
  mkdirSync(join(d, "blueprints"));
  writeFileSync(join(d, "factory.yaml"), "name: t\ngrooming: { agent: triager, blueprints: [tiny] }\n");
  writeFileSync(join(d, "blueprints/tiny.yaml"), "name: tiny\norchestrator: foreman\nstart: a\nstages:\n  a: { agent: builder, next: [b] }\n  b: { agent: maintainer, next: [end] }\n");
  expect(neededAgents(d)).toEqual(["builder", "foreman", "triager"]); // the maintainer is a factory agent
  expect(neededAgents(FIXTURE)).toEqual(readdirSync(SHIPPED_EXAMPLES).map((f) => f.slice(0, -3)).sort());
});

test("factory init writes the factory agents; factory validate checks them and warns about a repo's copy", () => {
  const h = home(), r = repo();
  const out: string[] = [];
  main(["init", "--repo", "acme/api", "--path", r, "--name", "acme-api"], (s) => out.push(s));
  expect(out.join("\n")).toContain("the factory agents (overwatch, babysitter, maintainer, learner) are in");
  expect(readdirSync(join(h, "agents")).sort()).toEqual(["babysitter.md", "learner.md", "maintainer.md", "overwatch.md"]);
  expect(out.join("\n")).toContain("the example agents (");
  expect(readdirSync(join(h, "examples", "agents")).sort()).toEqual(readdirSync(SHIPPED_EXAMPLES).sort());
  // The shipped factory blueprint names the maintainer, which has no file in the repo: not dangling.
  expect(validateDir(join(r, ".factory")).filter((x) => x.errors.length)).toEqual([]);
  writeFileSync(join(r, ".factory/agents/overwatch.md"), agentText("overwatch", "mine"));
  const w = validateDir(join(r, ".factory")).find((x) => x.path === "agents/overwatch.md")!;
  expect(w).toMatchObject({ errors: [], warnings: [expect.stringContaining("ignored: overwatch is a factory agent")] });
  const cwd = process.cwd();
  try {
    process.chdir(r);
    out.length = 0;
    main(["validate", "--name", "acme-api"], (s) => out.push(s));
    const text = out.join("\n");
    expect(text).toContain("! agents/overwatch.md\n    ignored: overwatch is a factory agent");
    expect(text).toContain(`✓ ${join(h, "agents/maintainer.md")}`);
    expect(text).toContain(`✓ ${join(h, "examples/agents/builder.md")}`); // the example library is checked too
    writeFileSync(join(h, "agents/learner.md"), agentText("learn", "x", "nope: 1\n"));
    out.length = 0;
    expect(() => main(["validate", "--name", "acme-api"], (s) => out.push(s))).toThrow("files have problems");
    expect(out.join("\n")).toContain("learner.md\n    nope: unknown key");
    writeFileSync(join(h, "agents/learner.md"), readFileSync(join(SHIPPED_AGENTS, "learner.md"), "utf8"));
    writeFileSync(join(h, "examples/agents/migrator.md"), agentText("build", "x", "nope: 1\n"));
    out.length = 0;
    expect(() => main(["validate", "--name", "acme-api"], (s) => out.push(s))).toThrow("1 of");
    expect(out.join("\n")).toContain("examples/agents/migrator.md\n    nope: unknown key");
  } finally { process.chdir(cwd); }
});

// A factory with a lead repo (acme/api) and acme/web, each with its own .factory/agents/.
function twoRepos() {
  home();
  const api = repo(), web = mkdtempSync(join(tmpdir(), "agents-web-"));
  mkdirSync(join(web, ".factory/agents"), { recursive: true });
  const db = open(join(mkdtempSync(join(tmpdir(), "agents-db-")), "factory.db"));
  setRepo(db, { slug: "acme/api", path: api, lead: true });
  setRepo(db, { slug: "acme/web", path: web, lead: false });
  // #1 works in acme/web alone (as the maintainer files one); #2 in both, led by acme/api (as grooming does).
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (1, 'Web only', 'feature', 'x'), (2, 'Both', 'feature', 'x')").run();
  db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (1, 'acme/web', 1), (2, 'acme/api', 1), (2, 'acme/web', 0)").run();
  return { db, api, web };
}

test("a stage's agent loads from the repo its ticket works in, then the lead repo, and never from the examples", () => {
  const { db, api, web } = twoRepos();
  writeFileSync(join(web, ".factory/agents/reviewer.md"), agentText("review", "Review the web way."));
  writeFileSync(join(api, ".factory/agents/reviewer.md"), agentText("review", "Review the api way."));
  expect(agentRepos(db, 1, api)).toEqual([web, api]);
  expect(loadAgent(agentRepos(db, 1, api), "reviewer")?.prompt).toBe("Review the web way.");
  // A ticket with no repo rows yet works in the lead.
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (3, 'New', 'feature', 'x')").run();
  expect(loadAgent(agentRepos(db, 3, api), "reviewer")?.prompt).toBe("Review the api way.");
  // acme/web has no file of its own: the lead's.
  rmSync(join(web, ".factory/agents/reviewer.md"));
  expect(loadAgent(agentRepos(db, 1, api), "reviewer")?.prompt).toBe("Review the api way.");
  expect(agentFile(agentRepos(db, 1, api), "reviewer")?.label).toBe(`${join(api, ".factory/agents/reviewer.md")} (the lead repo's)`);
  // Neither has one: none, even with the example library installed (examples are never run).
  rmSync(join(api, ".factory/agents/reviewer.md"));
  installExamples();
  expect(exampleFile("reviewer")).not.toBeNull();
  expect(agentFile(agentRepos(db, 1, api), "reviewer")).toBeNull();
  expect(loadAgent(agentRepos(db, 1, api), "reviewer")).toBeNull();
  // A bad file in the repo the stage works in fails loudly; it doesn't fall back.
  writeFileSync(join(web, ".factory/agents/reviewer.md"), agentText("review", "x", "colour: blue\n"));
  expect(() => loadAgent(agentRepos(db, 1, api), "reviewer")).toThrow(".factory/agents/reviewer.md: colour: unknown key");
});

test("a cross-repo ticket's stages run its lead repo's agents; another repo's copy doesn't apply", () => {
  const { db, api, web } = twoRepos();
  writeFileSync(join(web, ".factory/agents/builder.md"), agentText("build", "Build the web way."));
  expect(agentRepos(db, 2, api)).toEqual([api, api]);
  expect(loadAgent(agentRepos(db, 2, api), "builder")?.prompt).toBe(loadAgent(api, "builder")?.prompt);
  expect(loadAgent(agentRepos(db, 2, api), "builder")?.prompt).not.toBe("Build the web way.");
});

test("factory agents are the same for every ticket, whatever repo it works in", () => {
  const { db, api, web } = twoRepos();
  writeFileSync(join(web, ".factory/agents/maintainer.md"), agentText("maintain", "WEB COPY"));
  writeFileSync(join(api, ".factory/agents/maintainer.md"), agentText("maintain", "API COPY"));
  const shipped = loadAgent(null, "maintainer")?.prompt;
  expect(loadAgent(agentRepos(db, 1, api), "maintainer")?.prompt).toBe(shipped!);
  mkdirSync(join(process.env.FACTORY_HOME!, "agents"));
  writeFileSync(join(process.env.FACTORY_HOME!, "agents/maintainer.md"), agentText("maintain", "MINE"));
  expect(loadAgent(agentRepos(db, 1, api), "maintainer")?.prompt).toBe("MINE");
  expect(loadAgent(agentRepos(db, 2, api), "maintainer")?.prompt).toBe("MINE");
});

test("a ticket started in a non-lead repo briefs its first stage with that repo's agent", () => {
  const git = (dir: string) => {
    for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "init"]]) sh(["git", "-C", dir, ...c]);
  };
  const { db, api, web } = twoRepos();
  writeFileSync(join(api, ".factory/factory.yaml"), readFileSync(join(api, ".factory/factory.yaml"), "utf8").replace("repos: [acme/api]", "repos: [acme/api, acme/web]"));
  writeFileSync(join(api, ".factory/agents/spec-writer.md"), agentText("spec", "Write the api spec.", "harness: echo\n"));
  writeFileSync(join(web, ".factory/agents/spec-writer.md"), agentText("spec", "Write the web spec.", "harness: echo\n"));
  git(api); git(web);
  const dir = mkdtempSync(join(tmpdir(), "agents-factory-"));
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t1"}' }) : sh(argv, cwd));
  db.query("UPDATE tickets SET state = 'queued' WHERE id = 1").run();
  startTicket(db, { dir, repo: api, id: 1, run, now: "2026-11-23T10:00:00Z" });
  expect(calls[0].at(-1)).toContain("Write the web spec.");
  expect(calls[0].at(-1)).not.toContain("Write the api spec.");
});

test("factory validate checks every repo's .factory/agents/", () => {
  const { api, web } = twoRepos();
  const out: string[] = [];
  const cwd = process.cwd();
  main(["init", "--repo", "acme/api", "--path", api, "--name", "two"], (s) => out.push(s));
  const db = open(paths("two").db);
  setRepo(db, { slug: "acme/web", path: web, lead: false });
  db.close();
  writeFileSync(join(web, ".factory/agents/reviewer.md"), agentText("review", "x", "nope: 1\n"));
  try {
    process.chdir(api);
    out.length = 0;
    expect(() => main(["validate", "--name", "two"], (s) => out.push(s))).toThrow("1 of");
    const text = out.join("\n");
    expect(text).toContain("✗ acme/web .factory/agents/reviewer.md\n    nope: unknown key");
    expect(text.match(/^. agents\/builder\.md$/gm)).toHaveLength(1); // the lead's own, once (and the example's, apart)
    writeFileSync(join(web, ".factory/agents/reviewer.md"), agentText("review", "fine", 'territory: "Web diffs"\n'));
    out.length = 0;
    main(["validate", "--name", "two"], (s) => out.push(s));
    expect(out.join("\n")).toContain("✓ acme/web .factory/agents/reviewer.md");
  } finally { process.chdir(cwd); }
});
