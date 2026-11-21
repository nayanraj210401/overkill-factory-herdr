import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { advance, finishPr, mergeTicket, setMergeOrder, sh, startTicket, ticketDiff, tryPr, type Run } from "./runner.ts";
import { chooseRepos, triageBrief } from "./groom.ts";
import { toCloud, toLocal } from "./cloud.ts";
import { watchPrs } from "./watch.ts";

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
  // When the PR is over, every worktree goes.
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

const GOOD_PR = "Shows times in the viewer's zone across the API and the web app.\n\n**What changed:** both.\n**Why:** support.\n**How it was verified:** tests.\n**Risk:** low.\n";

// Both repos with a bare origin to push to; a cross-repo chore ticket, started. gh is
// faked per repo (by the folder it runs in): api's PR is 5, web's is 6.
function crossFactory(crossCheck = 'test -d "$FACTORY_REPO_WEB" && test -d "$FACTORY_REPO_API"') {
  const api = git(mkdtempSync(join(tmpdir(), "api-")), true);
  writeFileSync(join(api, ".factory/factory.yaml"), `name: t\nrepos: [acme/api, acme/web]\nquality_floor: ["true"]\nready: [evidence, template]\ncross_check: '${crossCheck}'\n`);
  sh(["git", "-C", api, "commit", "-qam", "config"]);
  const web = git(mkdtempSync(join(tmpdir(), "web-")));
  const origins: Record<string, string> = {};
  for (const [name, dir] of [["api", api], ["web", web]]) {
    origins[name] = mkdtempSync(join(tmpdir(), `${name}-origin-`));
    sh(["git", "init", "-q", "--bare", origins[name]]);
    sh(["git", "-C", dir, "remote", "add", "origin", origins[name]]);
  }
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: api, lead: true });
  setRepo(db, { slug: "acme/web", path: web, lead: false });
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', 'chore', '2026-11-21T10:00:00Z')").run();
  const gh: { argv: string[]; repo: string; body?: string }[] = [];
  const fail: Record<string, string> = {}; // "web merge" → gh's error
  const views: Record<string, object> = {};
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: '{"address":"t1"}' };
    if (argv[0] !== "gh") return sh(argv, cwd);
    const repo = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1].split("/")[1] : argv[1] === "api" ? argv[2].split("/")[2] : cwd?.includes("web") ? "web" : "api";
    const body = argv.includes("--body-file") ? readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8") : undefined;
    gh.push({ argv, repo, body });
    if (fail[`${repo} ${argv[2]}`]) return { code: 1, out: fail[`${repo} ${argv[2]}`] };
    if (argv[2] === "list") return { code: 0, out: "" };
    if (argv[2] === "create") return { code: 0, out: `https://github.com/acme/${repo}/pull/${repo === "api" ? 5 : 6}\n` };
    if (argv[2] === "view") return { code: 0, out: JSON.stringify(views[repo] ?? { state: "OPEN", comments: [], reviews: [] }) };
    if (argv[1] === "api") return { code: 0, out: "[]" };
    return { code: 0, out: "" };
  };
  chooseRepos(db, { repo: api, id: 7, slugs: ["acme/web"], now: "2026-11-21T10:01:00Z" });
  db.query("UPDATE tickets SET state = 'queued' WHERE id = 7").run();
  startTicket(db, { dir, repo: api, id: 7, run, now: "2026-11-21T10:02:00Z" });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  const rows = () => db.query("SELECT repo, pr_number, pr_watched, merged_at, worktree FROM ticket_repos ORDER BY lead DESC").all() as any[];
  return { db, dir, api, web, origins, gh, fail, views, run, rows, ticket: () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any };
}

test("a cross-repo ticket's tests check runs the cross check with every worktree, and its PR waits for it", () => {
  const { db, dir, api, run, ticket } = crossFactory();
  expect(advance(db, { dir, repo: api, id: 7, run })).toMatchObject({ stage: "pr", waiting: true }); // implement → verify → pr
  const cross = db.query("SELECT result, detail FROM evidence WHERE check_name = 'cross_check'").get();
  expect(cross).toEqual({ result: "PASS", detail: "passed across acme/api, acme/web" });
  expect(ticket().detail).toBe("2 of 3 ready rules · template: PR.md is missing"); // evidence, template, cross_check

  const bad = crossFactory("false");
  expect(advance(bad.db, { dir: bad.dir, repo: bad.api, id: 7, run: bad.run })).toMatchObject({ stage: "implement" }); // on_fail
  expect(bad.db.query("SELECT result FROM evidence WHERE check_name = 'cross_check'").get()).toEqual({ result: "FAIL" });
});

test("the pr stage pushes every branch and opens a draft PR per repo, each naming the other", () => {
  const { db, dir, api, origins, gh, run, rows, ticket } = crossFactory();
  advance(db, { dir, repo: api, id: 7, run });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  expect(tryPr(db, { dir, repo: api, id: 7, run })).toMatchObject({ pr: 5, ready: true, stage: "merge" });
  expect(rows().map((r) => [r.repo, r.pr_number, r.pr_watched])).toEqual([["acme/api", 5, 1], ["acme/web", 6, 1]]);
  for (const o of Object.values(origins)) expect(sh(["git", "-C", o, "branch", "--list", "factory/7-wire-it"]).out).toContain("factory/7-wire-it");
  expect(gh.map((g) => `${g.repo} ${g.argv[2]}${g.argv[2] === "edit" ? ` ${g.argv[3]}` : ""}`)).toEqual(["api list", "api create", "web list", "web create", "api edit 5", "web edit 6"]);
  expect(gh.find((g) => g.argv[2] === "edit" && g.argv[3] === "5")!.body).toContain("**Part of one change across repos:** acme/web#6");
  expect(gh.find((g) => g.argv[2] === "edit" && g.argv[3] === "6")!.body).toContain("**Part of one change across repos:** acme/api#5");
  expect(gh.find((g) => g.argv[2] === "edit")!.body).toContain("- ✓ cross_check: the cross check passes on every repo's branch");
  expect(db.query("SELECT what, why FROM decisions WHERE who = 'daemon'").get()).toEqual({ what: "opened PR #5", why: "evidence pass, template pass, cross_check pass; with acme/web#6" });
  expect(ticket().state).toBe("ready");
});

test("m merges each repo's PR in merge order, stops at the first failure, and goes on from it next time", () => {
  const { db, dir, api, gh, fail, run, rows, ticket } = crossFactory();
  advance(db, { dir, repo: api, id: 7, run });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  tryPr(db, { dir, repo: api, id: 7, run });
  expect(() => setMergeOrder(db, { id: 7, slugs: ["acme/web"], now: "2026-11-21T11:00:00Z" })).toThrow("name each of #7's repos once: acme/api, acme/web");
  gh.length = 0;
  fail["api merge"] = "Pull request is not mergeable";
  const r = mergeTicket(db, { repo: api, id: 7, run, now: "2026-11-21T11:00:00Z" }); // web first: the lead goes last
  expect(r).toMatchObject({ merged: ["acme/web#6"], failed: "gh pr merge failed in acme/api: Pull request is not mergeable" });
  expect(rows().map((x) => [x.repo, x.merged_at])).toEqual([["acme/api", null], ["acme/web", "2026-11-21T11:00:00Z"]]);
  expect(ticket()).toMatchObject({ state: "ready", detail: "merged acme/web#6; gh pr merge failed in acme/api: Pull request is not mergeable" });
  delete fail["api merge"];
  gh.length = 0;
  expect(mergeTicket(db, { repo: api, id: 7, run, now: "2026-11-21T11:05:00Z" })).toMatchObject({ merged: ["acme/api#5"] });
  expect(gh.map((g) => `${g.repo} ${g.argv[2]}`)).toEqual(["api ready", "api merge"]); // web isn't merged twice
  expect(ticket().state).toBe("merged");
  expect(rows().every((x) => x.worktree == null)).toBe(true);
});

test("the merge order can put the lead first", () => {
  const { db, dir, api, gh, run } = crossFactory();
  advance(db, { dir, repo: api, id: 7, run });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  tryPr(db, { dir, repo: api, id: 7, run });
  setMergeOrder(db, { id: 7, slugs: ["acme/api", "acme/web"], now: "2026-11-21T11:00:00Z" });
  gh.length = 0;
  mergeTicket(db, { repo: api, id: 7, run, now: "2026-11-21T11:01:00Z" });
  expect(gh.filter((g) => g.argv[2] === "merge").map((g) => g.repo)).toEqual(["api", "web"]);
});

test("the watcher reads every repo's PR: one merged on GitHub is noted, comments go back once, all merged ends the ticket", () => {
  const { db, dir, api, views, run, rows, ticket } = crossFactory();
  advance(db, { dir, repo: api, id: 7, run });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  tryPr(db, { dir, repo: api, id: 7, run });
  views.web = { state: "MERGED", comments: [], reviews: [] };
  views.api = { state: "OPEN", reviews: [], comments: [{ id: 1, author: { login: "sam" }, body: "Use UTC in the export.", createdAt: "2026-11-21T11:00:00Z" }] };
  const events = watchPrs(db, { dir, repo: api, me: "pat", run, now: "2026-11-21T11:10:00Z" });
  expect(events).toEqual([{ id: 7, event: "acme/web#6 merged" }, { id: 7, event: "1 comment" }]);
  expect(rows().map((x) => [x.repo, x.merged_at])).toEqual([["acme/api", null], ["acme/web", "2026-11-21T11:10:00Z"]]);
  expect(ticket()).toMatchObject({ state: "running", stage: "implement" });
  expect(readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8")).toContain("## 1 review comment on acme/api#5 · 2026-11-21 11:10");
  // The fix lands, the PRs update, then api merges too: the ticket is merged.
  db.query("UPDATE tickets SET state = 'ready' WHERE id = 7").run();
  views.api = { state: "MERGED", comments: [], reviews: [] };
  expect(watchPrs(db, { dir, repo: api, me: "pat", run, now: "2026-11-21T12:00:00Z" })).toEqual([{ id: 7, event: "merged" }]);
  expect(ticket().state).toBe("merged");
});

test("⇧C pushes every repo's branch and CLOUD.md names the others; ⇧L fast-forwards each", () => {
  const { db, dir, api, web, origins, run, rows } = crossFactory();
  const [wtApi, wtWeb] = rows().map((r) => r.worktree);
  writeFileSync(join(wtWeb, "web.txt"), "local work\n");
  toCloud(db, { dir, repo: api, id: 7, run, now: "2026-11-21T10:20:00Z" });
  expect(sh(["git", "-C", origins.web, "log", "-1", "--format=%s", "factory/7-wire-it"]).out).toBe("factory: hand #7 to a cloud session at implement");
  expect(readFileSync(join(wtApi, ".factory-run/7/CLOUD.md"), "utf8")).toContain("This ticket changes 2 repos, each on the same branch `factory/7-wire-it`, already pushed: this one and `acme/web`.");
  // The cloud session pushes to web's branch.
  const elsewhere = mkdtempSync(join(tmpdir(), "cloud-"));
  sh(["git", "clone", "-q", "-b", "factory/7-wire-it", origins.web, elsewhere]);
  for (const c of [["config", "user.email", "c@c"], ["config", "user.name", "c"]]) sh(["git", "-C", elsewhere, ...c]);
  writeFileSync(join(elsewhere, "web.txt"), "cloud work\n");
  sh(["git", "-C", elsewhere, "commit", "-qam", "cloud: web"]);
  sh(["git", "-C", elsewhere, "push", "-q"]);
  toLocal(db, { dir, repo: api, id: 7, run, now: "2026-11-21T11:00:00Z" });
  expect(readFileSync(join(wtWeb, "web.txt"), "utf8")).toBe("cloud work\n");
  expect(basename(web)).toStartWith("web-");
});

test("d shows every repo's changes, each path under its repo's name", () => {
  const { db, dir, api, run, rows } = crossFactory();
  const [wtApi, wtWeb] = rows().map((r) => r.worktree);
  writeFileSync(join(wtApi, "api.txt"), "a\n");
  writeFileSync(join(wtWeb, "README.md"), "web, changed\n");
  sh(["git", "-C", wtApi, "add", "."]);
  const diff = ticketDiff(db, { repo: api, id: 7, run });
  expect(diff).toContain("diff --git a/api/api.txt b/api/api.txt");
  expect(diff).toContain("diff --git a/web/README.md b/web/README.md");
});
