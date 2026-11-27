// reviews.json: teammates' PRs waiting on you (plan: Reviewing teammates' PRs, M6 wave 1).
// The intake poll reads each repo's open PRs from GitHub on its ~10-minute clock and queues
// the ones asking for your review — and, when the repo's factory.yaml sets
// review.queue: [teammates], every other open non-draft PR there too (drafts and your own
// PRs never queue). Each PR gets a risk score:
//   start at 0; +20 under 200 changed lines, +40 under 800, +60 at 800 or more;
//   +25 when any check fails; +30 when a changed file matches a review.never_low_risk
//   glob (factory.yaml, matched like a lesson's area: ** crosses directories).
// low_risk = score under 30, no failing check and no sensitive path. Checks still running
// or skipped are left out, so a score only reads finished news. requested_at is when the
// poll first saw the PR (a review request's own time isn't exposed), kept across polls.
// The Reviews page and `factory review approve` act on the queue; findings and a summary
// wait for wave 2, so they are empty for now. The doc's shape is lib/reviews.js's contract.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeIfChanged } from "./files.ts";
import { leadRepo } from "./db.ts";
import { login } from "./intake.ts";
import { readFactory, type Run } from "./runner.ts";
import { validateReviews } from "../lib/reviews.js";

// The risk score, pure so tests can pin it. `globs` are the repo's review.never_low_risk
// patterns; `failing` the failing checks' names (one is enough to know).
export function scorePr(o: { additions: number; deletions: number; files: string[]; failing: number; globs: string[] }) {
  const lines = o.additions + o.deletions;
  const size = lines < 200 ? 20 : lines < 800 ? 40 : 60;
  const failing = o.failing > 0;
  const globs = o.globs.map((g) => new Bun.Glob(g.endsWith("/") ? `${g}**` : g));
  const sensitive = o.files.some((f) => globs.some((g) => g.match(f)));
  const reasons: string[] = [];
  if (failing) reasons.push("a check is failing");
  if (sensitive) reasons.push("touches a never_low_risk path");
  const score = size + (failing ? 25 : 0) + (sensitive ? 30 : 0);
  return { score, reasons, low_risk: score < 30 && !failing && !sensitive, size };
}

const ghJson = (run: Run, argv: string[]) => {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.out.slice(0, 200)}`);
  return JSON.parse(r.out);
};

// statusCheckRollup's two shapes: a check run (conclusion) and a plain status (state).
// Running (QUEUED, IN_PROGRESS, PENDING) and skipped checks say nothing yet: left out.
const checksOf = (rollup: any[]) => rollup.flatMap((c) => {
  const name = c.name ?? c.context;
  if (!name) return [];
  const pass = c.conclusion === "SUCCESS" || c.state === "SUCCESS";
  const fail = ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"].includes(c.conclusion) || ["FAILURE", "ERROR"].includes(c.state);
  if (!pass && !fail) return [];
  return [{ name, status: pass ? "pass" : "fail", detail: typeof c.description === "string" && c.description ? c.description.slice(0, 200) : null }];
});

// A review request's reviewer: gh flattens it to { login }, but a bot or team keeps its
// own shape, so the login is read wherever it sits.
const requestedOf = (requests: any[], me: string) => requests.some((r) =>
  [r?.login, r?.requestedReviewer?.login, r?.slug].some((l) => typeof l === "string" && l.toLowerCase() === me.toLowerCase()));

// The open PRs waiting on you, one repo at a time. Writes to review_queue; the caller
// wraps it in its transaction (change), and stamps the clock itself, so a failing gh
// waits its turn like a working one. Returns how many PRs the queue holds.
export function pollReviews(db: Database, o: { repos: { slug: string; path: string }[]; run: Run; now: string; log?: (s: string) => void }) {
  const me = login(db, o.run, "me");
  let queued = 0;
  for (const repo of o.repos) {
    const cfg = readFactory(repo.path).review ?? {};
    const teammates = (cfg.queue ?? []).includes("teammates");
    const globs = cfg.never_low_risk ?? [];
    let listed: any[];
    try {
      listed = ghJson(o.run, ["gh", "pr", "list", "--repo", repo.slug, "--state", "open", "--limit", "200",
        "--json", "number,title,author,url,additions,deletions,isDraft,state,reviewRequests,files,statusCheckRollup"]) as any[];
    } catch (e) { o.log?.(`factory: ${repo.slug}: reading open PRs: ${(e as Error).message}`); continue; }
    const kept = listed.filter((p) => p.state === "OPEN" && !p.isDraft && p.author?.login?.toLowerCase() !== me.toLowerCase())
      .filter((p) => requestedOf(p.reviewRequests ?? [], me) || teammates);
    const seen: number[] = [];
    for (const p of kept) {
      // A review you started but haven't submitted is only readable per PR (the list's
      // rollup carries checks, not reviews); one that can't be read waits for the next poll.
      let pending = false;
      try {
        pending = (ghJson(o.run, ["gh", "pr", "view", String(p.number), "--repo", repo.slug, "--json", "reviews"]).reviews ?? [])
          .some((r: any) => r.author?.login?.toLowerCase() === me.toLowerCase() && r.state === "PENDING");
      } catch (e) { o.log?.(`factory: ${repo.slug}#${p.number}: reading its reviews: ${(e as Error).message}`); continue; }
      const files = (p.files ?? []).map((f: any) => f.path);
      const checks = checksOf(p.statusCheckRollup ?? []);
      const s = scorePr({ additions: p.additions ?? 0, deletions: p.deletions ?? 0, files, failing: checks.filter((c: any) => c.status === "fail").length, globs });
      db.query(`INSERT INTO review_queue (repo, number, requested_at, low_risk, risk, reasons, title, author, url, additions, deletions, pending_review, checks, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo, number) DO UPDATE SET low_risk = excluded.low_risk, risk = excluded.risk, reasons = excluded.reasons,
            title = excluded.title, author = excluded.author, url = excluded.url, additions = excluded.additions, deletions = excluded.deletions,
            pending_review = excluded.pending_review, checks = excluded.checks, updated_at = excluded.updated_at`)
        .run(repo.slug, p.number, o.now, s.low_risk ? 1 : 0, s.score, JSON.stringify(s.reasons), p.title, p.author?.login ?? "", p.url,
          p.additions ?? 0, p.deletions ?? 0, pending ? 1 : 0, JSON.stringify(checks), o.now);
      seen.push(p.number);
    }
    // A row whose PR is gone from the open list (merged, closed, or no longer waiting on
    // you) has no place in the queue, however it got there; approved rows included.
    const del = seen.length
      ? db.query(`DELETE FROM review_queue WHERE repo = ? AND number NOT IN (${seen.map(() => "?").join(",")})`)
      : db.query("DELETE FROM review_queue WHERE repo = ?");
    del.run(...(seen.length ? [repo.slug, ...seen] : [repo.slug]));
    queued += seen.length;
  }
  return queued;
}

// The doc's low_risk.gate: review.gate in the lead repo's factory.yaml, human unless it says auto.
export const reviewGate = (db: Database) => {
  const lead = leadRepo(db);
  return lead && readFactory(lead.path).review?.gate === "auto" ? "auto" : "human";
};

// The doc lib/reviews.js validates, from the open queue only.
export function buildReviews(db: Database, now = new Date()) {
  const rows = db.query("SELECT * FROM review_queue WHERE approved_at IS NULL ORDER BY risk DESC, requested_at").all() as any[];
  return {
    version: 1,
    generated_at: now.toISOString(),
    source: "daemon" as const,
    low_risk: { gate: reviewGate(db) },
    prs: rows.map((r) => ({
      repo: r.repo, number: r.number, title: r.title, author: r.author, url: r.url,
      additions: r.additions, deletions: r.deletions, requested_at: r.requested_at,
      low_risk: !!r.low_risk, risk: { score: r.risk, reasons: JSON.parse(r.reasons ?? "[]") },
      summary: null, pending_review: !!r.pending_review, evidence: "none" as const, findings: [],
      checks: JSON.parse(r.checks ?? "[]"),
    })),
  };
}

// reviews.json beside status.json, atomic, and never written unless it would hold the contract.
export function writeReviews(db: Database, dir: string, now = new Date()) {
  const doc = buildReviews(db, now);
  const errors = validateReviews(doc);
  if (errors.length) throw new Error(`reviews.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(join(dir, "reviews.json"), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

// The sidebar's To review number: the open queue's size.
export const reviewQueueCount = (db: Database) =>
  (db.query("SELECT COUNT(*) AS n FROM review_queue WHERE approved_at IS NULL").get() as { n: number }).n;

// `factory review approve`: approve on GitHub first, outside the transaction, then the
// caller's commit stamps approved_at, which takes the PR out of reviews.json.
export function approvePr(db: Database, o: { slug: string; number: number; run: Run; now: string; commit: (fn: () => void) => void }) {
  const row = db.query("SELECT * FROM review_queue WHERE repo = ? AND number = ?").get(o.slug, o.number) as { approved_at: string | null } | null;
  if (!row) throw new Error(`${o.slug}#${o.number} is not in the review queue; reviews.json only holds what the daemon found`);
  if (row.approved_at) throw new Error(`${o.slug}#${o.number} is already approved`);
  const r = o.run(["gh", "pr", "review", String(o.number), "--approve", "--repo", o.slug, "--body", "approved from the factory's review queue"]);
  if (r.code !== 0) throw new Error(`gh pr review failed: ${r.out.slice(0, 200)}`);
  o.commit(() => {
    db.query("UPDATE review_queue SET approved_at = ?, updated_at = ? WHERE repo = ? AND number = ?").run(o.now, o.now, o.slug, o.number);
  });
}
