import { agentlessPr } from "./test-env.ts";
import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { watchPrs } from "./watch.ts";
import { importRoutine, LOG_BRANCH, LOG_FILE, parseLog, routineBrief, routineDue, routineSteps } from "./routine.ts";
import { setMeta } from "./db.ts";

const GOOD_PR = "Rate-limits login per user.\n\n**What changed:** x.\n**Why:** y.\n**How it was verified:** z.\n**Risk:** low.\n";

// A ticket whose PR #42 is ready and watched, as in rounds.test.ts; gh and hc are stubbed.
function setup(extra = "") {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true }); agentlessPr(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\nready: [template]\n${extra}`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let pr: any = { state: "OPEN", comments: [], reviews: [] };
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: '{"address":"t1"}' };
    if (argv[0] === "claude") return { code: 1, out: "no" };
    if (argv[0] !== "gh") return sh(argv, cwd);
    if (argv[1] === "api") return { code: 0, out: "[]" };
    if (argv[2] === "view") return { code: 0, out: JSON.stringify(pr) };
    return { code: 0, out: "https://github.com/acme/api/pull/42\n" };
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:10:00Z" });
  // What the cloud task does: append to the log on its own branch and push it.
  const pushLog = (lines: string[]) => {
    const cloud = mkdtempSync(join(tmpdir(), "cloud-"));
    sh(["git", "clone", "-q", origin, cloud]);
    const has = sh(["git", "-C", cloud, "checkout", "-q", LOG_BRANCH]).code === 0;
    if (!has) sh(["git", "-C", cloud, "checkout", "-q", "--orphan", LOG_BRANCH]);
    if (!has) sh(["git", "-C", cloud, "rm", "-rq", "--cached", "."]);
    mkdirSync(join(cloud, "routine"), { recursive: true });
    writeFileSync(join(cloud, LOG_FILE), lines.join("\n") + "\n");
    sh(["git", "-C", cloud, "add", LOG_FILE]);
    sh(["git", "-C", cloud, "-c", "user.email=c@c", "-c", "user.name=c", "commit", "-q", "-m", "log"]);
    expect(sh(["git", "-C", cloud, "push", "-q", "origin", LOG_BRANCH]).code).toBe(0);
  };
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  return { db, dir, repo, run, pushLog, ticket, setPr: (p: any) => { pr = p; } };
}

const entry = (o: Record<string, unknown>) => JSON.stringify({ run: "2026-11-22T02:07:00Z", repo: "acme/api", pr: 42, author: "sam", place: "src/limit.ts:12", at: "2026-11-22T01:00:00Z", reason: "", commit: null, replied: false, ...o });

test("the brief carries the watched PRs, the verdict rules, the away policy and the log format", () => {
  const s = setup('review: { pushbacks: 3 }\naway: { never: ["src/auth/**"], review_rounds: 2, min_agreement: 0.85 }\n');
  const md = routineBrief(s.db, { repo: s.repo, slug: "acme/api", me: "pat", now: "2026-11-22T00:00:00Z" });
  expect(md).toContain("- acme/api#42 (ticket #7, branch `factory/7-rate-limit-login`)");
  expect(md).toContain("You act as @pat on GitHub");
  expect(md).toContain("a thread that already has 3 pushbacks");
  expect(md).toContain("**Not allowed now** (away.min_agreement is set");
  expect(md).toContain("Run the quality floor before you push: `true`");
  expect(md).toContain("Never change files matching `src/auth/**`");
  expect(md).toContain("at most 2 runs with comments");
  expect(md).toContain(`"verdict":"fix|pushback|escalate"`);
  expect(md).toContain("Never open, close, merge, or mark a PR ready");
  // Without min_agreement, pushbacks follow the normal rules.
  const t = setup();
  expect(routineBrief(t.db, { repo: t.repo, slug: "acme/api", me: "pat", now: "x" })).not.toContain("Not allowed now");
  expect(routineSteps({ path: "/f/ROUTINE.md", slug: "acme/api", name: "t" }).join("\n")).toContain("factory routine on --name t");
});

test("the log: bad lines are counted and skipped", () => {
  const { entries, bad } = parseLog(["not json", entry({ comment: "i1", body: "x", verdict: "maybe" }), entry({ comment: "i2", body: "Use the id.", verdict: "fix", commit: "abc1234" }), ""].join("\n"));
  expect(bad).toBe(2);
  expect(entries).toEqual([expect.objectContaining({ comment: "i2", thread: "i2", verdict: "fix", commit: "abc1234", replied: false })]);
});

test("importing the cloud's log records its verdicts once, as the cloud's, and the watcher starts no round for them", () => {
  const s = setup();
  // No branch yet: nothing, and no error.
  expect(importRoutine(s.db, { dir: s.dir, repo: s.repo, run: s.run, now: "2026-11-22T07:00:00Z" })).toMatchObject({ missing: true, applied: 0 });
  s.pushLog([
    entry({ comment: "i50", thread: "i50", body: "Use the user id.", verdict: "fix", reason: "right", commit: "abc1234" }),
    entry({ comment: "c60", thread: "c60", place: null, body: "Rename max?", verdict: "pushback", reason: "max is the public name", replied: true }),
    entry({ pr: 99, comment: "i70", body: "elsewhere", verdict: "fix" }),
    "garbage",
  ]);
  const r = importRoutine(s.db, { dir: s.dir, repo: s.repo, run: s.run, now: "2026-11-22T07:10:00Z" });
  expect(r).toMatchObject({ applied: 2, known: 0, unknown: 1, bad: 1, tickets: [7], missing: false });
  const rows = s.db.query("SELECT n, gh_id, verdict, reason, fix_commit, replied_at IS NOT NULL AS replied FROM comments WHERE ticket = 7 ORDER BY n").all();
  expect(rows).toEqual([
    { n: 1, gh_id: "i50", verdict: "fix", reason: "cloud: right", fix_commit: "abc1234", replied: 0 },
    { n: 2, gh_id: "c60", verdict: "pushback", reason: "cloud: max is the public name", fix_commit: null, replied: 1 },
  ]);
  expect(s.db.query("SELECT what FROM decisions WHERE who = 'cloud' ORDER BY id").all()).toEqual([{ what: "C1 fix in abc1234 on acme/api#42" }, { what: "C2 pushback on acme/api#42" }]);
  // Again: nothing changes.
  expect(importRoutine(s.db, { dir: s.dir, repo: s.repo, run: s.run, now: "2026-11-22T07:20:00Z" })).toMatchObject({ applied: 0, known: 2 });
  // The watcher sees the same comments on GitHub: they're stored, so the ticket stays ready.
  s.setPr({ state: "OPEN", comments: [{ id: 60, author: { login: "sam" }, body: "Rename max?", createdAt: "2026-11-22T01:00:00Z" }], reviews: [] });
  expect(watchPrs(s.db, { dir: s.dir, repo: s.repo, me: "pat", run: s.run, now: "2026-11-22T07:30:00Z" })).toEqual([]);
  expect(s.ticket().state).toBe("ready");
});

test("a verdict given here wins over the cloud's, a stored comment takes the cloud's, and an escalation parks the ticket", () => {
  const s = setup();
  s.setPr({ state: "OPEN", comments: [{ id: 1, author: { login: "sam" }, body: "Seen here first.", createdAt: "2026-11-22T01:00:00Z" }], reviews: [] });
  watchPrs(s.db, { dir: s.dir, repo: s.repo, me: "pat", run: s.run, now: "2026-11-22T01:05:00Z" }); // stored as C1, the fix stage runs
  s.db.query("UPDATE tickets SET state = 'ready' WHERE id = 7").run(); // say the local round ended before the laptop slept
  s.db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, body, at, verdict, reason) VALUES (7, 2, 42, 'c2', 'c2', 'sam', 'Judged here.', 'x', 'fix', 'local')").run();
  s.pushLog([
    entry({ comment: "c1", body: "Seen here first.", verdict: "escalate", reason: "who gets the limit is a product call" }),
    entry({ comment: "c2", body: "Judged here.", verdict: "pushback", reason: "no" }),
  ]);
  expect(importRoutine(s.db, { dir: s.dir, repo: s.repo, run: s.run, now: "2026-11-22T07:10:00Z" })).toMatchObject({ applied: 1, known: 1 });
  expect(s.db.query("SELECT n, verdict, reason FROM comments WHERE ticket = 7 ORDER BY n").all()).toEqual([
    { n: 1, verdict: "escalate", reason: "cloud: who gets the limit is a product call" }, { n: 2, verdict: "fix", reason: "local" }]);
  expect(s.ticket()).toMatchObject({ state: "parked", needs_kind: "parked" });
  expect(s.ticket().needs_text).toStartWith('Escalated while you were away, in the cloud: C1: @sam "Seen here first." · who gets the limit is a product call');
});

test("the daemon reads the log every 10 minutes, only after factory routine on", () => {
  const s = setup();
  const now = Date.parse("2026-11-22T07:00:00Z");
  expect(routineDue(s.db, now)).toBe(false);
  setMeta(s.db, "routine_on", "1");
  expect(routineDue(s.db, now)).toBe(true);
  importRoutine(s.db, { dir: s.dir, repo: s.repo, run: s.run, now: "2026-11-22T07:00:00Z" }); // no branch: still stamped
  expect(routineDue(s.db, now + 5 * 60_000)).toBe(false);
  expect(routineDue(s.db, now + 10 * 60_000)).toBe(true);
});
