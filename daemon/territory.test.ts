// The maintainer's whole territory (maintainer.ts): each kind of request, the repo it works
// in, and what its factory check holds it to. Temp repos and FACTORY_HOME; gh, hc stubbed.
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRepos, open, setRepo } from "./db.ts";
import { advance, mergeTicket, sh, startTicket, type Run } from "./runner.ts";
import { applyMerged, guessKind, KIND_GUIDE, proposeFactoryAgent, request, requestKind } from "./maintainer.ts";

const now = new Date(Date.now() + 60_000).toISOString();
const PR = "Changes the factory.\n\n## What changed\n- x\n## Why\nx\n## How it was verified\nx\n## Risk\nLow.\n";

function gitRepo(prefix: string, files: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), text); }
  const origin = mkdtempSync(join(tmpdir(), `${prefix}origin-`));
  sh(["git", "init", "-q", "--bare", origin]);
  sh(["git", "-C", repo, "remote", "add", "origin", origin]);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  sh(["git", "-C", repo, "push", "-q", "origin", "main"]);
  return repo;
}

function setup() {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const repo = gitRepo("api-");
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nrepos: [acme/api, acme/web]\nquality_floor: [\"true\"]\ngrooming:\n  agent: triager\n  blueprints: [feature, bugfix, chore]\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "factory"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  let term = 0;
  const run: Run = (argv, cwd) => {
    calls.push(argv);
    if (argv[0] === "hc") return { code: 0, out: `{"address":"t${++term}"}` };
    if (argv[0] === "gh") return argv[1] === "pr" && argv[2] === "create" ? { code: 0, out: "https://github.com/acme/x/pull/9" } : argv[1] === "pr" && ["ready", "merge"].includes(argv[2]) ? { code: 0, out: "" } : { code: 1, out: "gh is stubbed" };
    if (argv.includes("scripts/check.sh")) return { code: 0, out: "ok" }; // the app's own check, stubbed
    return sh(argv, cwd);
  };
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  const commit = (wt: string, file: string, text: string) => {
    mkdirSync(join(wt, file, ".."), { recursive: true });
    writeFileSync(join(wt, file), text);
    sh(["git", "-C", wt, "add", "-A"]);
    sh(["git", "-C", wt, "commit", "-q", "-m", "change"]);
  };
  const finish = (id: number) => {
    writeFileSync(join(dir, "tickets", String(id), "PR.md"), PR);
    return advance(db, { dir, repo, id, run, now });
  };
  const evidence = (id: number) => db.query("SELECT check_name, result, detail FROM evidence WHERE ticket = ? ORDER BY id").all(id) as { check_name: string; result: string; detail: string }[];
  const last = (id: number, name: string) => evidence(id).filter((e) => e.check_name === name).at(-1);
  return { db, dir, repo, run, calls, ticket, commit, finish, evidence, last };
}

test("a request's kind comes from its words unless it names one, and REQUEST.md carries that kind's guidance", () => {
  expect(guessKind("A lane for database migrations with a human gate before the migration runs")).toBe("blueprint");
  expect(guessKind("Make the reviewer stricter in api")).toBe("agents");
  expect(guessKind("Clean up merged tickets")).toBe("cleanup");
  expect(guessKind("Use a warmer accent")).toBe("look");
  expect(guessKind("This page is hard to read")).toBe("look");
  expect(guessKind("Raise the day's budget to 60M")).toBe("config");
  const s = setup();
  const r = request(s.db, { text: "Add a lane for migrations", repo: "acme/api", run: s.run, now, dir: s.dir });
  expect(r.kind).toBe("blueprint");
  expect(requestKind(s.db, r.id)).toBe("blueprint");
  const md = readFileSync(join(s.dir, "tickets", String(r.id), "REQUEST.md"), "utf8");
  expect(md).toContain("Kind: blueprint");
  expect(md).toContain("factory dry-run .factory/blueprints/<name>.yaml");
  expect(md).toContain("grooming.blueprints");
  const c = request(s.db, { text: "Raise the budget", kind: "agents", repo: "acme/api", run: s.run, now });
  expect(requestKind(s.db, c.id)).toBe("agents");
  expect(() => request(s.db, { text: "x", kind: "colour" as any, repo: "acme/api", run: s.run, now })).toThrow(/one of config, blueprint, agents, cleanup, look/);
  for (const k of ["config", "blueprint", "agents", "cleanup", "look"] as const) expect(KIND_GUIDE[k].length).toBeGreaterThan(100);
});

test("a request for another of the factory's repos works there: its worktree, its .factory/agents checked, its PR", () => {
  const s = setup();
  const web = gitRepo("web-", { "app.ts": "export {};\n", ".factory/agents/reviewer.md": "---\nrole: review\n---\nReview the diff.\n" });
  setRepo(s.db, { slug: "acme/web", path: web, lead: false });
  expect(() => request(s.db, { text: "Make the reviewer stricter", target: "acme/docs", repo: "acme/api", run: s.run, now })).toThrow("acme/docs isn't one of this factory's repos (acme/api, acme/web)");
  const { id, repo } = request(s.db, { text: "Make the reviewer stricter", target: "acme/web", repo: "acme/api", run: s.run, now, dir: s.dir });
  expect(repo).toBe("acme/web");
  expect(readFileSync(join(s.dir, "tickets", String(id), "REQUEST.md"), "utf8")).toContain(`Repo: acme/web (${web})`);
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const wt = s.ticket(id).worktree;
  expect(s.ticket(id).repo).toBe("acme/web");
  expect(sh(["git", "-C", wt, "rev-parse", "--git-common-dir"]).out).toContain(web); // a worktree of acme/web
  // A broken agent fails the check in that repo's .factory/.
  s.commit(wt, ".factory/agents/reviewer.md", "---\nrol: review\n---\nBlock on every missing test.\n");
  s.finish(id);
  expect(s.last(id, "factory validate")).toMatchObject({ result: "FAIL" });
  expect(s.last(id, "factory validate")!.detail).toContain("agents/reviewer.md");
  expect(s.ticket(id).stage).toBe("maintain");
  s.commit(wt, ".factory/agents/reviewer.md", "---\nrole: review\n---\nBlock on every missing test.\n");
  s.finish(id);
  expect(s.last(id, "factory validate")).toMatchObject({ result: "PASS" });
  expect(s.last(id, "only .factory/")).toMatchObject({ result: "PASS", detail: "every change is in .factory/" });
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: 9 });
  const create = s.calls.find((c) => c[0] === "gh" && c[2] === "create")!;
  expect(create).not.toContain("--base");
});

test("a blueprint from a description must pass the schema, dry-run, and be one grooming can pick", () => {
  const s = setup();
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (50, 'Add a column', 'merged', 'feature', ?)").run(now);
  ["Plan", "Implement", "Verify", "PR", "Merge"].forEach((n, i) => s.db.query("INSERT INTO stages (ticket, name, started_at) VALUES (50, ?, ?)").run(n, `2026-11-20T0${i}:00:00Z`));
  const { id } = request(s.db, { text: "A lane for database migrations with a human gate before the migration runs", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const wt = s.ticket(id).worktree;
  const draft = "name: db-migration\nstart: plan\nstages:\n  plan: { agent: planner, output: PLAN.md, next: [implement] }\n  implement: { agent: builder, next: [verify] }\n  verify: { check: tests, next: [approve], on_fail: implement, max_retries: 2 }\n  approve: { gate: human, next: [migrate] }\n  migrate: { agent: migrator, next: [pr] }\n  pr: { requires: ready, output: PR.md, template: pr-readable, next: [merge] }\n  merge: { gate: human, next: [end] }\n";
  // Its new agent is missing: the schema check names it.
  s.commit(wt, ".factory/blueprints/db-migration.yaml", draft);
  s.finish(id);
  expect(s.last(id, "factory validate")!.detail).toContain("stages.migrate.agent: no file agents/migrator.md");
  // The agent is there, but nothing would ever start the blueprint.
  s.commit(wt, ".factory/agents/migrator.md", "---\nrole: build\n---\nRun the migration the plan names, then its down migration, then up again.\n");
  s.finish(id);
  expect(s.last(id, "factory validate")).toMatchObject({ result: "PASS" });
  expect(s.last(id, "new blueprint can start")).toMatchObject({ result: "FAIL" });
  expect(s.last(id, "new blueprint can start")!.detail).toContain("nothing starts db-migration: add it to grooming.blueprints");
  expect(s.ticket(id).stage).toBe("maintain");
  // It joins grooming.blueprints in the same PR: it passes, with its dry run on the PR.
  s.commit(wt, ".factory/factory.yaml", readFileSync(join(wt, ".factory/factory.yaml"), "utf8").replace("[feature, bugfix, chore]", "[feature, bugfix, chore, db-migration]"));
  s.finish(id);
  expect(s.last(id, "new blueprint can start")).toMatchObject({ result: "PASS", detail: "db-migration can be picked once this merges" });
  expect(s.last(id, "blueprint dry run")).toMatchObject({ result: "PASS" });
  expect(readFileSync(join(s.dir, "tickets", String(id), "DRYRUN.md"), "utf8")).toContain("db-migration");
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: 9 });
});

test("an edit to an existing blueprint isn't held to grooming.blueprints", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Give the address-review blueprint more retries", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const wt = s.ticket(id).worktree;
  const file = join(wt, ".factory/blueprints/address-review.yaml");
  s.commit(wt, ".factory/blueprints/address-review.yaml", readFileSync(file, "utf8"));
  writeFileSync(file, readFileSync(file, "utf8") + "\n# more retries\n");
  s.finish(id);
  expect(s.evidence(id).find((e) => e.check_name === "new blueprint can start")).toBeUndefined();
  expect(s.ticket(id).stage).toBe("merge");
});

test("a factory agent is edited as a copy in the ticket's folder, checked, and written with a backup only when merged", () => {
  const s = setup();
  const agents = join(process.env.FACTORY_HOME!, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "maintainer.md"), "---\nrole: maintain\n---\nMine.\n");
  const { id } = request(s.db, { text: "Make the maintainer say what it checked", kind: "agents", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const copy = proposeFactoryAgent(s.dir, id, "maintainer");
  expect(readFileSync(copy, "utf8")).toBe("---\nrole: maintain\n---\nMine.\n");
  expect(readFileSync(proposeFactoryAgent(s.dir, id, "learner"), "utf8")).toContain("The learner agent's prompt");
  rmSync(join(s.dir, "tickets", String(id), "FACTORY-AGENTS", "learner.md"));
  expect(() => proposeFactoryAgent(s.dir, id, "../x")).toThrow(/isn't an agent name/);
  writeFileSync(copy, "---\nrole: maintain\n---\nMine. Say in PR.md what you checked.\n");
  s.finish(id);
  expect(s.last(id, "factory agents")).toMatchObject({ result: "PASS" });
  expect(readFileSync(join(s.dir, "tickets", String(id), "FACTORY-AGENTS.md"), "utf8")).toContain("+Mine. Say in PR.md what you checked.");
  // Nothing in a repo changed: no PR; it waits for you at merge, and nothing is written meanwhile.
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: null });
  applyMerged(s.db, { dir: s.dir, run: s.run, now });
  expect(readFileSync(join(agents, "maintainer.md"), "utf8")).toBe("---\nrole: maintain\n---\nMine.\n");
  mergeTicket(s.db, { repo: s.repo, id, run: s.run, now, dir: s.dir });
  const log: string[] = [];
  applyMerged(s.db, { dir: s.dir, run: s.run, now, log: (l) => log.push(l) });
  expect(readFileSync(join(agents, "maintainer.md"), "utf8")).toContain("Say in PR.md what you checked.");
  const backups = readdirSync(agents).filter((f) => f.startsWith("maintainer.md.bak-"));
  expect(backups).toHaveLength(1);
  expect(log[0]).toContain("applied the factory agent maintainer");
  applyMerged(s.db, { dir: s.dir, run: s.run, now, log: (l) => log.push(l) });
  expect(log).toHaveLength(1); // once
});

test("a bad factory agent proposal fails the check and goes back to the maintainer", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Tune the learner agent", kind: "agents", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  writeFileSync(proposeFactoryAgent(s.dir, id, "learner"), "no header at all\n");
  s.finish(id);
  expect(s.last(id, "factory agents")).toMatchObject({ result: "FAIL" });
  expect(s.ticket(id).stage).toBe("maintain");
  expect(existsSync(join(process.env.FACTORY_HOME!, "agents", "learner.md"))).toBe(false);
});

test("a look request is a PR to the factory app's develop: its own worktree, only its look, its scripts/check.sh", () => {
  const s = setup();
  const app = gitRepo("app-", { "themes/factory.json": '{ "colors": { "accent": "#5fa8f0" } }\n', "daemon/cli.ts": "x\n", "scripts/check.sh": "exit 0\n" });
  sh(["git", "-C", app, "checkout", "-q", "-b", "develop"]);
  writeFileSync(join(app, "mods.md"), "on develop\n");
  sh(["git", "-C", app, "add", "."]);
  sh(["git", "-C", app, "commit", "-q", "-m", "develop"]);
  sh(["git", "-C", app, "push", "-q", "origin", "develop"]);
  sh(["git", "-C", app, "checkout", "-q", "main"]); // the service's checkout may be on any branch
  process.env.FACTORY_APP_REPO = app;
  try {
    expect(() => request(s.db, { text: "Use a warmer accent", target: "acme/api", repo: "acme/api", run: s.run, now })).toThrow(/takes no --repo/);
    const { id, kind } = request(s.db, { text: "Use a warmer accent", repo: "acme/api", run: s.run, now, dir: s.dir });
    expect(kind).toBe("look");
    // The app is a repo the ticket can work in, never one of the factory's.
    expect(listRepos(s.db).map((r) => r.slug)).toEqual(["acme/api"]);
    expect(s.ticket(id)).toMatchObject({ base: "origin/develop" });
    expect(readFileSync(join(s.dir, "tickets", String(id), "REQUEST.md"), "utf8")).toContain("the factory app's own repo");
    startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
    const wt = s.ticket(id).worktree;
    expect(existsSync(join(wt, "mods.md"))).toBe(true); // started from develop
    // A change outside its look goes back.
    s.commit(wt, "daemon/cli.ts", "y\n");
    s.finish(id);
    expect(s.last(id, "only the factory's look")).toMatchObject({ result: "FAIL", detail: "changed outside the app's look: daemon/cli.ts" });
    sh(["git", "-C", wt, "revert", "--no-edit", "HEAD"]);
    s.commit(wt, "themes/factory.json", '{ "colors": { "accent": "#e0915f" } }\n');
    s.finish(id);
    expect(s.last(id, "only the factory's look")).toMatchObject({ result: "PASS" });
    expect(s.last(id, "scripts/check.sh")).toMatchObject({ result: "PASS" });
    expect(s.calls.filter((c) => c.includes("scripts/check.sh")).length).toBe(2);
    const create = s.calls.find((c) => c[0] === "gh" && c[2] === "create")!;
    expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 2)).toEqual(["--base", "develop"]);
    expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: 9 });
    // It never deploys: nothing ran sync.sh or wrote into a Herdr home.
    expect(s.calls.some((c) => c.join(" ").includes("sync.sh"))).toBe(false);
  } finally {
    delete process.env.FACTORY_APP_REPO;
  }
});

test("the app's failing check sends the look change back", () => {
  const s = setup();
  const app = gitRepo("app-", { "themes/factory.json": "{}\n" });
  process.env.FACTORY_APP_REPO = app;
  try {
    const { id } = request(s.db, { text: "Darker header", kind: "look", repo: "acme/api", run: s.run, now, dir: s.dir });
    expect(s.ticket(id).base).toBeNull(); // no develop on origin: it starts from the checkout
    startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
    s.commit(s.ticket(id).worktree, "themes/factory.json", '{"x":1}\n');
    const failing: Run = (argv, cwd) => (argv.includes("scripts/check.sh") ? { code: 1, out: "herdr-app check: factory-home: bad token" } : s.run(argv, cwd));
    writeFileSync(join(s.dir, "tickets", String(id), "PR.md"), PR);
    advance(s.db, { dir: s.dir, repo: s.repo, id, run: failing, now });
    expect(s.last(id, "scripts/check.sh")).toMatchObject({ result: "FAIL", detail: "exit 1: herdr-app check: factory-home: bad token" });
    expect(s.ticket(id).stage).toBe("maintain");
  } finally {
    delete process.env.FACTORY_APP_REPO;
  }
});
