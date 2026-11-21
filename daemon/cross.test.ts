import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { sh, startTicket, finishPr, type Run } from "./runner.ts";
import { chooseRepos, triageBrief } from "./groom.ts";
import { toCloud } from "./cloud.ts";

const realHome = process.env.HERDR_APP_HOME!;
const trees = process.env.FACTORY_WORKTREES!;
afterEach(() => { process.env.HERDR_APP_HOME = realHome; });

function git(dir: string, factory = false) {
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", dir, ...c]);
  if (factory) {
    cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(dir, ".factory"), { recursive: true });
    const yaml = join(dir, ".factory/factory.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^repos: .*$/m, "repos: [acme/api, acme/web]"));
  } else writeFileSync(join(dir, "README.md"), "web\n");
  sh(["git", "-C", dir, "add", "."]);
  sh(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

// A lead repo (acme/api, with .factory) and acme/web, both real git; a running Herdr is faked.
function factory() {
  const api = git(mkdtempSync(join(tmpdir(), "api-")), true);
  const web = git(mkdtempSync(join(tmpdir(), "web-")));
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: api, lead: true });
  setRepo(db, { slug: "acme/web", path: web, lead: false });
  db.query("INSERT INTO tickets (id, title, blueprint, state, updated_at) VALUES (7, 'Wire it', 'feature', 'grooming', '2026-11-21T10:00:00Z')").run();
  const home = mkdtempSync(join(tmpdir(), "app-"));
  writeFileSync(join(home, "herdr-app.sock"), "");
  process.env.HERDR_APP_HOME = home;
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => {
    if (argv[0] === "herdr-app") return (calls.push(argv), { code: 0, out: JSON.stringify({ space: "sp9", tab: "tb1", terminal: "t1" }) });
    if (argv[0] === "hc") return (calls.push(argv), { code: 0, out: "{}" });
    return sh(argv, cwd);
  };
  return { db, dir, api, web, calls, run };
}

test("grooming picks the repos a ticket works in: the lead always, and only repos factory.yaml lists", () => {
  const { db, api } = factory();
  const now = "2026-11-21T10:05:00Z";
  expect(chooseRepos(db, { repo: api, id: 7, slugs: ["acme/web"], now })).toEqual(["acme/api", "acme/web"]);
  expect(db.query("SELECT repo, lead FROM ticket_repos ORDER BY lead DESC").all()).toEqual([{ repo: "acme/api", lead: 1 }, { repo: "acme/web", lead: 0 }]);
  expect(() => chooseRepos(db, { repo: api, id: 7, slugs: ["acme/docs"], now })).toThrow("acme/docs isn't in factory.yaml's repos:");
  expect(chooseRepos(db, { repo: api, id: 7, slugs: ["acme/api"], now })).toEqual(["acme/api"]); // back to one repo
  expect(db.query("SELECT repo FROM ticket_repos").all()).toEqual([{ repo: "acme/api" }]);
  expect((db.query("SELECT what FROM decisions ORDER BY id DESC").get() as any).what).toBe("works in acme/api");
});

test("triage hears about the other repos only when there are some", () => {
  const o = { slug: "acme/api", repo: "/src/api", folder: "/f", blueprints: ["feature"], prompt: null };
  expect(triageBrief({ id: 7, title: "x" }, o)).not.toContain("factory repos");
  expect(triageBrief({ id: 7, title: "x" }, { ...o, others: [{ slug: "acme/web", path: "/src/web", lead: false }] }))
    .toContain("The factory's other repos: acme/web (/src/web). If it does, record every repo it touches, this one first: factory repos 7 acme/api <owner/name>…");
});

test("a cross-repo ticket starts with a worktree per repo on one branch, a tab for each other repo, and a brief naming them all", () => {
  const { db, dir, api, web, calls, run } = factory();
  chooseRepos(db, { repo: api, id: 7, slugs: ["acme/web"], now: "2026-11-21T10:05:00Z" });
  db.query("UPDATE tickets SET state = 'queued' WHERE id = 7").run();
  startTicket(db, { dir, repo: api, id: 7, run, now: "2026-11-21T10:10:00Z" });
  const rows = db.query("SELECT repo, worktree, branch FROM ticket_repos ORDER BY lead DESC").all() as any[];
  const wtApi = join(trees, basename(api), "factory-7-wire-it");
  const wtWeb = join(trees, basename(web), "factory-7-wire-it");
  expect(rows).toEqual([
    { repo: "acme/api", worktree: wtApi, branch: "factory/7-wire-it" },
    { repo: "acme/web", worktree: wtWeb, branch: "factory/7-wire-it" },
  ]);
  expect(sh(["git", "-C", wtWeb, "branch", "--show-current"]).out).toBe("factory/7-wire-it");
  const app = calls.filter((c) => c[0] === "herdr-app");
  expect(app.map((c) => c[2])).toEqual(["space.new", "tab.new"]);
  expect(JSON.parse(app[0][3]).folder).toBe(wtApi); // the agent runs in the lead's worktree
  expect(JSON.parse(app[1][3])).toEqual({ space: "sp9", folder: wtWeb, name: "web", focus: false });
  expect(JSON.parse(app[0][3]).argv.at(-1)).toContain(`It spans 2 repos, each checked out on the same branch: acme/api in ${wtApi} (here), acme/web in ${wtWeb}.`);
  // Not to the cloud yet; and when the PR is over, every worktree goes.
  expect(() => toCloud(db, { dir, repo: api, id: 7, run, now: "2026-11-21T10:20:00Z" })).toThrow("cross-repo tickets don't move to the cloud yet");
  setWork(db, 7, { pr_number: 42 });
  finishPr(db, { repo: api, id: 7, run, now: "2026-11-21T11:00:00Z", state: "closed", why: null });
  expect(existsSync(wtApi) || existsSync(wtWeb)).toBe(false);
  expect(db.query("SELECT worktree FROM ticket_repos").all()).toEqual([{ worktree: null }, { worktree: null }]);
});

test("a repo factory.yaml stopped listing refuses the start", () => {
  const { db, dir, api, run } = factory();
  chooseRepos(db, { repo: api, id: 7, slugs: ["acme/web"], now: "2026-11-21T10:05:00Z" });
  const yaml = join(api, ".factory/factory.yaml");
  writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^repos: .*$/m, "repos: [acme/api]"));
  expect(() => startTicket(db, { dir, repo: api, id: 7, run })).toThrow("acme/web isn't in factory.yaml's repos:");
});
