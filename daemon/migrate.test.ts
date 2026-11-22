// The flow-stack migration through the maintainer: setup offers it, accepting files one
// request, and `factory migrate flow-stack --propose <id>` writes the configuration into
// that request (account profile, factory.yaml budget and verify), safely again and again.
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, paths } from "./cli.ts";
import { open } from "./db.ts";
import { advance, runCheck, sh, startTicket, type Run } from "./runner.ts";
import { request } from "./maintainer.ts";
import { areaOf, migrateFlowStack, readLessons, withProfile } from "./migrate.ts";
import { findFlowStack, setupSteps, type Probe } from "./setup.ts";
import { validateAccount, validateDir } from "./validate.ts";

const FIX = join(import.meta.dir, "../fixtures/flow-stack");
const NOW = new Date(Date.now() + 60_000).toISOString();

const git = (cwd: string, ...a: string[]) => sh(["git", "-C", cwd, ...a]);
const LOGIN = "---\nid: auth.login\ntitle: Log in\nowns: src/auth/** src/routes/login.ts\nentries: api POST /api/session\nscenario: bash .claude/skills/verify-acme/scenarios/login.sh\nstatus: verified\n---\n# Log in\n";
const BILLING = "---\nid: billing\ntitle: Billing\nowns: src/billing/**\nscenario:\nstatus: unverified\n---\n# Billing\n";

// A repo with the factory's files, flow-stack's .flow/ (with a feature map and its verify
// driver), and a home with ~/.flow-stack/profile.md. `ignoreFlow` keeps .flow/ out of git.
function world(o: { ignoreFlow?: boolean; driver?: boolean } = {}) {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-home-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(join(FIX, "home"), home, { recursive: true });
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(repo, ...c);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  cpSync(join(FIX, "flow"), join(repo, ".flow"), { recursive: true });
  mkdirSync(join(repo, ".flow", "features"));
  writeFileSync(join(repo, ".flow", "features", "auth.login.md"), LOGIN);
  writeFileSync(join(repo, ".flow", "features", "billing.md"), BILLING);
  writeFileSync(join(repo, ".flow", "features", "README.md"), "# Features\n");
  mkdirSync(join(repo, ".claude", "skills", "verify-acme", "scenarios"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "verify-acme", "scenarios", "login.sh"), "echo login ok\n");
  writeFileSync(join(repo, ".flow", "lessons.md"), "# Lessons\n- tests need TZ=UTC · 2026-10-03\n- `src/auth/session.ts` must rotate the id after login · 2026-10-05\n");
  if (o.ignoreFlow) writeFileSync(join(repo, ".gitignore"), ".flow/\n");
  if (o.driver === false) writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  main(["init", "--repo", "acme/api", "--path", repo, "--name", "acme-api"], () => {});
  const db = open(paths("acme-api").db);
  const dir = paths("acme-api").dir;
  let term = 0;
  const bodies: string[] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: `{"address":"t${++term}"}` }
    : argv[0] === "gh" ? (argv[2] === "create" ? (bodies.push(readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8")), { code: 0, out: "https://github.com/acme/api/pull/7" }) : { code: 1, out: "gh is stubbed" })
    : argv[0] === "git" && argv.includes("push") ? { code: 0, out: "" } : sh(argv, cwd));
  const migrate = (id: number, log: string[] = []) =>
    migrateFlowStack(db, { home, repo, dir, blueprints: ["feature"], dryRun: false, now: NOW, log: (s) => log.push(s), propose: id, run: sh });
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  return { home, repo, db, dir, run, bodies, migrate, ticket };
}

function migrationTicket(w: ReturnType<typeof world>) {
  const { id } = request(w.db, { text: "Migrate flow-stack", repo: "acme/api", run: w.run, now: NOW, dir: w.dir });
  startTicket(w.db, { dir: w.dir, repo: w.repo, id, run: w.run, now: NOW });
  return id;
}

test("lessons are scoped by the paths they name, else load for every ticket", () => {
  expect(areaOf("`src/auth/session.ts` must rotate the id")).toBe("src/auth/");
  expect(areaOf("anything under src/billing/ needs a migration")).toBe("src/billing/");
  expect(areaOf("keep packages/api/** free of fetch")).toBe("packages/api/**");
  expect(areaOf("the docs folder docs/guides is generated")).toBe("docs/guides/");
  expect(areaOf("tests need TZ=UTC")).toBe("**");
  expect(areaOf("see https://example.com/a/b")).toBe("**");
  const repo = mkdtempSync(join(tmpdir(), "lessons-"));
  mkdirSync(join(repo, ".flow"));
  writeFileSync(join(repo, ".flow", "lessons.md"), "# Lessons\n\n## Rotate session ids in src/auth/\nbecause…\n\n## Dates are UTC\n");
  expect(readLessons(repo)).toEqual([{ text: "Rotate session ids in src/auth/", area: "src/auth/" }, { text: "Dates are UTC", area: "**" }]);
});

test("the profile goes into the account config's profile:, keeping the file and adding only new lines", () => {
  const start = "# mine\nplan: { pause_at: 85% }\n";
  const once = withProfile(start, ["never push to main"], ["small diffs"]);
  expect(once.startsWith(start)).toBe(true);
  expect(validateAccount(once)).toEqual([]);
  expect(Bun.YAML.parse(once)).toMatchObject({ plan: { pause_at: "85%" }, profile: { rules: ["never push to main"], taste: ["small diffs"] } });
  expect(withProfile(once, ["never push to main"], ["small diffs"])).toBe(once);
  const more = withProfile("profile: { rules: [be kind] }\naway: { review_rounds: 2 }\n", ["never push to main"], []);
  expect(Bun.YAML.parse(more)).toEqual({ profile: { rules: ["be kind", "never push to main"] }, away: { review_rounds: 2 } });
  expect(Bun.YAML.parse(withProfile("", ["a: b"], []))).toEqual({ profile: { rules: ["a: b"] } });
});

test("--propose writes the profile, calibration and feature map into the maintainer's request; the factory check passes; again changes nothing", () => {
  const w = world();
  const id = migrationTicket(w);
  const wt = w.ticket(id).worktree;
  const log: string[] = [];
  w.migrate(id, log);
  const folder = join(w.dir, "tickets", String(id));
  // Past tasks and lessons: imported now, as before; the scoped lesson has its area.
  expect((w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged'").get() as any).n).toBe(2);
  expect(w.db.query("SELECT area, text FROM lessons ORDER BY id").all()).toEqual([
    { area: "**", text: "tests need TZ=UTC" }, { area: "src/auth/", text: "`src/auth/session.ts` must rotate the id after login" },
  ]);
  // Rules and taste: the proposed account config, cleaned of flow-stack's dates and sources.
  const account = Bun.YAML.parse(readFileSync(join(folder, "ACCOUNT-CONFIG.yaml"), "utf8")) as any;
  expect(account.profile.rules).toEqual(["Never push, merge, deploy, or publish without asking.", "Never run destructive database operations without asking."]);
  expect(account.profile.taste).toEqual(["small functions, no comments that restate the code", "prefer early returns", "terse, answer first"]);
  expect(existsSync(join(process.env.FACTORY_HOME!, "config.yaml"))).toBe(false); // nothing applied before the PR merges
  // Calibration and the front matter: factory.yaml in the worktree; the feature map wired into verify.
  const f = Bun.YAML.parse(readFileSync(join(wt, ".factory", "factory.yaml"), "utf8")) as any;
  expect(f).toMatchObject({ max_running: 2, budget: { headroom: 1.6 }, verify: { features: ".flow/features" } });
  expect(validateDir(join(wt, ".factory")).filter((r) => r.errors.length)).toEqual([]);
  const md = readFileSync(join(folder, "MIGRATION.md"), "utf8");
  expect(md).toContain("`verify.features: .flow/features`");
  expect(md).toContain("Features with no scenario, so verify can't prove them yet: billing");
  expect(md).toContain("set `defaults.model`");
  expect(log.join("\n")).toContain("written for #");

  // Again: no lesson, task, rule or setting twice.
  const before = { account: readFileSync(join(folder, "ACCOUNT-CONFIG.yaml"), "utf8"), factory: readFileSync(join(wt, ".factory", "factory.yaml"), "utf8") };
  w.migrate(id);
  expect((w.db.query("SELECT COUNT(*) AS n FROM lessons").get() as any).n).toBe(2);
  expect((w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged'").get() as any).n).toBe(2);
  expect(readFileSync(join(folder, "ACCOUNT-CONFIG.yaml"), "utf8")).toBe(before.account);
  expect(readFileSync(join(wt, ".factory", "factory.yaml"), "utf8")).toBe(before.factory);

  // The maintainer commits and writes PR.md: the factory check passes, and the PR carries the report and the diff.
  git(wt, "add", "-A", ".factory");
  git(wt, "commit", "-q", "-m", "migrate flow-stack");
  writeFileSync(join(folder, "PR.md"), "Migrates flow-stack.\n\n## What changed\n- x\n## Why\nx\n## How it was verified\nx\n## Risk\nLow.\n");
  advance(w.db, { dir: w.dir, repo: w.repo, id, run: w.run, now: NOW });
  const ev = w.db.query("SELECT check_name, result FROM evidence WHERE ticket = ? ORDER BY id").all(id) as any[];
  expect(ev.filter((e) => e.result !== "PASS")).toEqual([]);
  expect(ev.map((e) => e.check_name)).toContain("account config");
  expect(w.bodies[0]).toContain("## Migrated from flow-stack");
  expect(w.bodies[0]).toContain("## The account config (~/.factory/config.yaml)");
  expect(w.bodies[0]).toContain('+    - "prefer early returns"');
});

test("a feature map outside git is copied under .factory/; scenarios whose driver isn't committed stay a to-do", () => {
  const w = world({ ignoreFlow: true });
  const id = migrationTicket(w);
  w.migrate(id);
  const wt = w.ticket(id).worktree;
  expect((Bun.YAML.parse(readFileSync(join(wt, ".factory", "factory.yaml"), "utf8")) as any).verify).toEqual({ features: ".factory/features" });
  expect(readFileSync(join(wt, ".factory", "features", "auth.login.md"), "utf8")).toBe(LOGIN);
  expect(validateDir(join(wt, ".factory")).filter((r) => r.errors.length)).toEqual([]);

  const v = world({ driver: false });
  const id2 = migrationTicket(v);
  v.migrate(id2);
  const f = Bun.YAML.parse(readFileSync(join(v.ticket(id2).worktree, ".factory", "factory.yaml"), "utf8")) as any;
  expect(f.verify).toBeUndefined();
  expect(readFileSync(join(v.dir, "tickets", String(id2), "MIGRATION.md"), "utf8"))
    .toContain("Not wired into verify: these scenarios use files that aren't committed, so a ticket's worktree can't run them: auth.login: .claude/skills/verify-acme/scenarios/login.sh");
});

test("verify.features: the tests check runs the scenario of each feature the ticket touched, as feat:<id>", () => {
  const w = world();
  const f = join(w.repo, ".factory", "factory.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^quality_floor:.*$/m, 'quality_floor: ["true"]') + "verify:\n  features: .flow/features\n");
  git(w.repo, "commit", "-qam", "wire verify");
  const { id } = request(w.db, { text: "x", repo: "acme/api", run: w.run, now: NOW }); // any ticket with a worktree
  startTicket(w.db, { dir: w.dir, repo: w.repo, id, run: w.run, now: NOW });
  const wt = w.ticket(id).worktree;
  const check = () => { runCheck(w.db, { id, repo: w.repo, worktree: wt, check: "tests", run: sh, now: NOW }); return w.db.query("SELECT check_name, result FROM evidence WHERE ticket = ? AND check_name LIKE 'feat:%' ORDER BY id").all(id); };
  writeFileSync(join(wt, "README.md"), "untouched features\n");
  expect(check()).toEqual([]);
  mkdirSync(join(wt, "src", "auth"), { recursive: true });
  writeFileSync(join(wt, "src", "auth", "session.ts"), "export {};\n");
  expect(check()).toEqual([{ check_name: "feat:auth.login", result: "PASS" }]);
  writeFileSync(join(wt, ".claude", "skills", "verify-acme", "scenarios", "login.sh"), "exit 3\n");
  expect(runCheck(w.db, { id, repo: w.repo, worktree: wt, check: "tests", run: sh, now: NOW })).toBe(false);
});

test("setup offers the migration when it finds flow-stack, and accepting files one maintainer request", () => {
  expect(findFlowStack({ home: null, repo: mkdtempSync(join(tmpdir(), "none-")), plugins: null })).toEqual([]);
  const plugins = mkdtempSync(join(tmpdir(), "plugins-"));
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "flow-stack@flow-stack": [{}] } }));
  const w = world();
  expect(findFlowStack({ home: w.home, repo: w.repo, plugins })).toEqual(["~/.flow-stack/profile.md", ".flow/", "the flow-stack plugin"]);

  const probe: Probe = { has: () => true, ghLoggedIn: () => true, service: () => "running", trusted: () => true, flowStack: () => [".flow/"] };
  const step = () => setupSteps({ repo: w.repo, probe, migration: (w.db.query("SELECT id, state FROM tickets WHERE id = (SELECT value FROM meta WHERE key = 'flow_migration_request')").get() as any) ?? null }).find((s) => s.id === "flow-stack");
  expect(step()).toMatchObject({ status: "missing", fix: "factory setup migrate", detail: "found .flow/" });
  expect(setupSteps({ repo: w.repo, probe: { ...probe, flowStack: () => [] } }).find((s) => s.id === "flow-stack")).toBeUndefined();

  // The CLI (the repo has .flow/, which the sandboxed probe sees).
  const out: string[] = [];
  main(["setup", "migrate", "--name", "acme-api"], (s) => out.push(s));
  const id = Number(out[0].match(/^#(\d+)/)![1]);
  expect(w.ticket(id)).toMatchObject({ blueprint: "factory", trigger_name: "maintainer" });
  const req = readFileSync(join(w.dir, "tickets", String(id), "REQUEST.md"), "utf8");
  expect(req).toContain("Migrate flow-stack into this factory");
  expect(req).toContain("factory migrate flow-stack --propose <this ticket's id>");
  expect(step()).toMatchObject({ status: "ok", detail: `#${id}, queued` });
  out.length = 0;
  main(["setup", "migrate", "--name", "acme-api"], (s) => out.push(s));
  expect(out[0]).toBe(`#${id} already asks the maintainer to migrate flow-stack (queued)`);
  // Closed without merging: offered again.
  w.db.query("UPDATE tickets SET state = 'closed' WHERE id = ?").run(id);
  expect(step()).toMatchObject({ status: "missing" });
  rmSync(join(w.repo, ".flow"), { recursive: true });
  expect(() => main(["setup", "migrate", "--name", "acme-api"], () => {})).toThrow(/no flow-stack here/);
});
