import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { pause, sh, startTicket, type Run } from "./runner.ts";
import { BRIEF_CAP, cloudBrief, parseResult, toCloud, toLocal } from "./cloud.ts";
import { keepLocal } from "./local.ts";

function setup(yaml = 'name: t\nquality_floor: ["npm test"]\nready: [evidence, template]\n') {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  // .factory/ as an adopted repo has it: in the checkout, excluded, never committed (local.ts).
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), yaml);
  keepLocal(repo);
  writeFileSync(join(repo, "README.md"), "# api\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  let n = 0;
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: `{"address":"t${++n}"}` }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/REVIEW.md"), "# REVIEW\n\n## Sent back by you\n\nUse 429.\n");
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  return { db, dir, repo, origin, run, calls, ticket };
}

test("⇧C commits the work with a handoff pack, pushes, and starts claude --cloud; the factory stops watching", () => {
  const { db, dir, repo, origin, run, calls, ticket } = setup();
  const wt = ticket().worktree;
  writeFileSync(join(wt, "limit.ts"), "export const MAX = 5;\n"); // work in progress
  const r = toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  expect(r).toMatchObject({ stage: "spec" });
  expect(calls.find((c) => c[1] === "kill")).toEqual(["hc", "kill", "t1"]); // the local agent stopped
  const launched = calls.find((c) => c.includes("--cloud"))!;
  const argv = launched.slice(launched.indexOf("claude"));
  expect(argv).toEqual(["claude", "--cloud", r.brief, "-n", "factory #7 Rate-limit login"]);
  expect(ticket()).toMatchObject({ state: "running", location: "cloud", detail: "in a cloud session" });
  // On the pushed branch: the work, the pack, the ticket's files.
  const show = (path: string) => sh(["git", "--git-dir", origin, "show", `factory/7-rate-limit-login:${path}`]).out;
  expect(show("limit.ts")).toBe("export const MAX = 5;");
  expect(show(".factory-run/7/REVIEW.md")).toContain("Use 429.");
  expect(show(".factory/factory.yaml")).toContain("does not exist"); // .factory/ never goes up
  const handoff = r.brief;
  expect(handoff).toContain("Stage now: **spec**, run by the `spec-writer` agent: follow its prompt below");
  expect(handoff).toContain("Stages left after it: plan → implement → verify → holdout → review → pr → merge");
  expect(handoff).toContain("Quality floor, run before you stop: `npm test`");
  expect(handoff).toContain("Never push to main");
  expect(() => pause(db, { id: 7, run })).toThrow("#7 is in the cloud; bring it back first");
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "x" })).toThrow("in the cloud already");
});

test("⇧L fast-forwards to the cloud's commits, imports RESULT.md, drops the pack, and resumes at the stage it reached", () => {
  const { db, dir, repo, origin, run, ticket } = setup();
  toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  // The cloud session: works on the branch, writes RESULT.md and PR.md, pushes.
  const cloud = mkdtempSync(join(tmpdir(), "cloud-"));
  sh(["git", "clone", "-q", "-b", "factory/7-rate-limit-login", origin, cloud]);
  writeFileSync(join(cloud, "limit.ts"), "export const MAX = 5; // per user id\n");
  writeFileSync(join(cloud, ".factory-run/7/RESULT.md"), "Stage: implement\n\n## Evidence\n- PASS npm test: 14 tests\n- FAIL C2 returns 429: still 403\n\n## Notes\nKeyed on user id.\n\n## Questions\n");
  writeFileSync(join(cloud, ".factory-run/7/PR.md"), "Rate-limits login.\n");
  for (const c of [["add", "-A"], ["-c", "user.email=c@c", "-c", "user.name=c", "commit", "-q", "-m", "cloud work"], ["push", "-q"]]) sh(["git", "-C", cloud, ...c]);

  expect(toLocal(db, { dir, repo, id: 7, run, now: "2026-11-21T12:00:00Z" })).toMatchObject({ stage: "implement" });
  const wt = ticket().worktree;
  expect(ticket()).toMatchObject({ location: "local", state: "running", stage: "implement" });
  expect(readFileSync(join(wt, "limit.ts"), "utf8")).toContain("per user id");
  expect(existsSync(join(wt, ".factory-run"))).toBe(false);
  expect(sh(["git", "-C", wt, "log", "-1", "--format=%s"]).out).toBe("factory: #7 back from the cloud");
  expect(readFileSync(join(dir, "tickets/7/HANDOFF.md"), "utf8")).toContain("Keyed on user id.");
  expect(readFileSync(join(dir, "tickets/7/PR.md"), "utf8")).toBe("Rate-limits login.\n");
  expect(db.query("SELECT check_name, result FROM evidence ORDER BY id").all()).toEqual([
    { check_name: "npm test", result: "PASS" }, { check_name: "C2 returns 429", result: "FAIL" }]);
  expect(() => toLocal(db, { dir, repo, id: 7, run, now: "x" })).toThrow("#7 isn't in the cloud");
});

test("questions from the cloud park the ticket; below the agreement bar, the pack says no pushbacks", () => {
  expect(parseResult("Stage: pr\n## Evidence\n## Questions\nWhich plans get it?\n").questions).toBe("Which plans get it?");
  const closed = setup('name: t\nready: [evidence]\naway: { min_agreement: 0.85 }\n');
  toCloud(closed.db, { dir: closed.dir, repo: closed.repo, id: 7, run: closed.run, now: "x" });
  const pack = (s: ReturnType<typeof setup>) => { const c = s.calls.find((x) => x.includes("--cloud"))!; return c[c.indexOf("--cloud") + 1]; };
  expect(pack(closed)).toContain("Don't push back on a review comment: the judge (claude-haiku-5-5) hasn't been checked against the person's verdicts yet");
  // The gate off: no such rule.
  const off = setup('name: t\nready: [evidence]\naway: { min_agreement: 0 }\n');
  toCloud(off.db, { dir: off.dir, repo: off.repo, id: 7, run: off.run, now: "x" });
  expect(pack(off)).not.toContain("push back");
});

// A run that fails git push while `down` is set, and records the order of pushes and kills.
function flaky() {
  const s = setup();
  const log: string[] = [];
  let down = true;
  const inner = s.run;
  const run: Run = (argv, cwd) => {
    if (argv.includes("push")) { log.push("push"); if (down) return { code: 1, out: "could not resolve host" }; }
    if (argv[0] === "hc" && argv[1] === "kill") log.push("kill");
    return inner(argv, cwd);
  };
  return { ...s, run, log, up: () => { down = false; } };
}

test("a failed push leaves the local agent running, the ticket local, and says why", () => {
  const { db, dir, repo, run, calls, ticket, log } = flaky();
  writeFileSync(join(ticket().worktree, "limit.ts"), "export const MAX = 5;\n");
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" })).toThrow("git push");
  expect(calls.some((c) => c[1] === "kill")).toBe(false);
  expect(log).toEqual(["push"]);
  expect(ticket()).toMatchObject({ state: "running", location: "local" });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE ticket = 7 AND ended_at IS NULL AND stage != 'cloud'").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE stage = 'cloud'").get()).toEqual({ n: 0 });
});

test("the local agent is stopped only after the push, and a retry after a failure works without a second WIP commit", () => {
  const { db, dir, repo, origin, run, ticket, log, up } = flaky();
  const wt = ticket().worktree;
  writeFileSync(join(wt, "limit.ts"), "export const MAX = 5;\n");
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" })).toThrow();
  up();
  log.length = 0;
  expect(toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:05:00Z" })).toMatchObject({ stage: "spec" });
  expect(log).toEqual(["push", "kill"]);
  expect(ticket()).toMatchObject({ location: "cloud" });
  const subjects = sh(["git", "--git-dir", origin, "log", "--format=%s", "factory/7-rate-limit-login"]).out.split("\n");
  expect(subjects.filter((x) => x.startsWith("factory: hand #7"))).toHaveLength(1);
});

test("a failed fast-forward on the way back keeps the cloud session and RESULT.md, and a retry works", () => {
  const { db, dir, repo, origin, run, ticket, calls } = setup();
  toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  const cloud = mkdtempSync(join(tmpdir(), "cloud-"));
  sh(["git", "clone", "-q", "-b", "factory/7-rate-limit-login", origin, cloud]);
  writeFileSync(join(cloud, ".factory-run/7/RESULT.md"), "Stage: implement\n\n## Evidence\n- PASS npm test: ok\n\n## Questions\n");
  for (const c of [["add", "-A"], ["-c", "user.email=c@c", "-c", "user.name=c", "commit", "-q", "-m", "cloud work"], ["push", "-q"]]) sh(["git", "-C", cloud, ...c]);
  let breakCommit = true;
  const bad: Run = (argv, cwd) => (breakCommit && argv.includes("commit") ? { code: 1, out: "boom" } : run(argv, cwd));
  const kills = calls.filter((c) => c[1] === "kill").length;
  expect(() => toLocal(db, { dir, repo, id: 7, run: bad, now: "2026-11-21T12:00:00Z" })).toThrow("git commit");
  expect(calls.filter((c) => c[1] === "kill")).toHaveLength(kills);
  expect(ticket().location).toBe("cloud");
  expect(existsSync(join(ticket().worktree, ".factory-run/7/RESULT.md"))).toBe(true);
  breakCommit = false;
  expect(toLocal(db, { dir, repo, id: 7, run, now: "2026-11-21T12:05:00Z" })).toMatchObject({ stage: "implement" });
  expect(ticket().location).toBe("local");
});

// Every file the pushed branch holds.
const pushed = (origin: string, branch: string) => sh(["git", "--git-dir", origin, "ls-tree", "-r", "--name-only", branch]).out.split("\n").filter(Boolean);

test("with no .factory/ on the branch, the brief carries every stage's agent prompt and the pack holds nothing from .factory/", () => {
  const { db, dir, repo, origin, run, ticket } = setup();
  // A .factory/ folder in the worktree too (left by hand, say): it stays behind.
  mkdirSync(join(ticket().worktree, ".factory/agents"), { recursive: true });
  writeFileSync(join(ticket().worktree, ".factory/agents/builder.md"), "stray\n");
  const r = toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  const files = pushed(origin, "factory/7-rate-limit-login");
  expect(files.filter((f) => f.startsWith(".factory/"))).toEqual([]);
  expect(files.filter((f) => f.startsWith(".factory-run/"))).toEqual([".factory-run/7/REVIEW.md"]); // the ticket's files only, no CLOUD.md
  // The prompts are the checkout's, word for word, under each stage.
  const prompt = (name: string) => readFileSync(join(repo, ".factory/agents", `${name}.md`), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const [stage, agent] of [["spec", "spec-writer"], ["plan", "planner"], ["implement", "builder"], ["review", "reviewer"]]) {
    expect(r.brief).toContain(`### ${stage}: the \`${agent}\` agent\n\n${prompt(agent)}`);
  }
  expect(r.brief).not.toMatch(/\.factory\/(agents|blueprints|prompts)|factory\.yaml/);
  expect(r.brief).toContain("Don't create `.factory/` here.");
});

test("a branch that committed to .factory/ stays local: nothing is pushed", () => {
  const { db, dir, repo, origin, run, calls, ticket } = setup();
  const wt = ticket().worktree;
  mkdirSync(join(wt, ".factory"), { recursive: true });
  writeFileSync(join(wt, ".factory/factory.yaml"), "name: changed\n");
  sh(["git", "-C", wt, "add", "-f", ".factory/factory.yaml"]);
  sh(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "tune"]);
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "x" })).toThrow("this ticket changed .factory/, which stays local (.factory/factory.yaml)");
  expect(sh(["git", "--git-dir", origin, "rev-parse", "--verify", "-q", "factory/7-rate-limit-login"]).code).not.toBe(0);
  expect(calls.some((c) => c[1] === "kill")).toBe(false);
  expect(ticket().location).toBe("local");
});

test("the brief's later prompts stop at the cap; the stage now keeps its own and the session stops before the first cut", () => {
  const stage = (s: string, prompt: string) => ({ stage: s, agent: `${s}-agent`, prompt, skills: s === "a" ? ["tdd"] : [] });
  const base = { id: 7, title: "T", branch: "b", blueprint: "feature", ready: ["evidence"], floor: [], hardStops: [], files: [] };
  const md = cloudBrief({ ...base, stages: [stage("a", "A".repeat(3000)), stage("b", "B".repeat(3000)), stage("c", "C".repeat(3000))], cap: 9000 });
  expect(md).toContain("A".repeat(3000));
  expect(md).toContain("Its skills (tdd) are on the person's machine, not in this session");
  expect(md).toContain("B".repeat(3000));
  expect(md).not.toContain("CCC");
  expect(md).toContain("The prompts for c didn't fit in this brief. Stop before c:");
  expect(md.length).toBeLessThan(9000 + 200);
  // One prompt bigger than the whole cap is cut short, never dropped.
  const huge = cloudBrief({ ...base, stages: [stage("a", "A".repeat(BRIEF_CAP * 2))] });
  expect(huge.length).toBeLessThanOrEqual(BRIEF_CAP);
  expect(huge).toContain("(The rest of this prompt didn't fit in the brief.)");
});
