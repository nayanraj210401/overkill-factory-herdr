import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { watchPrs } from "./watch.ts";
import { judge } from "./comments.ts";
import { setAway } from "./away.ts";
import { closeRound, openRound } from "./round.ts";
import { parseProposal } from "./prejudge.ts";
import { roundCap } from "./budget.ts";
import { validateFile } from "./validate.ts";

const GOOD_PR = "Rate-limits login per user.\n\n**What changed:** x.\n**Why:** y.\n**How it was verified:** z.\n**Risk:** low.\n";

// Same shape as watch.test.ts's setup, with claude and gh stubbed and recorded.
function setup(extra = "") {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\nready: [template]\n${extra}`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const gh: string[][] = [];
  const hc: string[][] = [];
  const claude: string[][] = [];
  const say: { out: (argv: string[]) => string } = { out: () => "VERDICT: escalate\nCLEAR: no\nWHY: unsure" };
  let pr: any = { state: "OPEN", comments: [], reviews: [] };
  let inline: any[] = [];
  let failPost = false;
  let failRepo = "";
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return hc.push(argv), { code: 0, out: '{"address":"t1"}' };
    if (argv[0] === "claude") return claude.push(argv), { code: 0, out: say.out(argv) };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (argv[1] === "api" && argv.includes("-f")) return failPost ? { code: 1, out: "HTTP 502" } : { code: 0, out: "{}" };
    if (argv[1] === "api") return { code: 0, out: JSON.stringify(inline) };
    if (argv[2] === "view") return { code: 0, out: JSON.stringify(pr) };
    if (argv[2] === "comment") return failPost || (failRepo && argv.includes(failRepo)) ? { code: 1, out: "HTTP 502" } : { code: 0, out: "" };
    return { code: 0, out: "https://github.com/acme/api/pull/42\n" };
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'chore', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/PR.md"), GOOD_PR);
  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:10:00Z" });
  const watch = (now: string, logs: string[] = []) => watchPrs(db, { dir, repo, me: "pat", run, now, log: (s) => logs.push(s) });
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  const posts = () => gh.filter((a) => (a[1] === "api" ? a.includes("-f") : a[2] === "comment"));
  const inl = (id: number, body: string, path: string, line: number, at: string) =>
    ({ id, user: { login: "sam" }, body, path, line, created_at: at, diff_hunk: `@@ -1,2 +1,3 @@\n const limit = 5;\n+const key = email;  // line ${id}` });
  return { db, dir, repo, gh, hc, claude, say, watch, ticket, posts, inl, run, set: (p: any, i: any[] = []) => { pr = p; inline = i; }, failPost: (v: boolean) => { failPost = v; }, failRepo: (v: string) => { failRepo = v; } };
}

test("the fix brief holds only the fix comments, with their words, lines, hunk and acceptance checks, and the fix session starts from it", () => {
  const s = setup();
  writeFileSync(join(s.dir, "tickets/7/INTENT.md"), "# Intent\n\n## Acceptance\n\n- C1 returns 429 after 5 tries (src/limit.ts)\n- C2 docs mention the limit (README.md)\n");
  s.say.out = (a) => (a.at(-1)!.includes("Use the user id") ? "VERDICT: fix\nCLEAR: yes\nWHY: right" : "VERDICT: pushback\nCLEAR: no\nWHY: taste");
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "Use the user id.", "src/limit.ts", 12, "2026-11-21T10:20:00Z"), s.inl(60, "Rename max.", "src/other.ts", 3, "2026-11-21T10:21:00Z")]);
  s.watch("2026-11-21T10:30:00Z");
  // The judge is a one-shot claude -p on the judge model, and sees the comment and its lines only.
  expect(s.claude).toHaveLength(2);
  expect(s.claude[0].slice(0, 4)).toEqual(["claude", "-p", "--model", "haiku"]);
  expect(s.claude[0][4]).toContain("Use the user id.");
  expect(s.claude[0][4]).toContain("+const key = email;  // line 50");
  expect(s.claude[0][4]).not.toContain("Rate-limit login");
  const brief = readFileSync(join(s.dir, "tickets/7/REVIEW-ROUND-1.md"), "utf8");
  expect(brief).toContain("## C1 · @sam · src/limit.ts:12 · acme/api");
  expect(brief).toContain("> Use the user id.");
  expect(brief).toContain("+const key = email;  // line 50");
  expect(brief).toContain("- C1 returns 429 after 5 tries (src/limit.ts)");
  expect(brief).not.toContain("README.md");
  expect(brief).not.toContain("Rename max.");
  // The suggestions show in REVIEW.md, and the fresh fix session's brief names the file.
  const review = readFileSync(join(s.dir, "tickets/7/REVIEW.md"), "utf8");
  expect(review).toContain("Suggested: **fix** (right)");
  expect(review).toContain("Suggested: **pushback** (taste)");
  expect(s.hc.flat().join(" ")).toContain("REVIEW-ROUND-1.md");
});

test("review.judge_model picks the model; an unreadable answer leaves no suggestion", () => {
  const s = setup("review: { judge_model: sonnet }\n");
  s.say.out = () => "I think maybe both verdict: fix and verdict: pushback";
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "One.", "a.ts", 1, "2026-11-21T10:20:00Z")]);
  s.watch("2026-11-21T10:30:00Z");
  expect(s.claude[0].slice(0, 4)).toEqual(["claude", "-p", "--model", "sonnet"]);
  expect(s.db.query("SELECT suggested FROM comments WHERE n = 1").get()).toEqual({ suggested: null });
  expect(parseProposal("**VERDICT:** `Fix`\nclear: YES\nwhy: typo")).toEqual({ verdict: "fix", why: "typo", clear: true });
  expect(parseProposal("VERDICT: fix | pushback | escalate")).toBeNull();
  expect(parseProposal("")).toBeNull();
});

test("while away, a clear-cut fix is applied; a pushback, an escalation and an unclear fix only pre-fill", () => {
  const s = setup("away: { min_agreement: 0.85 }\n");
  setAway(s.db, true, "2026-11-21T10:15:00Z");
  s.say.out = (a) => { const p = a.at(-1)!; return p.includes("typo") ? "VERDICT: fix\nCLEAR: yes\nWHY: typo" : p.includes("maybe") ? "VERDICT: fix\nCLEAR: no\nWHY: big" : "VERDICT: pushback\nCLEAR: yes\nWHY: no"; };
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "A typo.", "a.ts", 1, "2026-11-21T10:20:00Z"), s.inl(60, "Rewrite, maybe?", "a.ts", 2, "2026-11-21T10:21:00Z"), s.inl(70, "Drop it.", "a.ts", 3, "2026-11-21T10:22:00Z")]);
  s.watch("2026-11-21T10:30:00Z");
  const rows = s.db.query("SELECT n, verdict, suggested, reason FROM comments ORDER BY n").all() as any[];
  expect(rows[0]).toMatchObject({ verdict: "fix", suggested: "fix" });
  expect(rows[0].reason).toContain("auto: haiku judged it a clear fix");
  expect(rows[1]).toMatchObject({ verdict: null, suggested: "fix" });
  expect(rows[2]).toMatchObject({ verdict: null, suggested: "pushback" });
  // `factory comment` still decides, and min_agreement still refuses a pushback while away.
  expect(() => judge(s.db, { ticket: 7, n: 3, verdict: "pushback", reason: "no", now: "x", repo: s.repo })).toThrow("no pushbacks while the person is away");
  // Not away: nothing is applied.
  const t = setup();
  t.say.out = () => "VERDICT: fix\nCLEAR: yes\nWHY: typo";
  t.set({ state: "OPEN", comments: [], reviews: [] }, [t.inl(50, "A typo.", "a.ts", 1, "2026-11-21T10:20:00Z")]);
  t.watch("2026-11-21T10:30:00Z");
  expect(t.db.query("SELECT verdict, suggested FROM comments").get()).toEqual({ verdict: null, suggested: "fix" });
});

test("after the round's fixes are pushed: a reply to each pushed-back comment and one summary per PR, each posted once", () => {
  const s = setup();
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "Use the user id.", "src/limit.ts", 12, "2026-11-21T10:20:00Z"), s.inl(60, "Rename max.", "src/limit.ts", 3, "2026-11-21T10:21:00Z"), s.inl(70, "Charge more?", "src/pay.ts", 4, "2026-11-21T10:22:00Z")]);
  s.watch("2026-11-21T10:30:00Z");
  const say = (n: number, v: string, why = "") => judge(s.db, { ticket: 7, n, verdict: v, reason: why, now: "2026-11-21T10:40:00Z" });
  say(1, "fix"); say(2, "pushback", "max is the public name; see api.md"); say(3, "escalate", "pricing is a product call");
  expect(s.posts()).toHaveLength(0); // nothing posted while the round is still being fixed
  const parked = advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-21T10:50:00Z" });
  expect(parked).toMatchObject({ parked: true }); // the escalation stops the ticket for you
  expect(s.posts()).toHaveLength(0);
  s.db.query("UPDATE tickets SET state = 'running', needs_kind = NULL WHERE id = 7").run();
  advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-21T11:00:00Z" });
  const sent = s.posts();
  expect(sent[0]).toEqual(["gh", "api", "repos/acme/api/pulls/42/comments/60/replies", "-f", "body=max is the public name; see api.md"]);
  expect(sent[1].slice(0, 6)).toEqual(["gh", "pr", "comment", "42", "--repo", "acme/api"]);
  const body = sent[1][7];
  expect(body).toContain("factory-round 7-1");
  expect(body).toMatch(/\*\*Fixed\*\*\n- C1 \(src\/limit\.ts:12\) in [0-9a-f]{7,}: Use the user id\./);
  expect(body).toContain("**Pushed back (replied on the comment)**\n- C2 (src/limit.ts:3): max is the public name; see api.md");
  expect(body).toContain("**Escalated to a person**\n- C3 (src/pay.ts:4): pricing is a product call");
  expect(sent).toHaveLength(2);
  expect(s.db.query("SELECT closed_at FROM review_rounds").get()).toEqual({ closed_at: "2026-11-21T11:00:00Z" });
  // A retry, and the watcher's next tick, post nothing more.
  expect(closeRound(s.db, { ticket: 7, run: s.run, now: "2026-11-21T11:05:00Z" })).toBe(false);
  s.watch("2026-11-21T11:10:00Z");
  expect(s.posts()).toHaveLength(2);
});

test("a gh failure leaves the round open and the next tick posts once; a reply the agent already made isn't repeated", () => {
  const s = setup();
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "Use the user id.", "a.ts", 1, "2026-11-21T10:20:00Z"), s.inl(60, "Rename max.", "a.ts", 2, "2026-11-21T10:21:00Z")]);
  s.watch("2026-11-21T10:30:00Z");
  judge(s.db, { ticket: 7, n: 1, verdict: "fix", reason: "", now: "2026-11-21T10:40:00Z" });
  judge(s.db, { ticket: 7, n: 2, verdict: "pushback", reason: "max is the public name", now: "2026-11-21T10:40:00Z" });
  s.failPost(true);
  advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-21T11:00:00Z" });
  expect(s.ticket().state).toBe("ready"); // the PR flow isn't blocked by a failed post
  expect(s.db.query("SELECT closed_at FROM review_rounds").get()).toEqual({ closed_at: null });
  // The agent had replied in the thread itself, so only the summary is posted now.
  s.failPost(false);
  s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "Use the user id.", "a.ts", 1, "2026-11-21T10:20:00Z"), s.inl(60, "Rename max.", "a.ts", 2, "2026-11-21T10:21:00Z"),
    { id: 61, in_reply_to_id: 60, user: { login: "pat" }, body: "max is the public name, see api.md", path: "a.ts", line: 2, created_at: "2026-11-21T10:45:00Z" }]);
  const before = s.posts().length;
  s.watch("2026-11-21T11:10:00Z");
  const after = s.posts().slice(before);
  expect(after).toHaveLength(1);
  expect(after[0][2]).toBe("comment");
  expect(s.db.query("SELECT replied_at FROM comments WHERE n = 2").get()).toEqual({ replied_at: "2026-11-21T11:10:00Z" });
});

test("a cross-repo ticket's round gets a summary on each of its PRs", () => {
  const s = setup();
  setRepo(s.db, { slug: "acme/web", path: "/nowhere" });
  s.db.query("INSERT INTO ticket_repos (ticket, repo, pr_number, pr_watched) VALUES (7, 'acme/web', 9, 1)").run();
  const round = openRound(s.db, 7, "2026-11-21T10:30:00Z");
  s.db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, body, at, verdict, repo, round) VALUES (7, 1, 9, 'c1', 'c1', 'sam', 'Fix web', 'x', 'fix', 'acme/web', ?)").run(round);
  expect(closeRound(s.db, { ticket: 7, run: s.run, now: "2026-11-21T11:00:00Z" })).toBe(true);
  const sums = s.posts().filter((a) => a[2] === "comment");
  expect(sums.map((a) => `${a[5]}#${a[3]}`).sort()).toEqual(["acme/api#42", "acme/web#9"]);
  expect(sums.find((a) => a[3] === "9")![7]).toContain("- C1: Fix web");
  expect(sums.find((a) => a[3] === "42")![7]).toContain("No comments on this PR this round");
});

test("a summary that failed on one PR is retried there only; the PR that got it isn't posted to again", () => {
  const s = setup();
  s.db.query("INSERT INTO repos (slug, path) VALUES ('acme/web', '/nowhere')").run();
  s.db.query("INSERT INTO ticket_repos (ticket, repo, pr_number, pr_watched) VALUES (7, 'acme/web', 9, 1)").run();
  const round = openRound(s.db, 7, "2026-11-21T10:30:00Z");
  s.db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, body, at, verdict, repo, round) VALUES (7, 1, 9, 'c1', 'c1', 'sam', 'Fix web', 'x', 'fix', 'acme/web', ?)").run(round);
  s.failRepo("acme/web");
  expect(closeRound(s.db, { ticket: 7, run: s.run, now: "2026-11-21T11:00:00Z" })).toBe(false);
  expect(s.posts().map((a) => a[5])).toEqual(["acme/api", "acme/web"]); // the web post was tried and failed
  s.failRepo("");
  expect(closeRound(s.db, { ticket: 7, run: s.run, now: "2026-11-21T11:05:00Z" })).toBe(true);
  expect(s.posts().map((a) => a[5])).toEqual(["acme/api", "acme/web", "acme/web"]); // api not again
});

test("review.round_budget: a round at its cap parks; under it, the ticket goes on; it's a share or tokens", () => {
  const round = (tokens: number) => {
    const s = setup("review: { round_budget: 25% }\n");
    s.set({ state: "OPEN", comments: [], reviews: [] }, [s.inl(50, "Use the user id.", "a.ts", 1, "2026-11-21T10:20:00Z")]);
    s.db.query("UPDATE tickets SET tokens_in = 1000000 WHERE id = 7").run(); // spent before the round: not counted in it
    s.watch("2026-11-21T10:30:00Z");
    judge(s.db, { ticket: 7, n: 1, verdict: "fix", reason: "", now: "2026-11-21T10:40:00Z" });
    s.db.query("UPDATE tickets SET tokens_in = ? WHERE id = 7").run(1_000_000 + tokens);
    return { s, out: advance(s.db, { dir: s.dir, repo: s.repo, id: 7, run: s.run, now: "2026-11-21T10:50:00Z" }) };
  };
  expect(round(700_000).out).not.toMatchObject({ parked: true }); // 700k of a 750k cap (25% of 3M)
  const hit = round(760_000);
  expect(hit.out).toMatchObject({ parked: true });
  expect(hit.s.ticket()).toMatchObject({ state: "parked", needs_text: expect.stringContaining("Review round 1 used its token cap (760k/750k in") });
  // Absolute tokens, input or input/output; no key, no cap.
  const b = { budget_in: 3_000_000, budget_out: 150_000 };
  expect(roundCap(hit.s.repo, b)).toEqual({ input: 750_000, output: 37_500 });
  writeFileSync(join(hit.s.repo, ".factory/factory.yaml"), "name: t\nreview: { round_budget: 200k/20k }\n");
  expect(roundCap(hit.s.repo, b)).toEqual({ input: 200_000, output: 20_000 });
  writeFileSync(join(hit.s.repo, ".factory/factory.yaml"), "name: t\n");
  expect(roundCap(hit.s.repo, b)).toBeNull();
});

test("factory.yaml's review.round_budget and judge_model validate", () => {
  const check = (review: string) => validateFile("factory.yaml", `name: t\nreview:\n${review}`);
  expect(check("  round_budget: 25%\n  judge_model: haiku\n  pushbacks: 2\n")).toEqual([]);
  expect(check("  round_budget: 200k/20k\n")).toEqual([]);
  expect(check("  round_budget: lots\n").join()).toContain("review.round_budget");
  expect(check("  judge_model: 3\n").join()).toContain("judge_model");
});
