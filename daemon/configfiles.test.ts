// lib/configfiles.js says which copy of a config file the daemon reads, for the Config pages. It
// can't import the daemon, so this checks it against the daemon's own lookups on real files.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentFile } from "./agents.ts";
import { skillDir } from "./skills.ts";
import { stepFile } from "./steps.ts";
import { BUILT_IN_PROMPTS } from "./prompts.ts";
import { repoPrecedence } from "../lib/configfiles.js";

const before = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = before; });

const checkout = join(import.meta.dir, "..");
const put = (file: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "x\n"); };
function world() {
  const home = (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "cfg-home-")));
  const lead = mkdtempSync(join(tmpdir(), "cfg-lead-"));
  const web = mkdtempSync(join(tmpdir(), "cfg-web-"));
  return { home, lead, web };
}
// The file the daemon reads for `path` when a ticket works in `repo`, as configfiles predicts it:
// the repo's own unless it's ignored, else the first of the others that exists (not an example copy).
function predicted(path: string, repo: string, w: ReturnType<typeof world>) {
  const p = repoPrecedence(path, { home: w.home, checkout, lead: repo === w.lead ? null : w.lead });
  const own = join(repo, ".factory", path);
  if (!p.ignored && existsSync(own)) return own;
  return p.others.find((x: any) => x.rel !== "copy" && existsSync(x.file))?.file ?? null;
}

test("agents: a repo's own, then the lead repo's; a factory agent only ever from ~/.factory or shipped", () => {
  const w = world();
  put(join(w.lead, ".factory/agents/builder.md"));
  expect(predicted("agents/builder.md", w.web, w)).toBe(agentFile([w.web, w.lead], "builder")!.file);
  put(join(w.web, ".factory/agents/builder.md"));
  expect(predicted("agents/builder.md", w.web, w)).toBe(agentFile([w.web, w.lead], "builder")!.file);
  put(join(w.web, ".factory/agents/maintainer.md"));
  expect(predicted("agents/maintainer.md", w.web, w)).toBe(agentFile([w.web, w.lead], "maintainer")!.file); // shipped
  put(join(w.home, "agents/maintainer.md"));
  expect(predicted("agents/maintainer.md", w.lead, w)).toBe(agentFile([w.lead], "maintainer")!.file);
});

test("skills: the ticket's repo, the lead repo, then ~/.factory/skills", () => {
  const w = world();
  put(join(w.home, "skills/tour/SKILL.md"));
  expect(predicted("skills/tour/SKILL.md", w.web, w)).toBe(join(skillDir([w.web, w.lead], "tour")!, "SKILL.md"));
  put(join(w.lead, ".factory/skills/tour/SKILL.md"));
  expect(predicted("skills/tour/SKILL.md", w.web, w)).toBe(join(skillDir([w.web, w.lead], "tour")!, "SKILL.md"));
  put(join(w.web, ".factory/skills/tour/SKILL.md"));
  expect(predicted("skills/tour/SKILL.md", w.web, w)).toBe(join(skillDir([w.web, w.lead], "tour")!, "SKILL.md"));
});

test("steps and prompts: the lead repo's, else ~/.factory's step or the built-in prompt; another repo's never", () => {
  const w = world();
  put(join(w.home, "steps/build.yaml"));
  put(join(w.web, ".factory/steps/build.yaml"));
  expect(predicted("steps/build.yaml", w.web, w)).toBe(stepFile(w.lead, "build")!.file);
  put(join(w.lead, ".factory/steps/build.yaml"));
  expect(predicted("steps/build.yaml", w.lead, w)).toBe(stepFile(w.lead, "build")!.file);
  // loadPrompt(lead, name): the lead's prompts/<name>.md, else the built-in one.
  put(join(w.web, ".factory/prompts/stage.md"));
  expect(predicted("prompts/stage.md", w.web, w)).toBe(join(BUILT_IN_PROMPTS, "stage.md"));
  put(join(w.lead, ".factory/prompts/stage.md"));
  expect(predicted("prompts/stage.md", w.web, w)).toBe(join(w.lead, ".factory/prompts/stage.md"));
});
