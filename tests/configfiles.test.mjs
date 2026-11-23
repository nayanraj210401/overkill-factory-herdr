import { test } from "node:test";
import assert from "node:assert/strict";
import { repoPrecedence, globalPrecedence, fileBadge, globalFiles, repoChoices, leadOf, maintainerAsk } from "../lib/configfiles.js";

const o = { home: "/h/.factory", checkout: "/src", lead: null };
const other = { ...o, lead: "/p/api" };
const first = (p, exists) => p.others.find((x) => exists.includes(x.file)) ?? null;

test("a repo's copy of a factory agent is never read: the global one is, else the shipped one", () => {
  const p = repoPrecedence("agents/maintainer.md", o);
  assert.match(p.ignored, /~\/\.factory\/agents/);
  assert.deepEqual(p.others.map((x) => x.file), ["/h/.factory/agents/maintainer.md", "/src/agents/maintainer.md"]);
  const b = fileBadge(p, { ...p.others[0], text: "old" }, "new");
  assert.deepEqual([b.badge, b.tone, b.note], ["not used", "blocked", "differs from global"]);
});

test("a repo agent in another repo overrides the lead repo's; in the lead it is only a copy of an example", () => {
  const p = repoPrecedence("agents/builder.md", other);
  assert.equal(p.ignored, null);
  assert.equal(p.others[0].file, "/p/api/.factory/agents/builder.md");
  assert.equal(fileBadge(p, { ...p.others[0], text: "x" }, "x").badge, "overrides lead repo");
  const lead = repoPrecedence("agents/builder.md", o);
  assert.deepEqual(lead.others.map((x) => x.tier), ["global example", "built-in example"]);
  const b = fileBadge(lead, { ...first(lead, ["/src/examples/agents/builder.md"]), text: "a\n" }, "b\n");
  assert.deepEqual([b.badge, b.tone, b.note], ["from built-in example", "dim", "differs from built-in example"]);
  assert.equal(fileBadge(lead, { ...lead.others[1], text: "same\n" }, "same").note, null); // trailing whitespace isn't a difference
});

test("a lead repo's prompt overrides the built-in one; another repo's prompts are never read", () => {
  const p = repoPrecedence("prompts/stage.md", o);
  assert.deepEqual(p.others, [{ rel: "over", tier: "built-in", file: "/src/fixtures/acme-api/.factory/prompts/stage.md" }]);
  const b = fileBadge(p, { ...p.others[0], text: "v1" }, "v2");
  assert.deepEqual([b.badge, b.tone, b.note], ["overrides built-in", "accent", "differs from built-in"]);
  assert.deepEqual(fileBadge(p, null, "x"), { badge: null, tone: null, why: null, note: null }); // a stage template of its own
  const q = repoPrecedence("prompts/stage.md", other);
  assert.match(q.ignored, /lead repo/);
  assert.deepEqual(q.others.map((x) => x.tier), ["lead repo", "built-in"]);
});

test("a lead repo's step overrides the global one; skills override the lead repo's, then the global one", () => {
  const s = repoPrecedence("steps/build.yaml", o);
  assert.deepEqual(s.others.map((x) => `${x.rel} ${x.tier}`), ["over global", "copy global example", "copy built-in example"]);
  assert.equal(fileBadge(s, { ...s.others[0], text: "a" }, "a").badge, "overrides global");
  assert.match(repoPrecedence("steps/build.yaml", other).ignored, /steps/);
  const k = repoPrecedence("skills/tour/SKILL.md", other);
  assert.deepEqual(k.others.map((x) => x.file), ["/p/api/.factory/skills/tour/SKILL.md", "/h/.factory/skills/tour/SKILL.md", "/src/examples/skills/tour/SKILL.md"]);
});

test("another repo's factory.yaml and blueprints do nothing; triggers and unknown files get no badge", () => {
  assert.match(repoPrecedence("factory.yaml", other).ignored, /factory\.yaml/);
  assert.match(repoPrecedence("blueprints/feature.yaml", other).ignored, /blueprints/);
  assert.equal(repoPrecedence("blueprints/feature.yaml", o).ignored, null);
  assert.deepEqual(repoPrecedence("triggers/x.yaml", other), { ignored: null, others: [] });
});

test("a global factory agent overrides the shipped one; skills and steps compare with the shipped examples", () => {
  assert.deepEqual(globalPrecedence("agents/overwatch.md", o).others, [{ rel: "over", tier: "built-in", file: "/src/agents/overwatch.md" }]);
  assert.equal(globalPrecedence("skills/tour/SKILL.md", o).others[0].file, "/src/examples/skills/tour/SKILL.md");
  assert.deepEqual(globalPrecedence("plan.json", o).others, []);
  assert.deepEqual(globalPrecedence("agents/overwatch.md", { ...o, checkout: null }).others, []); // no checkout known: nothing to compare
});

test("Config lists ~/.factory's config: agents, skills, steps, then the account files; nothing else", () => {
  const got = globalFiles(["plan.json", "agents-live.json", "skills/tour/SKILL.md", "agents/overwatch.md", "maintainer.json", "logs/daemon.err.log",
    "steps/build.yaml", "factory-sandbox/status.json", "agents/notes.txt", "overwatch.json", "skills/.DS_Store", "backups/x.md", "config.yaml"]);
  assert.deepEqual(got.map((f) => f.path), ["agents/overwatch.md", "skills/tour/SKILL.md", "steps/build.yaml", "config.yaml", "maintainer.json", "overwatch.json", "plan.json"]);
  assert.deepEqual(got.map((f) => f.language), ["markdown", "markdown", "yaml", "yaml", "json", "json", "json"]);
});

test("the switcher lists the shown factory's repos, lead first, and falls back to status.json's lead", () => {
  const factories = [{ name: "shop", repos: [{ slug: "a/web", path: "/w", lead: false }, { slug: "a/api", path: "/a", lead: true }] }, { name: "x", repos: [] }];
  const got = repoChoices(factories, { factory: { name: "shop" } }, null);
  assert.deepEqual(got.map((r) => r.slug), ["a/api", "a/web"]);
  assert.equal(leadOf(got), "/a");
  assert.deepEqual(repoChoices(factories, { factory: { name: "acme", repo: "acme/api", path: "/acme" } }, "/root"), [{ slug: "acme/api", path: "/acme", lead: true }]);
  assert.deepEqual(repoChoices([], { factory: { name: "acme", repo: "acme/api" } }, "/root"), [{ slug: "acme/api", path: "/root", lead: true }]);
  assert.deepEqual(repoChoices([], null, null), []);
});

test("Ask maintainer runs factory request, with --repo on the Repo config page", () => {
  assert.deepEqual(maintainerAsk().args, ["request"]);
  assert.deepEqual(maintainerAsk("a/web").args, ["request", "--repo", "a/web"]);
  assert.ok(maintainerAsk().input);
});

test("the checkout comes from the CLI path sync.sh writes", async () => {
  const { checkoutOf } = await import("../lib/configfiles.js");
  assert.equal(checkoutOf(["/bin/bun", "/src/factory/daemon/cli.ts"]), "/src/factory");
  assert.equal(checkoutOf(["/usr/local/bin/factory"]), null);
});
