import { agentlessPr } from "./test-env.ts";
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, tryPr, type Run } from "./runner.ts";
import { excludeFactory, keepLocal, LOCAL_REASON, trackedFactory, UNTRACK } from "./local.ts";
import { buildStatus } from "./status.ts";
import { main, paths } from "./cli.ts";
import { validateStatus } from "../lib/status.js";

const GOOD_PR = "Rate-limits login per user; nothing else changes.\n\n**What changed:** middleware.\n**Why:** brute force.\n**How it was verified:** 14 tests.\n**Risk:** low.\n";
const git = (cwd: string, ...a: string[]) => sh(["git", "-C", cwd, ...a]).out;

function gitRepo(origin?: string) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) git(repo, ...c);
  if (origin) git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, "app.ts"), "export {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// The factory's files in the checkout only, never committed: the way setup writes them now.
function localFactory(repo: string) {
  keepLocal(repo);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true }); agentlessPr(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [evidence, quality_floor, template, budget]\n');
}

function world() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = gitRepo(origin);
  localFactory(repo);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const gh: string[][] = [];
  const hc: string[][] = [];
  const run: Run = (argv, cwd) =>
    argv[0] === "hc" ? (hc.push(argv), { code: 0, out: '{"address":"t1"}' })
    : argv[0] === "gh" ? (gh.push(argv), { code: 0, out: "https://github.com/me/demo/pull/42\n" })
    : sh(argv, cwd);
  return { origin, repo, dir, db, gh, hc, run, ticket: (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any };
}

test("adopting a repo puts /.factory/ in the common .git/info/exclude once, and writes no .gitignore", () => {
  const repo = gitRepo();
  expect(excludeFactory(repo)).toBe(true);
  expect(excludeFactory(repo)).toBe(false);
  expect(keepLocal(repo)).toEqual({ excluded: false, tracked: [] });
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === "/.factory/")).toHaveLength(1);
  // Every worktree shares it: from one, the exclude file is the checkout's, and .factory/ there is ignored too.
  const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "wt");
  git(repo, "worktree", "add", "-q", "-b", "side", wt);
  expect(excludeFactory(wt)).toBe(false);
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\n");
  mkdirSync(join(wt, ".factory"));
  writeFileSync(join(wt, ".factory/factory.yaml"), "name: t\n");
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(wt, "status", "--porcelain")).toBe("");
  git(wt, "add", "-A");
  expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
  expect(existsSync(join(repo, ".gitignore"))).toBe(false);
});

test("a repo that already tracks .factory/ is never changed in git: its files go skip-worktree, and Home and validate say how to stop", () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "track the factory");
  const head = git(repo, "rev-parse", "HEAD");
  expect(keepLocal(repo)).toEqual({ excluded: true, tracked: [".factory/factory.yaml"] });
  expect(git(repo, "ls-files", "-v", ".factory")).toBe("S .factory/factory.yaml");
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nmax_running: 2\n"); // a local edit
  expect(git(repo, "status", "--porcelain")).toBe("");
  git(repo, "add", "-A");
  expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  expect(git(repo, "rev-parse", "HEAD")).toBe(head); // nothing committed for you
  expect(trackedFactory(repo)).toEqual([".factory/factory.yaml"]); // still tracked: removing it is yours to do

  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const out: string[] = [];
  main(["init", "--repo", "acme/api", "--path", repo, "--name", "t"], (s) => out.push(s));
  expect(out.join("\n")).toContain(`acme/api tracks .factory/ in git (1 file)`);
  const db = open(paths("t").db);
  const s = buildStatus(db);
  expect(validateStatus(s)).toEqual([]);
  expect(s.tracked_factory).toEqual([{ repo: "acme/api", files: 1, fix: UNTRACK }]);
  db.close();
  out.length = 0;
  main(["validate", "--json", "--name", "t"], (x) => out.push(x));
  expect(JSON.parse(out[0]).find((r: any) => r.path === "acme/api .factory/").warnings[0]).toContain(`Run this yourself in the checkout: ${UNTRACK}`);
});

test("a ticket's worktree has no .factory/, and its stage still gets the checkout's blueprint, agent and prompt", () => {
  const w = world();
  writeFileSync(join(w.repo, ".factory/agents/builder.md"), "---\nrole: build\nharness: echo\n---\nZQ-LOCAL-BUILDER: build it.\n");
  writeFileSync(join(w.repo, ".factory/prompts/stage.md"), "ZQ-LOCAL-PROMPT #{{ticket.id}} {{stage}}\n\n{{agent.prompt}}\n");
  w.db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(w.db, { dir: w.dir, repo: w.repo, id: 7, run: w.run });
  const t = w.ticket(7);
  expect(existsSync(join(t.worktree, ".factory"))).toBe(false); // .factory/ isn't in git
  expect(t.stage).toBe("implement"); // the chore blueprint's first stage, from the checkout
  const brief = w.hc.find((a) => a[1] === "run")!.at(-1)!;
  expect(brief).toContain("ZQ-LOCAL-PROMPT #7 implement");
  expect(brief).toContain("ZQ-LOCAL-BUILDER: build it.");
  // factory validate, run in the worktree as an agent would, checks the checkout's .factory/.
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  main(["init", "--repo", "acme/api", "--path", w.repo, "--name", "t"], () => {});
  const cwd = process.cwd();
  process.chdir(t.worktree);
  try {
    const out: string[] = [];
    main(["validate", "--json", "--name", "t"], (x) => out.push(x));
    expect(JSON.parse(out[0]).map((r: any) => r.path)).toContain("blueprints/chore.yaml");
  } finally { process.chdir(cwd); }
});

test("a ticket branch that commits to .factory/ never reaches a PR; taken off, the PR opens", () => {
  const w = world();
  w.db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(w.db, { dir: w.dir, repo: w.repo, id: 7, run: w.run });
  const wt = w.ticket(7).worktree;
  writeFileSync(join(wt, "app.ts"), "export const x = 1;\n");
  mkdirSync(join(wt, ".factory/agents"), { recursive: true });
  writeFileSync(join(wt, ".factory/agents/builder.md"), "---\nrole: build\n---\nBuild.\n");
  git(wt, "add", "-A"); // the exclude keeps .factory/ out
  expect(git(wt, "diff", "--cached", "--name-only")).toBe("app.ts");
  git(wt, "add", "-f", ".factory"); // an agent forcing it in
  git(wt, "commit", "-q", "-m", "work");
  mkdirSync(join(w.dir, "tickets/7"), { recursive: true });
  writeFileSync(join(w.dir, "tickets/7/PR.md"), GOOD_PR);
  expect(advance(w.db, { dir: w.dir, repo: w.repo, id: 7, run: w.run })).toMatchObject({ stage: "pr", waiting: true });
  expect(w.ticket(7).detail).toBe(`${LOCAL_REASON}: .factory/agents/builder.md; take those commits off the branch`);
  expect(w.gh).toEqual([]);
  expect(git(w.origin, "branch", "--list")).toBe(""); // nothing pushed
  expect(tryPr(w.db, { dir: w.dir, repo: w.repo, id: 7, run: w.run })).toMatchObject({ waiting: true });
  expect((w.db.query("SELECT COUNT(*) AS n FROM decisions WHERE what = 'no PR: the branch changes .factory/'").get() as any).n).toBe(1); // said once
  git(wt, "rm", "-rq", "--cached", ".factory");
  git(wt, "commit", "-q", "-m", "keep .factory/ local");
  w.db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (7, 'true', 'PASS', 'passed', ?)").run(new Date(Date.now() + 1000).toISOString());
  expect(tryPr(w.db, { dir: w.dir, repo: w.repo, id: 7, run: w.run })).toMatchObject({ pr: 42 });
  expect(git(w.origin, "ls-tree", "-r", "--name-only", "factory/7-rate-limit-login")).not.toContain(".factory");
});

test("a folder inside another repo is left alone: no skip-worktree, no exclude line in the enclosing repo", () => {
  const outer = gitRepo();
  mkdirSync(join(outer, "fixtures/demo/.factory"), { recursive: true });
  writeFileSync(join(outer, "fixtures/demo/.factory/factory.yaml"), "name: demo\n");
  git(outer, "add", ".");
  git(outer, "commit", "-q", "-m", "fixture");
  const inner = join(outer, "fixtures/demo");
  expect(keepLocal(inner)).toEqual({ excluded: false, tracked: [] });
  expect(sh(["git", "-C", outer, "ls-files", "-v", "fixtures"]).out.trim()).toBe("H fixtures/demo/.factory/factory.yaml");
  expect(readFileSync(join(outer, ".git/info/exclude"), "utf8")).not.toContain("/.factory/");
});
