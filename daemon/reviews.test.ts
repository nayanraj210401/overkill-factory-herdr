// Reviews (reviews.ts): the intake poll queues teammates' PRs waiting on you, scores
// their risk, and reviews.json is built from the open queue and checked against the
// lib/reviews.js contract before it is written. `factory review approve` approves on
// GitHub, stamps the queue, and the PR leaves the doc.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, open, setRepo } from "./db.ts";
import { sh, type Run } from "./runner.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { validateReviews } from "../lib/reviews.js";
import { approvePr, buildReviews, pollReviews, reviewGate, reviewQueueCount, scorePr, writeReviews } from "./reviews.ts";

const T0 = "2026-11-25T10:00:00Z", T1 = "2026-11-25T10:10:00Z";
const ME = "you";

// One open PR as `gh pr list --json` reports it.
const pr = (o: { number: number; author?: string; title?: string; additions?: number; deletions?: number;
  draft?: boolean; requested?: boolean; files?: string[]; rollup?: any[] }) => ({
  number: o.number, title: o.title ?? `PR ${o.number}`, author: { login: o.author ?? "sam" },
  url: `https://github.com/acme/api/pull/${o.number}`, additions: o.additions ?? 50, deletions: o.deletions ?? 10,
  isDraft: o.draft ?? false, state: "OPEN",
  reviewRequests: o.requested ? [{ login: ME }] : [], files: (o.files ?? []).map((path) => ({ path })),
  statusCheckRollup: o.rollup ?? [],
});

// A gh that answers from a per-test list: your login, the open PRs, and every PR's
// pending review (the list's rollup carries checks, not reviews, so the poll reads each).
function ghOf(list: any[], pending: number[] = []) {
  const calls: string[][] = [];
  const run: Run = (argv) => {
    calls.push(argv);
    if (argv[0] === "gh" && argv[1] === "api") return { code: 0, out: ME };
    if (argv[0] === "gh" && argv[2] === "list") return { code: 0, out: JSON.stringify(list) };
    if (argv[0] === "gh" && argv[2] === "view") {
      const n = Number(argv[3]);
      return { code: 0, out: JSON.stringify({ reviews: pending.includes(n) ? [{ author: { login: ME }, state: "PENDING" }] : [] }) };
    }
    return sh(argv);
  };
  return { run, calls };
}

function setup(factoryYaml = "name: t\n") {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  return { db, dir, repo };
}

const rows = (db: any, slug = "acme/api") =>
  (db.query("SELECT * FROM review_queue WHERE repo = ? ORDER BY number").all(slug) as any[]);
const row = (db: any, n: number) => rows(db).find((r) => r.number === n)!;

test("the migration makes review_queue, with its open-rows index", () => {
  const s = setup();
  const names = (s.db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'review_queue%'").all() as { name: string }[]).map((n) => n.name);
  expect(names).toContain("review_queue");
  expect(names).toContain("review_queue_open");
  expect(MIGRATIONS.length).toBeGreaterThan(39); // append-only: never renumbered
});

test("the risk score: size by band, +25 when a check fails, +30 on a never_low_risk path; low_risk needs under 30, clean checks and clean paths", () => {
  expect(scorePr({ additions: 100, deletions: 50, files: [], failing: 0, globs: [] })).toMatchObject({ score: 20, low_risk: true, reasons: [] });
  expect(scorePr({ additions: 199, deletions: 0, files: [], failing: 0, globs: [] })).toMatchObject({ score: 20, low_risk: true });
  expect(scorePr({ additions: 200, deletions: 0, files: [], failing: 0, globs: [] })).toMatchObject({ score: 40, low_risk: false });
  expect(scorePr({ additions: 350, deletions: 250, files: [], failing: 0, globs: [] }).score).toBe(40);
  expect(scorePr({ additions: 700, deletions: 90, files: [], failing: 0, globs: [] }).score).toBe(40);
  expect(scorePr({ additions: 800, deletions: 0, files: [], failing: 0, globs: [] })).toMatchObject({ score: 60, low_risk: false });
  // a failing check alone lands under 60 but never in the fast lane, even with a small diff
  expect(scorePr({ additions: 50, deletions: 0, files: [], failing: 1, globs: [] })).toMatchObject({ score: 45, low_risk: false, reasons: ["a check is failing"] });
  // a sensitive path does the same; ** crosses directories like a lesson's area
  expect(scorePr({ additions: 50, deletions: 0, files: ["src/auth/login.ts"], failing: 0, globs: ["src/auth/**"] }))
    .toMatchObject({ score: 50, low_risk: false, reasons: ["touches a never_low_risk path"] });
});

test("the intake queues what asks for your review, skips drafts and your own PRs, and keeps requested_at from the first sight", () => {
  const s = setup();
  const { run } = ghOf([
    pr({ number: 88, requested: true, rollup: [{ name: "tests", conclusion: "SUCCESS", description: "128 of 128" }] }),
    pr({ number: 91, requested: true, draft: true }), // drafts never queue
    pr({ number: 93, author: ME, requested: true }), // your own PR never queues
    pr({ number: 95, requested: false }), // nobody asked: out, by default
    pr({ number: 90, requested: true }), // gone after the first poll: its row goes with it
  ]);
  expect(pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], run, now: T0 })).toBe(2);
  const kept = rows(s.db);
  expect(kept.map((r) => r.number)).toEqual([88, 90]);
  expect(kept.every((r) => r.requested_at === T0)).toBe(true);
  expect(row(s.db, 88)).toMatchObject({ title: "PR 88", author: "sam", url: "https://github.com/acme/api/pull/88",
    additions: 50, deletions: 10, low_risk: 1, pending_review: 0 });
  expect(JSON.parse(row(s.db, 88).checks)).toEqual([{ name: "tests", status: "pass", detail: "128 of 128" }]);
});

test("a re-poll upserts: the score follows the PR, requested_at stays, and a vanished PR's row is deleted", () => {
  const s = setup();
  const first = ghOf([pr({ number: 88, requested: true }), pr({ number: 90, requested: true })]);
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], run: first.run, now: T0 });
  // 88 grew (and a check failed), 90 vanished, and 95 asks for your review now.
  const second = ghOf([
    pr({ number: 88, requested: true, additions: 400, rollup: [{ name: "tests", conclusion: "FAILURE" }] }),
    pr({ number: 95, requested: true }),
  ]);
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], run: second.run, now: T1 });
  const kept = rows(s.db);
  expect(kept.map((r) => r.number)).toEqual([88, 95]);
  expect(row(s.db, 88)).toMatchObject({ requested_at: T0, updated_at: T1, risk: 65, low_risk: 0 }); // 40 + 25
  expect(row(s.db, 95)).toMatchObject({ requested_at: T1, low_risk: 1 });
});

test("review.queue: [teammates] adds the repo's other open PRs; a pending review of yours and a sensitive path read through", () => {
  const s = setup('name: t\nreview: { queue: [teammates], never_low_risk: ["src/auth/**"] }\n');
  const { run, calls } = ghOf([
    pr({ number: 88, requested: true, files: ["src/auth/login.ts"], rollup: [{ name: "tests", conclusion: "SUCCESS" }] }),
    pr({ number: 91, draft: true }), // still skipped under teammates
    pr({ number: 93, author: ME }), // your own is still skipped
    pr({ number: 95 }), // nobody asked, teammates: queued
  ], [88]);
  expect(pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], run, now: T0 })).toBe(2);
  expect(row(s.db, 95)).toMatchObject({ low_risk: 1 }); // 60 lines, clean checks, clean paths
  expect(row(s.db, 88)).toMatchObject({ low_risk: 0, pending_review: 1 }); // 20 + 30 sensitive
  // one list call, one reviews call per queued PR
  expect(calls.filter((a) => a[2] === "view").map((a) => a[3])).toEqual(["88", "95"]);
});

test("the built doc holds the contract: validateReviews passes, the gate comes from factory.yaml, and approved rows are out", () => {
  const s = setup('name: t\nreview: { gate: auto }\n');
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], now: T0, run: ghOf([
    pr({ number: 88, requested: true }), pr({ number: 90, requested: true }),
  ]).run });
  const doc = buildReviews(s.db);
  expect(validateReviews(doc)).toEqual([]);
  expect(doc).toMatchObject({ version: 1, source: "daemon", low_risk: { gate: "auto" } });
  expect(doc.prs.map((p) => `${p.repo}#${p.number}`).sort()).toEqual(["acme/api#88", "acme/api#90"]);
  expect(doc.prs.every((p) => p.summary === null && p.evidence === "none" && p.findings.length === 0)).toBe(true);
  // approved: stamped, then out of the doc and the count
  s.db.query("UPDATE review_queue SET approved_at = ? WHERE number = 90").run(T1);
  expect(buildReviews(s.db).prs.map((p) => p.number)).toEqual([88]);
  expect(reviewQueueCount(s.db)).toBe(1);
});

test("the gate is human unless the factory.yaml says auto; a missing factory.yaml reads human", () => {
  expect(reviewGate(setup().db)).toBe("human");
  expect(reviewGate(setup("name: t\nreview: { gate: auto }\n").db)).toBe("auto");
});

test("writeReviews writes reviews.json atomically, and only what holds the contract", () => {
  const s = setup();
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], now: T0, run: ghOf([pr({ number: 88, requested: true })]).run });
  writeReviews(s.db, s.dir);
  const doc = JSON.parse(readFileSync(join(s.dir, "reviews.json"), "utf8"));
  expect(validateReviews(doc)).toEqual([]);
  // writing again changes nothing the page would notice
  writeReviews(s.db, s.dir, new Date(Date.parse(T0) + 60_000));
  expect(JSON.parse(readFileSync(join(s.dir, "reviews.json"), "utf8"))).toEqual(doc);
  // a queue row with a broken url can't land in the file
  s.db.query("UPDATE review_queue SET url = 'nope' WHERE number = 88").run();
  expect(() => writeReviews(s.db, s.dir)).toThrow(/break the contract/);
});

test("approve runs gh pr review --approve, stamps the queue, and refuses a PR that isn't queued", () => {
  const s = setup();
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], now: T0, run: ghOf([pr({ number: 88, requested: true })]).run });
  const calls: string[][] = [];
  const run: Run = (argv) => (calls.push(argv), { code: 0, out: "" });
  approvePr(s.db, { slug: "acme/api", number: 88, run, now: T1, commit: (fn) => s.db.transaction(fn)() });
  expect(calls[0]).toEqual(["gh", "pr", "review", "88", "--approve", "--repo", "acme/api", "--body", "approved from the factory's review queue"]);
  expect(row(s.db, 88).approved_at).toBe(T1);
  expect(reviewQueueCount(s.db)).toBe(0);
  // already approved, or never queued: refused
  expect(() => approvePr(s.db, { slug: "acme/api", number: 88, run, now: T1, commit: (fn) => s.db.transaction(fn)() })).toThrow(/already approved/);
  expect(() => approvePr(s.db, { slug: "acme/api", number: 91, run, now: T1, commit: (fn) => s.db.transaction(fn)() })).toThrow(/not in the review queue/);
  // a gh that fails doesn't stamp anything
  const bad: Run = () => ({ code: 1, out: "gh: not signed in" });
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], now: T0, run: ghOf([pr({ number: 95, requested: true })]).run });
  expect(() => approvePr(s.db, { slug: "acme/api", number: 95, run: bad, now: T1, commit: (fn) => s.db.transaction(fn)() })).toThrow(/gh pr review failed/);
  expect(row(s.db, 95).approved_at).toBeNull();
});

test("status.json's to_review is the open queue, and status still holds its contract", () => {
  const s = setup();
  expect(buildStatus(s.db).to_review).toBe(0);
  pollReviews(s.db, { repos: [{ slug: "acme/api", path: s.repo }], now: T0, run: ghOf([pr({ number: 88, requested: true }), pr({ number: 90, requested: true })]).run });
  const status = buildStatus(s.db);
  expect(status.to_review).toBe(2);
  expect(validateStatus(status)).toEqual([]);
});
