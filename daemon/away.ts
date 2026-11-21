// Away mode (plan: Away mode). `factory away on` says nobody is there to ask, and
// factory.yaml's `away:` narrows what runs unattended:
//   away: { blueprints: [chore], budget: 1M/100k, review_rounds: 2, never: ["src/auth/**"] }
// blueprints: only these start while you're away. budget: a lower cap per ticket.
// review_rounds: rounds of review comments a PR may take before it waits for you.
// never: paths no unattended run may touch; a ticket that does parks.
// The babysitter may not push back while away (its agreement with you isn't measured
// yet), so it fixes or escalates. Grooming questions still wait, and merge stays human.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import { parseTokens } from "../lib/model.js";
import { readFactory, type Run } from "./runner.ts";

export type AwayPolicy = { blueprints?: string[]; budget?: string; review_rounds?: number; never?: string[] };

export const awaySince = (db: Database) => (getMeta(db, "away_until") ? null : getMeta(db, "away_since"));
export const isAway = (db: Database) => awaySince(db) != null;
export const awayPolicy = (repo: string): AwayPolicy => ((readFactory(repo) as any).away ?? {}) as AwayPolicy;

export function setAway(db: Database, on: boolean, now: string) {
  if (on === isAway(db)) throw new Error(on ? `already away since ${awaySince(db)}` : "you aren't away");
  if (on) { setMeta(db, "away_since", now); db.query("DELETE FROM meta WHERE key = 'away_until'").run(); }
  else setMeta(db, "away_until", now);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (NULL, 'you', ?, ?)").run(on ? "went away" : "came back", now);
}

export const mayStart = (db: Database, repo: string, blueprint: string) => {
  const only = awayPolicy(repo).blueprints;
  return !isAway(db) || !only || only.includes(blueprint);
};

// The budget the ready rule holds a ticket to: its own, or the away cap if lower.
export function budgetCap(db: Database, repo: string) {
  const b = awayPolicy(repo).budget;
  if (!isAway(db) || !b) return null;
  const [input, output] = String(b).split("/").map((x) => parseTokens(x.trim()));
  return { input: input || Infinity, output: output || Infinity };
}

export function reviewRoundsLeft(db: Database, repo: string, ticket: number) {
  const limit = awayPolicy(repo).review_rounds;
  const since = awaySince(db);
  if (since == null || limit == null) return Infinity;
  const used = (db.query("SELECT COUNT(*) AS n FROM decisions WHERE ticket = ? AND who = 'daemon' AND what LIKE 'review comments on PR #%' AND at >= ?").get(ticket, since) as { n: number }).n;
  return limit - used;
}

// Files the ticket changed (committed or not) that match a `never` glob.
export function forbiddenTouched(db: Database, o: { repo: string; worktree: string; run: Run }) {
  const never = awayPolicy(o.repo).never;
  if (!isAway(db) || !never?.length) return [];
  const base = o.run(["git", "-C", o.repo, "symbolic-ref", "--short", "HEAD"]).out;
  const from = o.run(["git", "-C", o.worktree, "merge-base", base, "HEAD"]).out;
  const files = [
    ...o.run(["git", "-C", o.worktree, "diff", "--name-only", from]).out.split("\n"),
    ...o.run(["git", "-C", o.worktree, "ls-files", "--others", "--exclude-standard"]).out.split("\n"),
  ].filter(Boolean);
  const globs = never.map((g) => new Bun.Glob(g));
  return [...new Set(files)].filter((f) => globs.some((g) => g.match(f)));
}

// What happened while you were away: everything not decided by you, newest last.
export function digest(db: Database, now: string) {
  const since = getMeta(db, "away_since");
  if (!since) return null;
  const until = getMeta(db, "away_until");
  const events = db.query("SELECT ticket, who, what, at FROM decisions WHERE who != 'you' AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 30")
    .all(since, until ?? now) as { ticket: number | null; who: string; what: string; at: string }[];
  return { on: until == null, since, until, events: events.reverse() };
}
