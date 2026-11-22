import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_AGENTS, SHIPPED_AGENTS, agentFile, installFactoryAgents, loadAgent } from "./agents.ts";
import { validateDir, validateFile } from "./validate.ts";
import { main } from "./cli.ts";

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
  expect(loadAgent(null, "reviewer")).toBeNull();
  // ~/.factory/agents holds factory agents only: a reviewer there is not read.
  const h = process.env.FACTORY_HOME!;
  mkdirSync(join(h, "agents"));
  writeFileSync(join(h, "agents/reviewer.md"), agentText("review", "GLOBAL"));
  expect(loadAgent(a, "reviewer")?.prompt).not.toBe("GLOBAL");
});

test("every shipped agent passes the schema check and names its territory", () => {
  expect(readdirSync(SHIPPED_AGENTS).sort()).toEqual([...FACTORY_AGENTS].map((n) => `${n}.md`).sort());
  for (const dir of [SHIPPED_AGENTS, join(FIXTURE, "agents")])
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect([f, validateFile(`agents/${f}`, text)]).toEqual([f, []]);
      expect([f, typeof loadAgentText(text).territory]).toEqual([f, "string"]);
    }
  // The repo fixture (what setup copies into a repo) holds no factory agent.
  for (const n of FACTORY_AGENTS) expect(existsSync(join(FIXTURE, "agents", `${n}.md`))).toBe(false);
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

test("factory init writes the factory agents; factory validate checks them and warns about a repo's copy", () => {
  const h = home(), r = repo();
  const out: string[] = [];
  main(["init", "--repo", "acme/api", "--path", r, "--name", "acme-api"], (s) => out.push(s));
  expect(out.join("\n")).toContain("the factory agents (overwatch, babysitter, maintainer, learner) are in");
  expect(readdirSync(join(h, "agents")).sort()).toEqual(["babysitter.md", "learner.md", "maintainer.md", "overwatch.md"]);
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
    writeFileSync(join(h, "agents/learner.md"), agentText("learn", "x", "nope: 1\n"));
    out.length = 0;
    expect(() => main(["validate", "--name", "acme-api"], (s) => out.push(s))).toThrow("files have problems");
    expect(out.join("\n")).toContain("learner.md\n    nope: unknown key");
  } finally { process.chdir(cwd); }
});
