// The flow-stack migration through the maintainer: setup offers it, accepting asks the
// maintainer, and `factory migrate flow-stack` writes the configuration in place (account
// profile, factory.yaml budget and verify), with backups, safely again and again.
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, paths } from "./cli.ts";
import { open } from "./db.ts";
import { runCheck, sh, startTicket, type Run } from "./runner.ts";
import { newTicket } from "./intake.ts";
import { areaOf, migrateFlowStack, readLessons, withProfile } from "./migrate.ts";
import { findFlowStack, migrationRequest, setupSteps, type Probe } from "./setup.ts";
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
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: `{"address":"t${++term}"}` } : argv[0] === "gh" ? { code: 1, out: "gh is stubbed" } : sh(argv, cwd));
  const migrate = (log: string[] = [], now = NOW) =>
    migrateFlowStack(db, { home, repo, dir, blueprints: ["feature"], dryRun: false, now, log: (s) => log.push(s), run: sh });
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  return { home, repo, db, dir, run, migrate, ticket };
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

test("the migration writes the profile, calibration and feature map in place, with backups; again changes nothing; nothing is committed", () => {
  const w = world();
  const accountFile = join(process.env.FACTORY_HOME!, "config.yaml");
  writeFileSync(accountFile, "# mine\nplan: { pause_at: 85% }\n");
  const head = git(w.repo, "rev-parse", "HEAD").out;
  const log: string[] = [];
  w.migrate(log);
  // Past tasks and lessons: imported, as before; the scoped lesson has its area.
  expect((w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged'").get() as any).n).toBe(2);
  expect(w.db.query("SELECT area, text FROM lessons ORDER BY id").all()).toEqual([
    { area: "**", text: "tests need TZ=UTC" }, { area: "src/auth/", text: "`src/auth/session.ts` must rotate the id after login" },
  ]);
  // Rules and taste: the account config itself, cleaned of flow-stack's dates and sources; the rest of it kept.
  const account = Bun.YAML.parse(readFileSync(accountFile, "utf8")) as any;
  expect(account.plan).toEqual({ pause_at: "85%" });
  expect(account.profile.rules).toEqual(["Never push, merge, deploy, or publish without asking.", "Never run destructive database operations without asking."]);
  expect(account.profile.taste).toEqual(["small functions, no comments that restate the code", "prefer early returns", "terse, answer first"]);
  // Calibration and the front matter: the lead checkout's own factory.yaml; the feature map wired into verify.
  const f = Bun.YAML.parse(readFileSync(join(w.repo, ".factory", "factory.yaml"), "utf8")) as any;
  expect(f).toMatchObject({ max_running: 2, budget: { headroom: 1.6 }, verify: { features: ".flow/features" } });
  expect(validateDir(join(w.repo, ".factory")).filter((r) => r.errors.length)).toEqual([]);
  // Each file it changed has its backup, once, as it was before.
  const md = readFileSync(join(w.dir, "MIGRATION.md"), "utf8");
  const backups = [...md.matchAll(/^- (\S+) \(factory restore/gm)].map((m) => m[1]);
  expect(backups.map((b) => b.endsWith("/config.yaml") || b.endsWith("/.factory/factory.yaml"))).toEqual([true, true]);
  expect(readFileSync(backups.find((b) => b.endsWith("/config.yaml"))!, "utf8")).toBe("# mine\nplan: { pause_at: 85% }\n");
  expect(readFileSync(backups.find((b) => b.endsWith("factory.yaml"))!, "utf8")).toContain("headroom: 1.5\n");
  expect(md).toContain("`verify.features: .flow/features`");
  expect(md).toContain("Features with no scenario, so verify can't prove them yet: billing");
  expect(md).toContain("set `defaults.model`");
  expect(log.join("\n")).toContain("written:");
  // Nothing committed, no ticket, no PR.
  expect(git(w.repo, "rev-parse", "HEAD").out).toBe(head);
  expect(w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE blueprint = 'factory'").get()).toEqual({ n: 0 });

  // Again: no lesson, task, rule or setting twice.
  const before = { account: readFileSync(accountFile, "utf8"), factory: readFileSync(join(w.repo, ".factory", "factory.yaml"), "utf8") };
  w.migrate([], new Date(Date.parse(NOW) + 1000).toISOString());
  expect((w.db.query("SELECT COUNT(*) AS n FROM lessons").get() as any).n).toBe(2);
  expect((w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'merged'").get() as any).n).toBe(2);
  expect(readFileSync(accountFile, "utf8")).toBe(before.account);
  expect(readFileSync(join(w.repo, ".factory", "factory.yaml"), "utf8")).toBe(before.factory);
});

test("a feature map outside git is copied under .factory/; scenarios whose driver isn't committed stay a to-do", () => {
  const w = world({ ignoreFlow: true });
  w.migrate();
  expect((Bun.YAML.parse(readFileSync(join(w.repo, ".factory", "factory.yaml"), "utf8")) as any).verify).toEqual({ features: ".factory/features" });
  expect(readFileSync(join(w.repo, ".factory", "features", "auth.login.md"), "utf8")).toBe(LOGIN);
  expect(validateDir(join(w.repo, ".factory")).filter((r) => r.errors.length)).toEqual([]);

  const v = world({ driver: false });
  v.migrate();
  const f = Bun.YAML.parse(readFileSync(join(v.repo, ".factory", "factory.yaml"), "utf8")) as any;
  expect(f.verify).toBeUndefined();
  expect(readFileSync(join(v.dir, "MIGRATION.md"), "utf8"))
    .toContain("Not wired into verify: these scenarios use files that aren't committed, so a ticket's worktree can't run them: auth.login: .claude/skills/verify-acme/scenarios/login.sh");
});

test("verify.features: the tests check runs the scenario of each feature the ticket touched, as feat:<id>", () => {
  const w = world();
  const f = join(w.repo, ".factory", "factory.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^quality_floor:.*$/m, 'quality_floor: ["true"]') + "verify:\n  features: .flow/features\n");
  git(w.repo, "commit", "-qam", "wire verify");
  const { id } = newTicket(w.db, { text: "x", repo: "acme/api", blueprint: "chore", run: w.run, now: NOW }); // any ticket with a worktree
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

test("setup offers the migration when it finds flow-stack; accepting asks the maintainer once, and a migration that ran is done", () => {
  expect(findFlowStack({ home: null, repo: mkdtempSync(join(tmpdir(), "none-")), plugins: null })).toEqual([]);
  const plugins = mkdtempSync(join(tmpdir(), "plugins-"));
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "flow-stack@flow-stack": [{}] } }));
  const w = world();
  expect(findFlowStack({ home: w.home, repo: w.repo, plugins })).toEqual(["~/.flow-stack/profile.md", ".flow/", "the flow-stack plugin"]);

  const probe: Probe = { has: () => true, ghLoggedIn: () => true, service: () => "running", trusted: () => true, flowStack: () => [".flow/"] };
  const step = () => setupSteps({ repo: w.repo, probe, migration: migrationRequest(w.db) }).find((s) => s.id === "flow-stack");
  expect(step()).toMatchObject({ status: "missing", fix: "factory setup migrate", detail: "found .flow/" });
  expect(setupSteps({ repo: w.repo, probe: { ...probe, flowStack: () => [] } }).find((s) => s.id === "flow-stack")).toBeUndefined();

  // The CLI (the repo has .flow/, which the sandboxed probe sees).
  const out: string[] = [];
  main(["setup", "migrate", "--name", "acme-api"], (s) => out.push(s));
  const id = Number(out[0].match(/^note #(\d+): the maintainer migrates flow-stack/)![1]);
  const note = w.db.query("SELECT to_agent, from_agent, text, why FROM asks WHERE id = ?").get(id) as any;
  expect(note).toMatchObject({ to_agent: "maintainer", from_agent: "you" });
  expect(note.text).toContain("Migrate flow-stack into this factory");
  expect(note.why).toContain("factory migrate flow-stack --name acme-api");
  expect(w.db.query("SELECT COUNT(*) AS n FROM tickets WHERE blueprint = 'factory'").get()).toEqual({ n: 0 });
  expect(step()).toMatchObject({ status: "missing", detail: `asked the maintainer: note #${id}` });
  out.length = 0;
  main(["setup", "migrate", "--name", "acme-api"], (s) => out.push(s));
  expect(out[0]).toBe(`note #${id} already asks the maintainer to migrate flow-stack`);
  // Handled without migrating: offered again. Migrated: done.
  w.db.query("UPDATE asks SET done_at = ? WHERE id = ?").run(NOW, id);
  expect(step()).toMatchObject({ status: "missing", detail: "found .flow/" });
  rmSync(join(w.repo, ".flow"), { recursive: true });
  expect(() => main(["setup", "migrate", "--name", "acme-api"], () => {})).toThrow(/no flow-stack here/);
  w.migrate(); // the profile alone still migrates
  expect(step()).toMatchObject({ status: "ok" });
  out.length = 0;
  main(["setup", "migrate", "--name", "acme-api"], (s) => out.push(s));
  expect(out[0]).toMatch(/^flow-stack is migrated already/);
});
