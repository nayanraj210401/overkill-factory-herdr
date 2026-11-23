import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, paths } from "./cli.ts";
import { open } from "./db.ts";
import { detectFloor, isTrusted, setupSteps, trust, writeSetup, type Probe } from "./setup.ts";
import { buildStatus } from "./status.ts";
import { migrateFlowStack, errRatio, parseProfile } from "./migrate.ts";
import { validateStatus } from "../lib/status.js";
import { validateDir } from "./validate.ts";
import { neededAgents, SHIPPED_EXAMPLES } from "./agents.ts";

const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...a]);
  return (r.stdout.toString() + r.stderr.toString()).trim();
};
const repoWithCommit = () => {
  const repo = mkdtempSync(join(tmpdir(), "setup-repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(repo, ...c);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
};
const probe = (o: Partial<{ have: string[]; gh: boolean; service: string; trusted: boolean }> = {}): Probe => ({
  has: (b) => (o.have ?? ["hc", "gh", "claude"]).includes(b), ghLoggedIn: () => o.gh ?? true, service: () => o.service ?? "running", trusted: () => o.trusted ?? true,
});
const by = (steps: ReturnType<typeof setupSteps>) => Object.fromEntries(steps.map((s) => [s.id, s.status]));

test("the checklist names each missing tool with its fix, and a skipped step stays listed", () => {
  const repo = mkdtempSync(join(tmpdir(), "bare-"));
  const all = setupSteps({ repo, probe: probe() });
  expect(by(all)).toEqual({ "herdr-core": "ok", gh: "ok", harness: "ok", trust: "ok", service: "ok", queue: "missing", basics: "missing", "factory-dir": "missing" });
  expect(all.find((s) => s.id === "factory-dir")!.fix).toBe("factory setup write");

  const bare = setupSteps({ repo, probe: probe({ have: [], service: "absent" }), skipped: ["service"] });
  expect(by(bare)).toMatchObject({ "herdr-core": "missing", gh: "missing", harness: "missing", service: "skipped" });
  expect(bare.find((s) => s.id === "gh")!.fix).toContain("brew install gh");
  expect(bare.find((s) => s.id === "service")!.fix).toBe("factory service install");
  expect(bare.find((s) => s.id === "herdr-core")!.fix).toContain("herdr-core");

  // gh installed but not logged in: the fix is the login; either harness is enough.
  const out = setupSteps({ repo, probe: probe({ have: ["hc", "gh", "codex"], gh: false }) });
  expect(out.find((s) => s.id === "gh")).toMatchObject({ status: "missing", fix: "gh auth login" });
  expect(out.find((s) => s.id === "harness")!.status).toBe("ok");
});

test("queue and basics read factory.yaml; an ok step has no fix", () => {
  const repo = mkdtempSync(join(tmpdir(), "yaml-"));
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory", "factory.yaml"), "name: x\nbudget:\n  per_ticket: { input: 3M }\nmerge: human\n");
  let s = setupSteps({ repo, probe: probe() });
  expect(by(s)).toMatchObject({ queue: "missing", basics: "missing", "factory-dir": "ok" });
  expect(s.find((x) => x.id === "basics")!.detail).toBe("budget.per_day, max_running");
  writeFileSync(join(repo, ".factory", "factory.yaml"),
    "name: x\nqueue: { github_project: a/b }\nbudget:\n  per_ticket: { input: 3M }\n  per_day: { input: 40M }\nmerge: auto\nmax_running: 2\n");
  s = setupSteps({ repo, probe: probe() });
  expect(by(s)).toMatchObject({ queue: "ok", basics: "ok" });
  expect(s.every((x) => x.status !== "ok" || x.fix === null)).toBe(true);
});

test("setup write puts .factory/ in the checkout, never in git, and keeps a file you already have", () => {
  const repo = repoWithCommit();
  const head = git(repo, "rev-parse", "HEAD");
  const r = writeSetup({ repo, name: "acme-api", slug: "acme/api", basics: { budget: "2M/100k", merge: "auto", maxRunning: 2 } });
  expect(r).toMatchObject({ dir: join(repo, ".factory"), kept: [], excluded: true, tracked: [] });
  // Nothing committed, no branch, no .gitignore: .factory/ is in .git/info/exclude, so git doesn't see it.
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(repo, "branch", "--list")).toBe("* main");
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain("/.factory/\n");
  const files = r.written.map((f) => `.factory/${f}`);
  expect(files).toContain(".factory/factory.yaml");
  expect(files.some((f) => f.startsWith(".factory/blueprints/"))).toBe(true);
  expect(files.some((f) => f.startsWith(".factory/agents/"))).toBe(true);
  expect(files.filter((f) => f.startsWith(".factory/prompts/")).sort()).toEqual([".factory/prompts/groom.md", ".factory/prompts/handoff.md", ".factory/prompts/overwatch.md", ".factory/prompts/stage.md"]);
  const yaml = readFileSync(join(repo, ".factory/factory.yaml"), "utf8");
  expect(yaml).toContain("per_ticket: { input: 2M, output: 100k }");
  expect(yaml).toContain("merge: auto");
  expect(yaml).toContain("max_running: 2");
  // Grooming picks only blueprints it may start: address-review is the review-comments trigger's.
  expect(yaml).toMatch(/blueprints: \[[^\]]*feature[^\]]*\]/);
  expect(yaml).not.toMatch(/blueprints: \[[^\]]*address-review/);
  // The maintenance agent (PRD 7.5) comes along with its blueprint and daily trigger, and grooming never picks it.
  expect(files).toEqual(expect.arrayContaining([".factory/agents/maintenance.md", ".factory/blueprints/maintenance.yaml", ".factory/triggers/maintenance.yaml"]));
  expect(files.filter((f) => f.startsWith(".factory/triggers/"))).toEqual([".factory/triggers/maintenance.yaml"]);
  expect(yaml).not.toMatch(/blueprints: \[[^\]]*maintenance/);
  // It lands off: a new factory opens no maintenance PR until you turn it on.
  expect(readFileSync(join(repo, ".factory/triggers/maintenance.yaml"), "utf8")).toMatch(/^enabled: false$/m);
  // Again, with other answers: your files stay as they are; only a missing one is written.
  writeFileSync(join(repo, ".factory/factory.yaml"), yaml.replace("max_running: 2", "max_running: 4"));
  const { rmSync } = require("node:fs");
  rmSync(join(repo, ".factory/prompts/stage.md"));
  const again = writeSetup({ repo, name: "acme-api", slug: "acme/api", basics: { maxRunning: 5 } });
  expect(again.written).toEqual(["prompts/stage.md"]);
  expect(again.kept).toContain("factory.yaml");
  expect(readFileSync(join(repo, ".factory/factory.yaml"), "utf8")).toContain("max_running: 4");
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/\/\.factory\//g)).toHaveLength(1);
});

test("setup write copies only the agents the blueprints name, from your examples first, then the shipped ones", () => {
  const repo = repoWithCommit();
  const before = process.env.FACTORY_HOME;
  const home = (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "setup-home-")));
  try {
    const lib = join(home, "examples", "agents");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "reviewer.md"), "---\nrole: review\nterritory: \"Our diffs\"\n---\nReview our way.\n");
    writeFileSync(join(lib, "migrator.md"), "---\nrole: build\n---\nMigrate.\n"); // no blueprint names it
    writeSetup({ repo, name: "acme-api", slug: "acme/api", basics: {} });
    const agents = readdirSync(join(repo, ".factory/agents")).map((f) => f.slice(0, -3)).sort();
    expect(agents).toEqual(neededAgents(join(import.meta.dir, "../fixtures/acme-api/.factory")));
    expect(agents).not.toContain("migrator");
    expect(readFileSync(join(repo, ".factory/agents/reviewer.md"), "utf8")).toContain("Review our way.");
    expect(readFileSync(join(repo, ".factory/agents/builder.md"), "utf8")).toBe(readFileSync(join(SHIPPED_EXAMPLES, "builder.md"), "utf8"));
  } finally { process.env.FACTORY_HOME = before; }
});

test("setup write refuses bad answers before writing anything", () => {
  const repo = repoWithCommit();
  expect(() => writeSetup({ repo, name: "x", slug: "a/b", basics: { merge: "maybe" } })).toThrow("human or auto");
  expect(() => writeSetup({ repo, name: "x", slug: "a/b", basics: { budget: "lots" } })).toThrow("isn't tokens");
  expect(() => writeSetup({ repo, name: "x", slug: "a/b", basics: { maxRunning: 0 } })).toThrow("whole number");
  expect(existsSync(join(repo, ".factory"))).toBe(false);
});

test("the written .factory/ passes the schema check", () => {
  const repo = repoWithCommit();
  writeSetup({ repo, name: "acme-api", slug: "acme/api", basics: {} });
  expect(validateDir(join(repo, ".factory")).filter((r) => r.errors.length)).toEqual([]);
});

test("the CLI: setup lists steps, skip and unskip are stored, status.json carries the checklist until .factory/ exists", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], (s) => out.push(s));
  const repo = repoWithCommit();
  run("init", "--repo", "acme/api", "--path", repo);
  out.length = 0;
  run("setup", "--json");
  const steps = JSON.parse(out[0]).steps;
  expect(steps.map((s: any) => s.id)).toEqual(["herdr-core", "gh", "harness", "trust", "service", "queue", "basics", "factory-dir"]);
  expect(steps.find((s: any) => s.id === "service").status).toBe("missing"); // the sandbox has no launchd service

  run("setup", "skip", "service");
  const db = open(paths("acme-api").db);
  let status = buildStatus(db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.setup!.steps.find((s) => s.id === "service")!.status).toBe("skipped");
  expect(() => run("setup", "skip", "nonsense")).toThrow('no setup step "nonsense"');
  run("setup", "unskip", "service");
  expect(buildStatus(db).setup!.steps.find((s) => s.id === "service")!.status).toBe("missing");

  // Written, the checklist is done: .factory/ is in the checkout, and stays there.
  run("setup", "write", "--max-running", "2");
  expect(out.at(-1)).toContain(".git/info/exclude");
  status = buildStatus(db);
  expect(status.setup).toBeUndefined();
  db.close();
});

// ---- flow-stack migration, from fixtures/flow-stack (the shapes of real ~/.flow-stack and .flow/ files)

const FIX = join(import.meta.dir, "../fixtures/flow-stack");
function flowWorld() {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(join(FIX, "home"), home, { recursive: true });
  const repo = repoWithCommit();
  cpSync(join(FIX, "flow"), join(repo, ".flow"), { recursive: true });
  main(["init", "--repo", "acme/api", "--path", repo, "--name", "acme-api"], () => {});
  return { home, repo, db: open(paths("acme-api").db), dir: paths("acme-api").dir };
}
const snapshot = (root: string): Record<string, string> => {
  const all: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : (all[join(d, e.name)] = readFileSync(join(d, e.name), "utf8")); };
  walk(root);
  return all;
};

test("migration copies past tasks as merged tickets with their .md files, and their decisions", () => {
  const { home, repo, db, dir } = flowWorld();
  const log: string[] = [];
  migrateFlowStack(db, { home, repo, dir, blueprints: ["feature", "chore"], dryRun: false, now: "2026-11-21T10:00:00Z", log: (s) => log.push(s) });
  const tickets = db.query("SELECT id, title, state, blueprint FROM tickets ORDER BY id").all();
  // The task still marked ACTIVE is not a past task.
  expect(tickets).toEqual([
    { id: 10000, title: "Dates like 2026-1-5 parse again", state: "merged", blueprint: "feature" }, // "bug" isn't a blueprint here
    { id: 10001, title: "Login attempts are limited to 5 a minute per IP", state: "merged", blueprint: "feature" },
  ]);
  const decisions = db.query("SELECT who, what, why, at FROM decisions WHERE ticket = 10001 AND who != 'daemon' ORDER BY id").all();
  expect(decisions).toEqual([
    { who: "agent", what: "use a sliding window", why: "fixed windows allow bursts · evidence: docs/limits.md", at: "2026-10-04T10:00:00.000Z" },
    { who: "human", what: "limit is 5 per minute", why: "matches the issue", at: "2026-10-04T10:05:00.000Z" },
  ]);
  const folder = join(dir, "tickets", "10001");
  expect(readdirSync(folder).sort()).toEqual(["DECISIONS.tsv", "EVIDENCE-flow.md", "INTENT.md", "SLICES.md", "TRACE.md"]);
  expect(readFileSync(join(folder, "INTENT.md"), "utf8")).toContain("Login attempts");
  expect(validateStatus(buildStatus(db))).toEqual([]);
  // Running it again imports nothing twice.
  log.length = 0;
  migrateFlowStack(db, { home, repo, dir, blueprints: [], dryRun: false, now: "2026-11-21T10:00:00Z", log: (s) => log.push(s) });
  expect((db.query("SELECT COUNT(*) AS n FROM tickets").get() as any).n).toBe(2);
  expect(log.join("\n")).toContain("already imported as #10001");
});

test("migration prints proposals and the lessons count, never edits factory.yaml, and changes nothing in flow-stack", () => {
  const { home, repo, db, dir } = flowWorld();
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory", "factory.yaml"), "name: acme-api\n");
  const flowBefore = { ...snapshot(join(home, ".flow-stack")), ...snapshot(join(repo, ".flow")) };
  const log: string[] = [];
  migrateFlowStack(db, { home, repo, dir, blueprints: [], dryRun: false, now: "2026-11-21T10:00:00Z", log: (s) => log.push(s) });
  const text = log.join("\n");
  expect(text).toContain("lessons: 3 found; added 3 to the lesson store");
  expect(db.query("SELECT area, text, source FROM lessons ORDER BY id").all()).toEqual([
    { area: "**", text: "tests need TZ=UTC", source: "flow-stack" },
    { area: "**", text: "the login route is rate limited per IP, not per user", source: "flow-stack" },
    { area: "**", text: "run `npm run build` before the raycast dev server", source: "flow-stack" },
  ]);
  expect(text).toContain("max_running: 2");
  expect(text).toContain("model: sonnet");
  expect(text).toContain("Never push, merge, deploy, or publish without asking.");
  expect(text).toContain("prefer early returns");
  expect(text).toContain("feature: 3 tasks, avg $ error +60%");
  expect(text).toContain("budget.headroom: 1.6");
  expect(readFileSync(join(repo, ".factory", "factory.yaml"), "utf8")).toBe("name: acme-api\n");
  expect({ ...snapshot(join(home, ".flow-stack")), ...snapshot(join(repo, ".flow")) }).toEqual(flowBefore);
  // Again: every lesson is already in the store.
  log.length = 0;
  migrateFlowStack(db, { home, repo, dir, blueprints: [], dryRun: false, now: "2026-11-21T10:00:00Z", log: (s) => log.push(s) });
  expect(log.join("\n")).toContain("lessons: 3 found; added 0 to the lesson store, 3 already there");
  expect((db.query("SELECT COUNT(*) AS n FROM lessons").get() as any).n).toBe(3);
});

test("--dry-run reports and changes nothing", () => {
  const { home, repo, db, dir } = flowWorld();
  const log: string[] = [];
  migrateFlowStack(db, { home, repo, dir, blueprints: [], dryRun: true, now: "2026-11-21T10:00:00Z", log: (s) => log.push(s) });
  expect(log.join("\n")).toContain("would import rate-limit-login as merged #10001");
  expect(log.at(-1)).toContain("dry run");
  expect((db.query("SELECT COUNT(*) AS n FROM tickets").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM decisions").get() as any).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM lessons").get() as any).n).toBe(0);
  expect(log.join("\n")).toContain("would add 3 to the lesson store");
  expect(existsSync(join(dir, "tickets"))).toBe(false);
});

test("the CLI migrates from $HOME, and says so when there's nothing to find", () => {
  const { home, repo } = flowWorld();
  const was = process.env.HOME;
  const out: string[] = [];
  try {
    process.env.HOME = home;
    main(["migrate", "flow-stack", "--dry-run", "--name", "acme-api"], (s) => out.push(s));
    expect(out.join("\n")).toContain("would import fix-date-parse");
    out.length = 0;
    process.env.HOME = mkdtempSync(join(tmpdir(), "empty-"));
    const bare = repoWithCommit();
    main(["init", "--repo", "x/y", "--path", bare, "--name", "bare"], () => {});
    main(["migrate", "flow-stack", "--name", "bare"], (s) => out.push(s));
    expect(out[0]).toContain("nothing to migrate");
    expect(() => main(["migrate", "elsewhere", "--name", "bare"], () => {})).toThrow("usage: factory migrate flow-stack");
  } finally {
    process.env.HOME = was;
  }
  expect(repo).toBeTruthy();
});

test("the profile and calibration parsers read flow-stack's shapes", () => {
  const p = parseProfile(readFileSync(join(FIX, "home/.flow-stack/profile.md"), "utf8"));
  expect(p.front).toMatchObject({ max_parallel_agents: "2", build_model: "sonnet", handoff_at_context_pct: "60" });
  expect(p.rules).toHaveLength(2);
  expect(p.taste).toHaveLength(3);
  expect(p.calibration).toEqual([{ type: "feature", tasks: "3", dollars: "+60%" }, { type: "bug", tasks: "2", dollars: "+15%" }]);
  expect(errRatio("+60%")).toBe(1.6);
  expect(errRatio("1.5x")).toBe(1.5);
  expect(errRatio("a lot")).toBeNull();
});

test("trust marks the factory's folders in Claude Code's config, keeps what's there, and a parent's trust covers a child", () => {
  const cfg = join(mkdtempSync(join(tmpdir(), "claude-")), ".claude.json");
  writeFileSync(cfg, JSON.stringify({ theme: "dark", projects: { "/w/trusted": { hasTrustDialogAccepted: true, allowedTools: ["x"] } } }));
  expect(isTrusted("/f/acme/tickets/1", cfg)).toBe(false);
  expect(trust(["/f", "/w/trusted"], cfg)).toEqual(["/f"]); // /w/trusted was already
  const after = JSON.parse(readFileSync(cfg, "utf8"));
  expect(after.theme).toBe("dark");
  expect(after.projects["/w/trusted"]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["x"] });
  expect(after.projects["/f"].hasTrustDialogAccepted).toBe(true);
  expect(isTrusted("/f/acme/tickets/1", cfg)).toBe(true);
  expect(trust(["/f"], cfg)).toEqual([]); // nothing to add, nothing written
  // The step: missing until trusted, and its fix is the command.
  const repo = mkdtempSync(join(tmpdir(), "tr-"));
  expect(setupSteps({ repo, probe: probe({ trusted: false }) }).find((s) => s.id === "trust")).toMatchObject({ status: "missing", fix: "factory setup trust" });
});

test("setup write's quality floor is the repo's own test command", () => {
  const repo = mkdtempSync(join(tmpdir(), "fl-"));
  expect(detectFloor(repo)).toEqual([]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  expect(detectFloor(repo)).toEqual(["npm test"]);
  writeFileSync(join(repo, "bun.lock"), "");
  expect(detectFloor(repo)).toEqual(["bun run test"]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
  expect(detectFloor(repo)).toEqual([]);
});
