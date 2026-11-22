import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { triageBrief } from "./groom.ts";
import { overwatchBrief } from "./overwatch.ts";
import { BUILT_IN_PROMPTS, PLACEHOLDERS, loadPrompt, render, templateErrors } from "./prompts.ts";
import { brief, sh, startTicket, type Run } from "./runner.ts";
import { validateDir, validateFile } from "./validate.ts";
import { matchBrief } from "./snap.ts";
import { neighbourMap } from "./agents.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/acme-api/.factory");

// The briefs as they were when the text was hard-coded (briefs.snap.json is that text).
test("the built-in templates give the briefs the code used to build", () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  writeFileSync(join(dir, "REVIEW-ROUND-2.md"), "x");
  const repos = [{ repo: "acme/api", worktree: "/w/api" }, { repo: "acme/web", worktree: "/w/web" }];
  const o = { slug: "acme/api", repo: "/src/api", folder: "/f", blueprints: ["bugfix", "feature"], prompt: "Read the issue." };
  const web = { slug: "acme/web", path: "/src/web", lead: false }, ui = { slug: "acme/ui", path: "/src/ui", lead: false };
  matchBrief("groomIssue", triageBrief({ id: 412, title: "Rate limit" }, o));
  matchBrief("groomGoal", triageBrief({ id: 100000000, title: "A goal" }, { ...o, prompt: null }));
  matchBrief("groomOthers", triageBrief({ id: 7, title: "x" }, { ...o, others: [web, ui] }));
  matchBrief("stagePlain", brief({ id: 1, title: "t" }, "spec", "SPEC PROMPT", "/f"));
  matchBrief("stageBare", brief({ id: 1, title: "t" }, "spec", null, "/f"));
  matchBrief("stageOne", brief({ id: 1, title: "t" }, "spec", "P", "/f", undefined, [repos[0]], ["(src/**) one", "(x) two"]));
  matchBrief("stageMulti", brief({ id: 1, title: "t" }, "implement", "P", "/f", "build", repos, ["(src/**) one", "(x) two"]));
  matchBrief("stageHoldout", brief({ id: 1, title: "t" }, "verify", "P", "/f", "verify"));
  matchBrief("stageReview", brief({ id: 1, title: "t" }, "review", "P", "/f", "review"));
  matchBrief("stageFix", brief({ id: 1, title: "t" }, "implement", "P", dir, "build", repos).split(dir).join("/f"));
  // The maintainer's brief: its whole territory and the request kinds (maintainer.md).
  const maintainer = readFileSync(join(import.meta.dir, "../agents/maintainer.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  matchBrief("stageMaintainer", brief({ id: 10001, title: "Use a warmer accent" }, "maintain", maintainer, "/f", "maintain"));
  matchBrief("overwatchNone", overwatchBrief({ name: "acme", dir: "/d", repo: null }));
  matchBrief("overwatchRepo", overwatchBrief({ name: "acme", dir: "/d", repo: "/src/api" }));
});

test("the fixture's default templates are the built-in ones, and each passes the validator", () => {
  expect(BUILT_IN_PROMPTS).toBe(join(FIXTURE, "prompts"));
  expect(readdirSync(BUILT_IN_PROMPTS).sort()).toEqual(["groom.md", "handoff.md", "overwatch.md", "stage.md"]);
  for (const name of Object.keys(PLACEHOLDERS)) {
    const text = readFileSync(join(BUILT_IN_PROMPTS, `${name}.md`), "utf8");
    expect(validateFile(`prompts/${name}.md`, text)).toEqual([]);
    if (name === "groom" || name === "stage") for (const p of PLACEHOLDERS[name]) expect(text).toContain(`{{${p}}}`); // none silently unused
  }
});

test("render: placeholders fill in; a paragraph with an empty one is dropped, with a bare heading above it", () => {
  const t = "Ticket {{ticket.id}}: {{ ticket.title }}.\n\nNote: {{note}}\nsecond line\n\n## Notes\n\n{{notes}}\n\n## Kept\n\n{{kept}}\n\n{{missing}}";
  expect(render(t, { "ticket.id": "7", "ticket.title": "Fix it", note: "", notes: "", kept: "yes" })).toBe("Ticket 7: Fix it.\n\n## Kept\n\nyes");
  expect(render(t, { "ticket.id": "7", "ticket.title": "Fix it", note: "n", notes: "- a", kept: "yes", missing: "m" }))
    .toBe("Ticket 7: Fix it.\n\nNote: n\nsecond line\n\n## Notes\n\n- a\n\n## Kept\n\nyes\n\nm");
  // a value is text, not a template
  expect(render("{{a}}", { a: "{{b}}", b: "no" })).toBe("{{b}}");
});

test("templateErrors names unknown placeholders and a stray {{", () => {
  expect(templateErrors("stage", "Run {{ticket.id}} in {{folder}}")).toEqual([]);
  expect(templateErrors("stage", "Run {{ticket.idd}}")[0]).toContain("{{ticket.idd}}: unknown placeholder");
  expect(templateErrors("groom", "{{session}}")[0]).toContain("{{session}}: unknown placeholder"); // a handoff name
  expect(templateErrors("stage", "oops {{ ticket.id")).toEqual(["a {{ that isn't a placeholder like {{ticket.id}}"]);
  expect(templateErrors("my-stage", "{{fix_brief}}")).toEqual([]); // any other name is a stage template
});

function factory() {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(FIXTURE, join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: echo\n---\nWrite INTENT.md.\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
}
const prompts = (repo: string, files: Record<string, string>) => {
  mkdirSync(join(repo, ".factory/prompts"), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, ".factory/prompts", f), text);
};

test("a file in .factory/prompts replaces the built-in for that factory only", () => {
  const mine = factory(), other = factory();
  rmDefaults(mine);
  expect(loadPrompt(mine, "stage")).toBe(readFileSync(join(BUILT_IN_PROMPTS, "stage.md"), "utf8")); // no file: the built-in
  prompts(mine, { "stage.md": "#{{ticket.id}} {{stage}}: {{agent.prompt}}\n\nDone? factory stage-done {{ticket.id}}\n" });
  expect(brief({ id: 5, title: "t" }, "spec", "Be brief.", "/f", undefined, [], [], loadPrompt(mine, "stage"))).toBe("#5 spec: Be brief.\n\nDone? factory stage-done 5");
  expect(brief({ id: 5, title: "t" }, "spec", "Be brief.", "/f", undefined, [], [], loadPrompt(other, "stage"))).toContain("You run its spec stage.");
  // grooming and overwatch find theirs the same way
  prompts(mine, { "groom.md": "Groom {{ticket.id}} in {{repo}}. {{agent.prompt}}", "overwatch.md": "Watch {{name}}" });
  expect(triageBrief({ id: 5, title: "t" }, { slug: "a/b", repo: mine, folder: "/f", blueprints: [], prompt: "P" })).toBe(`Groom 5 in ${mine}. P`);
  expect(triageBrief({ id: 5, title: "t" }, { slug: "a/b", repo: other, folder: "/f", blueprints: [], prompt: "P" })).toContain("You groom it");
  expect(overwatchBrief({ name: "acme", dir: "/d", repo: mine })).toBe("Watch acme");
  // a typo in a file refuses to start, not a broken brief
  prompts(mine, { "stage.md": "Go {{ticket.idd}}" });
  expect(() => loadPrompt(mine, "stage")).toThrow(".factory/prompts/stage.md: {{ticket.idd}}: unknown placeholder");
});
const rmDefaults = (repo: string) => sh(["rm", "-rf", join(repo, ".factory/prompts")]);

const stageSetup = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: '{"address":"t9","state":"live"}' }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (412, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  const repo = factory();
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  return { dir, db, calls, run, repo };
};

test("a stage's `prompt:` picks its own template; other stages keep stage.md", () => {
  const { dir, db, calls, run, repo } = stageSetup();
  prompts(repo, { "specs.md": "SPEC TEMPLATE for #{{ticket.id}}: {{agent.prompt}}" });
  const bp = join(repo, ".factory/blueprints/feature.yaml");
  writeFileSync(bp, readFileSync(bp, "utf8").replace("agent: spec-writer,", "agent: spec-writer, prompt: specs,"));
  expect(readFileSync(bp, "utf8")).toContain("prompt: specs");
  expect(validateDir(join(repo, ".factory")).filter((r) => r.errors.length)).toEqual([]);
  startTicket(db, { dir, repo, id: 412, run, now: "2026-11-21T10:00:00Z" });
  expect(calls[0].at(-1)).toBe(`${neighbourMap([{ slug: "acme/api", path: repo }])}\n\nSPEC TEMPLATE for #412: Write INTENT.md.`);
});

test("validate: a stage prompt must name a file; unknown placeholders and empty files are errors", () => {
  const repo = factory();
  prompts(repo, { "good.md": "Hi {{ticket.title}}", "typo.md": "Hi {{ticket.titel}}", "empty.md": "  \n" });
  const bp = join(repo, ".factory/blueprints/feature.yaml");
  const text = readFileSync(bp, "utf8");
  const add = (name: string) => writeFileSync(bp, text.replace("agent: spec-writer,", `agent: spec-writer, prompt: ${name},`));
  const errors = () => Object.fromEntries(validateDir(join(repo, ".factory")).filter((r) => r.errors.length).map((r) => [r.path, r.errors]));
  expect(errors()).toMatchObject({ "prompts/typo.md": [expect.stringContaining("{{ticket.titel}}: unknown placeholder")], "prompts/empty.md": ["prompt: the file is empty"] });
  add("good");
  expect(errors()["blueprints/feature.yaml"]).toBeUndefined();
  add("stage"); // the built-in needs no file
  expect(errors()["blueprints/feature.yaml"]).toBeUndefined();
  add("nope");
  expect(errors()["blueprints/feature.yaml"]).toEqual(["stages.spec.prompt: no file prompts/nope.md"]);
  add("groom"); // grooming's template doesn't fit a stage
  expect(errors()["blueprints/feature.yaml"]![0]).toContain("groom is not a stage template");
  writeFileSync(bp, text.replace("agent: spec-writer,", "agent: spec-writer, prompt: [a],"));
  expect(errors()["blueprints/feature.yaml"]![0]).toContain("expected text");
  expect(existsSync(join(repo, ".factory/prompts/good.md"))).toBe(true);
});

test("every brief opens with the neighbour map, built from the agents' headers and the same each time", () => {
  const repo = factory();
  const map = neighbourMap([{ slug: "acme/api", path: repo }]);
  matchBrief("neighbours", map);
  expect(neighbourMap([{ slug: "acme/api", path: repo }])).toBe(map);
  expect(map).toContain('- maintainer: The factory itself: .factory/ in any repo');
  expect(map).toContain('Ask: factory ask maintainer "<the change, and why>" --why "<evidence>"');
  expect(map).toContain("Repo agents in acme/api, each running one stage of one ticket");
  expect(map).toContain("- spec-writer (spec): INTENT.md for its ticket."); // no territory: its role's
  expect(map).not.toContain("- maintainer (maintain)"); // a factory agent isn't listed as the repo's
  // The stable map first, the ticket after it (plan: Cache-friendly order).
  const stage = brief({ id: 1, title: "t" }, "spec", "P", "/f", undefined, [], [], loadPrompt(repo, "stage"), "", {}, map);
  expect(stage.startsWith(`${map}\n\nTicket #1: t.`)).toBe(true);
  matchBrief("stageNeighbours", stage);
  expect(triageBrief({ id: 5, title: "t" }, { slug: "acme/api", repo, folder: "/f", blueprints: [], prompt: "P", neighbours: map }).startsWith(`${map}\n\nTicket #5`)).toBe(true);
  expect(overwatchBrief({ name: "acme", dir: "/d", repo, neighbours: map }).startsWith(`${map}\n\n`)).toBe(true);
  // A template of yours that doesn't place it still opens with it.
  prompts(repo, { "stage.md": "#{{ticket.id}} {{stage}}" });
  expect(brief({ id: 2, title: "t" }, "spec", null, "/f", undefined, [], [], loadPrompt(repo, "stage"), "", {}, map)).toBe(`${map}\n\n#2 spec`);
  // A territory is the header's; a broken agent file still gets a line, never a broken brief.
  writeFileSync(join(repo, ".factory/agents/reviewer.md"), '---\nrole: review\nterritory: "Payments diffs, strictly"\n---\nBe strict.\n');
  writeFileSync(join(repo, ".factory/agents/broken.md"), "no header");
  const again = neighbourMap([{ slug: "acme/api", path: repo }]);
  expect(again).toContain("- reviewer (review): Payments diffs, strictly.");
  expect(again).toContain("- broken: Its own stage of its own ticket.");
});
