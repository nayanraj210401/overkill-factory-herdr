import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { watchPrs } from "./watch.ts";

const GOOD_PR = "Rate-limits login per user.\n\n**What changed:** x.\n**Why:** y.\n**How it was verified:** z.\n**Risk:** low.\n";

function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [template]\n');
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setMeta(db, "repo_path", repo);
  const gh: string[][] = [];
  let pr: any = { state: "OPEN", comments: [], reviews: [] };
  let inline: any[] = [];
  let fail = false;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: '{"address":"t1"}' };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (fail) return { code: 1, out: "HTTP 502" };
    if (argv[1] === "api") return { code: 0, out: JSON.stringify(inline) };
    if (argv[2] === "view") return { code: 0, out: JSON.stringify(pr) };
    return { code: 0, out: "https://github.com/acme/api/pull/42\n" };
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:10:00Z" }); // implement → verify → pr: PR #42 opens, checked at 10:10
  const watch = (now: string, logs: string[] = []) => watchPrs(db, { dir, repo, slug: "acme/api", me: "pat", run, now, log: (s) => logs.push(s) });
  const ticket = () => db.query("SELECT * FROM tickets WHERE id = 7").get() as any;
  return { db, dir, repo, gh, watch, ticket, set: (p: any, i: any[] = []) => { pr = p; inline = i; }, down: (v: boolean) => { fail = v; } };
}

test("new comments from reviewers go to REVIEW.md and send the PR back; yours and old ones don't", () => {
  const { dir, gh, watch, ticket, set } = setup();
  expect(ticket()).toMatchObject({ state: "ready", pr_number: 42, pr_checked_at: "2026-11-21T10:10:00Z" });
  set({ state: "OPEN", comments: [
    { author: { login: "sam" }, body: "Old note", createdAt: "2026-11-21T10:00:00Z" },
    { author: { login: "pat" }, body: "I agree, done.", createdAt: "2026-11-21T10:20:00Z" },
    { author: { login: "sam" }, body: "Why 5 tries and not 10?", createdAt: "2026-11-21T10:21:00Z" },
  ], reviews: [{ author: { login: "sam" }, body: "", state: "COMMENTED", submittedAt: "2026-11-21T10:22:00Z" }] },
  [{ user: { login: "sam" }, body: "Key on user id,\nnot email.", path: "src/limit.ts", line: 12, created_at: "2026-11-21T10:23:00Z" }]);
  expect(watch("2026-11-21T10:30:00Z")).toEqual([{ id: 7, event: "2 comments" }]);
  expect(gh.at(-1)).toEqual(["gh", "api", "repos/acme/api/pulls/42/comments", "--paginate"]);
  expect(ticket()).toMatchObject({ state: "running", stage: "implement", pr_number: 42, pr_checked_at: "2026-11-21T10:30:00Z" });
  const review = readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8");
  expect(review).toContain("## 2 review comments on PR #42 · 2026-11-21 10:30");
  expect(review).toContain("- **@sam**: Why 5 tries and not 10?");
  expect(review).toContain("- **@sam** (src/limit.ts:12): Key on user id,\n  not email.");
  expect(review).not.toContain("Old note");
  expect(review).not.toContain("I agree");
});

test("a PR merged or closed on GitHub ends the ticket; a failing gh changes nothing", () => {
  const a = setup();
  a.down(true);
  const logs: string[] = [];
  expect(a.watch("2026-11-21T10:30:00Z", logs)).toEqual([]);
  expect(logs[0]).toContain("watching PR #42: gh pr view failed: HTTP 502");
  expect(a.ticket().state).toBe("ready");
  a.down(false);
  a.set({ state: "OPEN", comments: [], reviews: [] });
  expect(a.watch("2026-11-21T10:31:00Z")).toEqual([]);
  expect(a.ticket()).toMatchObject({ state: "ready", pr_checked_at: "2026-11-21T10:31:00Z" });
  const wt = a.ticket().worktree;
  a.set({ state: "MERGED", comments: [], reviews: [] });
  expect(a.watch("2026-11-21T10:40:00Z")).toEqual([{ id: 7, event: "merged" }]);
  expect(a.ticket()).toMatchObject({ state: "merged", pr_watched: 0, worktree: null });
  expect(existsSync(wt)).toBe(false);
  expect(a.db.query("SELECT who, what, why FROM decisions ORDER BY id DESC").get()).toEqual({ who: "daemon", what: "merged PR #42", why: "on GitHub" });
  const b = setup();
  b.set({ state: "CLOSED", comments: [], reviews: [] });
  expect(b.watch("2026-11-21T10:40:00Z")).toEqual([{ id: 7, event: "closed" }]);
  expect(b.ticket().state).toBe("closed");
});
