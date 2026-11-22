import { agentlessPr } from "./test-env.ts";
import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { watchPrs } from "./watch.ts";
import { judge } from "./comments.ts";
import { setAway } from "./away.ts";

const GOOD_PR = "Rate-limits login per user.\n\n**What changed:** x.\n**Why:** y.\n**How it was verified:** z.\n**Risk:** low.\n";

function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true }); agentlessPr(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [template]\n');
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
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
  const watch = (now: string, logs: string[] = []) => watchPrs(db, { dir, repo, me: "pat", run, now, log: (s) => logs.push(s) });
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  return { db, dir, repo, gh, watch, ticket, set: (p: any, i: any[] = []) => { pr = p; inline = i; }, down: (v: boolean) => { fail = v; } };
}

test("new comments from reviewers go to REVIEW.md and send the PR back; yours and ones already seen don't", () => {
  // "Old note" was stored on an earlier round: it has a row already.
  const { db, dir, gh, watch, ticket, set } = setup();
  expect(ticket()).toMatchObject({ state: "ready", pr_number: 42, pr_checked_at: "2026-11-21T10:10:00Z" });
  set({ state: "OPEN", comments: [
    { id: 1, author: { login: "sam" }, body: "Old note", createdAt: "2026-11-21T10:00:00Z" },
    { id: 2, author: { login: "pat" }, body: "I agree, done.", createdAt: "2026-11-21T10:20:00Z" },
    { id: 3, author: { login: "sam" }, body: "Why 5 tries and not 10?", createdAt: "2026-11-21T10:21:00Z" },
  ], reviews: [{ id: 4, author: { login: "sam" }, body: "", state: "COMMENTED", submittedAt: "2026-11-21T10:22:00Z" }] },
  [{ id: 50, user: { login: "sam" }, body: "Key on user id,\nnot email.", path: "src/limit.ts", line: 12, created_at: "2026-11-21T10:23:00Z" }]);
  db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, body, at, verdict) VALUES (7, 1, 42, 'c1', 'c1', 'sam', 'Old note', '2026-11-21T10:00:00Z', 'fix')").run();
  expect(watch("2026-11-21T10:30:00Z")).toEqual([{ id: 7, event: "2 comments" }]);
  expect(gh.at(-1)).toEqual(["gh", "api", "repos/acme/api/pulls/42/comments", "--paginate"]);
  expect(ticket()).toMatchObject({ state: "running", stage: "implement", pr_number: 42, pr_checked_at: "2026-11-21T10:30:00Z" });
  const review = readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8");
  expect(review).toContain("## 2 review comments on PR #42 · 2026-11-21 10:30");
  expect(review).toContain("- **C2 · @sam**: Why 5 tries and not 10?");
  expect(review).toContain("- **C3 · @sam** (src/limit.ts:12): Key on user id,\n  not email.");
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

test("every comment needs a verdict; an escalation parks for you; a reviewer insisting after 2 pushbacks wins", () => {
  const { db, dir, repo, watch, ticket, set } = setup();
  const step = () => advance(db, { dir, repo, id: 7, run: (a, c) => (a[0] === "hc" ? { code: 0, out: '{"address":"t1"}' } : a[0] === "gh" ? { code: 0, out: "https://github.com/acme/api/pull/42\n" } : sh(a, c)) });
  const inline = (id: number, body: string, at: string, reply?: number) => ({ id, in_reply_to_id: reply, user: { login: "sam" }, body, path: "src/limit.ts", line: 3, created_at: at });
  const say = (n: number, verdict: string, why = "because") => judge(db, { ticket: 7, n, verdict, reason: why, now: "2026-11-21T11:00:00Z" });

  // Round 1: two comments. Finishing with one unjudged fails the stage (implement has no on_fail: it parks).
  set({ state: "OPEN", comments: [], reviews: [] }, [inline(50, "Use the user id.", "2026-11-21T10:20:00Z"), inline(60, "Rename max.", "2026-11-21T10:21:00Z")]);
  watch("2026-11-21T10:30:00Z");
  say(1, "pushback", "the email is the user id here; see auth.ts:40");
  expect(() => say(2, "maybe")).toThrow("a verdict is fix, pushback, escalate");
  expect(() => say(2, "pushback", " ")).toThrow("say why");
  expect(step()).toMatchObject({ parked: true });
  expect(ticket().needs_text).toContain("C2 has no verdict");

  // Round 2 (after the person's answer the stage reran): C2 fixed, PR updated; the reviewer replies in C1's thread.
  db.query("UPDATE tickets SET state = 'running', needs_kind = NULL WHERE id = 7").run();
  say(2, "fix", "");
  expect(step()).toMatchObject({ ready: true, stage: "merge" });
  set({ state: "OPEN", comments: [], reviews: [] }, [inline(50, "Use the user id.", "2026-11-21T10:20:00Z"), inline(70, "No, emails change.", "2026-11-21T11:10:00Z", 50)]);
  watch("2026-11-21T11:15:00Z");
  say(3, "pushback", "they don't in this product");
  step();
  // Round 3: the reviewer insists again; two pushbacks in the thread, so this one can't be pushed back.
  set({ state: "OPEN", comments: [], reviews: [] }, [inline(80, "Please change it.", "2026-11-21T11:30:00Z", 50)]);
  watch("2026-11-21T11:35:00Z");
  expect(readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8")).toContain("**C4 · @sam** (src/limit.ts:3) · **insisted after pushbacks: fix it, or escalate**");
  expect(() => say(4, "pushback", "still no")).toThrow("C4: @sam insisted after pushbacks; fix it, or escalate");
  say(4, "escalate", "changing the key resets every limit");
  expect(step()).toMatchObject({ parked: true });
  expect(ticket()).toMatchObject({ state: "parked", needs_kind: "parked" });
  expect(ticket().needs_text).toStartWith('Escalated C4: @sam "Please change it." · changing the key resets every limit');
  expect(() => judge(db, { ticket: 7, n: 9, verdict: "fix", reason: "", now: "x" })).toThrow("#7 has no comment C9");
});

test("away: no pushbacks, and past away.review_rounds new comments park instead of starting a round", () => {
  const { db, dir, repo, watch, ticket, set } = setup();
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [template]\naway: { review_rounds: 1, min_agreement: 0.85 }\n');
  setAway(db, true, "2026-11-21T10:15:00Z");
  expect(() => setAway(db, true, "2026-11-21T10:16:00Z")).toThrow("already away since 2026-11-21T10:15:00Z");
  const run: Run = (a, c) => (a[0] === "hc" ? { code: 0, out: '{"address":"t1"}' } : a[0] === "gh" ? { code: 0, out: "https://github.com/acme/api/pull/42\n" } : sh(a, c));
  set({ state: "OPEN", comments: [{ id: 1, author: { login: "sam" }, body: "Rename it.", createdAt: "2026-11-21T10:20:00Z" }], reviews: [] });
  expect(watch("2026-11-21T10:30:00Z")).toEqual([{ id: 7, event: "1 comment" }]); // round 1 of 1
  expect(() => judge(db, { ticket: 7, n: 1, verdict: "pushback", reason: "no", now: "x", repo })).toThrow("no pushbacks while the person is away");
  writeFileSync(join(repo, ".factory/factory.yaml"), 'name: t\nquality_floor: ["true"]\nready: [template]\naway: { review_rounds: 1, min_agreement: 0 }\n');
  judge(db, { ticket: 7, n: 1, verdict: "pushback", reason: "the agreement gate is off, so pushbacks are allowed", now: "x", repo });
  advance(db, { dir, repo, id: 7, run });
  expect(ticket().state).toBe("ready");
  set({ state: "OPEN", comments: [{ id: 2, author: { login: "sam" }, body: "And this.", createdAt: "2026-11-21T11:20:00Z" }], reviews: [] });
  expect(watch("2026-11-21T11:30:00Z")).toEqual([{ id: 7, event: "1 comment, parked (away)" }]);
  expect(ticket()).toMatchObject({ state: "parked", stage: "implement", needs_text: "1 new review comment on PR #42; away.review_rounds is used up while you're away" });
  expect(readFileSync(join(dir, "tickets/7/REVIEW.md"), "utf8")).toContain("**C2 · @sam**: And this.");
});
