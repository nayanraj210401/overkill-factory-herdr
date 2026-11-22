// The factory's system of record. One SQLite file per factory, WAL so the
// window and the CLI can read while the daemon writes.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE tickets (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'queued',
     blueprint TEXT NOT NULL DEFAULT 'feature',
     stage TEXT, detail TEXT,
     location TEXT NOT NULL DEFAULT 'local',
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
     budget_in INTEGER NOT NULL DEFAULT 3000000, budget_out INTEGER NOT NULL DEFAULT 150000,
     usd REAL NOT NULL DEFAULT 0,
     pr_number INTEGER, pr_watched INTEGER NOT NULL DEFAULT 0, pr_checked_at TEXT,
     needs_kind TEXT, needs_text TEXT, blocked_by INTEGER,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE decisions (
     id INTEGER PRIMARY KEY, ticket INTEGER, who TEXT NOT NULL, what TEXT NOT NULL, why TEXT, at TEXT NOT NULL
   );`,
  // D2: each ticket's stage history and check results, the source of STATUS.md and EVIDENCE.md.
  `CREATE TABLE stages (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id),
     name TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL, ended_at TEXT
   );
   CREATE TABLE planned (ticket INTEGER NOT NULL REFERENCES tickets(id), pos INTEGER NOT NULL, name TEXT NOT NULL);
   CREATE TABLE evidence (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id),
     check_name TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL')), detail TEXT, at TEXT NOT NULL
   );`,
  // D4: where each ticket works, and every agent session started for it.
  `ALTER TABLE tickets ADD COLUMN worktree TEXT;
   ALTER TABLE tickets ADD COLUMN branch TEXT;
   CREATE TABLE sessions (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), stage TEXT NOT NULL,
     agent TEXT, terminal TEXT, argv TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0
   );`,
  // D4b: retries per stage, for on_fail / max_retries.
  `ALTER TABLE tickets ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;`,
  // Herdr worktrees: the ticket's space, and whether a session's agent runs in a tab's
  // shell (done when the shell is back in front, after the agent was seen there).
  `ALTER TABLE tickets ADD COLUMN space TEXT;
   ALTER TABLE sessions ADD COLUMN in_space INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN agent_seen INTEGER NOT NULL DEFAULT 0;`,
  // Token recording: one row per Claude message an agent sent, from its transcript.
  `CREATE TABLE usage (
     message_id TEXT PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), session INTEGER REFERENCES sessions(id),
     at TEXT NOT NULL, model TEXT NOT NULL,
     input INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
     cache_read INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL NOT NULL
   );
   CREATE INDEX usage_ticket ON usage(ticket);
   CREATE INDEX usage_at ON usage(at);`,
  // Holdout and review ready rules: what the checker and reviewer agents decided.
  // `voter` is the agent (or --by name); its latest verdict is its vote.
  `CREATE TABLE verdicts (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), session INTEGER REFERENCES sessions(id),
     kind TEXT NOT NULL CHECK (kind IN ('holdout', 'review')), voter TEXT NOT NULL,
     result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL')), detail TEXT, at TEXT NOT NULL
   );`,
  // D6 grooming: the triage agent's questions and their answers, when a ticket was
  // groomed (only groomed tickets start on their own), and each session's folder
  // (triage runs in the ticket's folder, not a worktree; its transcripts live there).
  `CREATE TABLE questions (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), n INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('product', 'engineering')), text TEXT NOT NULL, asked_at TEXT NOT NULL,
     answer TEXT, answered_by TEXT, answered_at TEXT, UNIQUE (ticket, n)
   );
   ALTER TABLE tickets ADD COLUMN groomed_at TEXT;
   ALTER TABLE sessions ADD COLUMN cwd TEXT;`,
  // Revert rate: the merged PR that reverted a ticket's PR, found on GitHub.
  `ALTER TABLE tickets ADD COLUMN reverted_by INTEGER;`,
  // M3 review loop: each reviewer comment on a factory PR, numbered per ticket (C1…),
  // with the fix agent's verdict. Inline replies share their root comment's thread,
  // which is how a reviewer insisting after pushbacks is told apart.
  `CREATE TABLE comments (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), n INTEGER NOT NULL, pr INTEGER NOT NULL,
     gh_id TEXT NOT NULL, thread TEXT NOT NULL, author TEXT NOT NULL, place TEXT, body TEXT NOT NULL, at TEXT NOT NULL, url TEXT,
     insisted INTEGER NOT NULL DEFAULT 0,
     verdict TEXT CHECK (verdict IN ('fix', 'pushback', 'escalate')), reason TEXT, judged_at TEXT, escalated_at TEXT,
     UNIQUE (ticket, gh_id), UNIQUE (ticket, n)
   );`,
  // Multi-repo: the factory's repos (the lead, from init, plus the ones `repo add`
  // records from factory.yaml's repos:), and per ticket, its work in each repo. Every
  // ticket so far worked in the lead repo, so its worktree, branch and PR move to a
  // lead row; the one-repo columns and meta keys go.
  `CREATE TABLE repos (slug TEXT PRIMARY KEY, path TEXT NOT NULL, lead INTEGER NOT NULL DEFAULT 0);
   CREATE UNIQUE INDEX repos_lead ON repos(lead) WHERE lead = 1;
   INSERT INTO repos (slug, path, lead)
     SELECT COALESCE((SELECT value FROM meta WHERE key = 'repo'), 'unknown'), COALESCE((SELECT value FROM meta WHERE key = 'repo_path'), '.'), 1
     WHERE EXISTS (SELECT 1 FROM meta WHERE key IN ('repo', 'repo_path'));
   CREATE TABLE ticket_repos (
     ticket INTEGER NOT NULL REFERENCES tickets(id), repo TEXT NOT NULL REFERENCES repos(slug), lead INTEGER NOT NULL DEFAULT 0,
     worktree TEXT, branch TEXT, pr_number INTEGER, pr_watched INTEGER NOT NULL DEFAULT 0, pr_checked_at TEXT, merged_at TEXT,
     PRIMARY KEY (ticket, repo)
   );
   CREATE UNIQUE INDEX ticket_repos_lead ON ticket_repos(ticket) WHERE lead = 1;
   INSERT INTO ticket_repos (ticket, repo, lead, worktree, branch, pr_number, pr_watched, pr_checked_at, merged_at)
     SELECT t.id, r.slug, 1, t.worktree, t.branch, t.pr_number, t.pr_watched, t.pr_checked_at, CASE WHEN t.state = 'merged' THEN t.updated_at END
     FROM tickets t JOIN repos r ON r.lead = 1
     WHERE t.worktree IS NOT NULL OR t.branch IS NOT NULL OR t.pr_number IS NOT NULL;
   DELETE FROM meta WHERE key IN ('repo', 'repo_path');
   ALTER TABLE tickets DROP COLUMN worktree;
   ALTER TABLE tickets DROP COLUMN branch;
   ALTER TABLE tickets DROP COLUMN pr_number;
   ALTER TABLE tickets DROP COLUMN pr_watched;
   ALTER TABLE tickets DROP COLUMN pr_checked_at;
   -- A ticket with its lead repo's work: what every one-repo reader wants.
   CREATE VIEW ticket_lead AS
     SELECT t.*, r.repo, r.worktree, r.branch, r.pr_number, COALESCE(r.pr_watched, 0) AS pr_watched, r.pr_checked_at, r.merged_at
     FROM tickets t LEFT JOIN ticket_repos r ON r.ticket = t.id AND r.lead = 1;`,
  // Cross-repo merge order: each repo's place, when the plan (or you) set one.
  `ALTER TABLE ticket_repos ADD COLUMN merge_pos INTEGER;`,
  // Triggers: the trigger a ticket came from, so its concurrency can count its running tickets.
  `ALTER TABLE tickets ADD COLUMN trigger_name TEXT;`,
  // Ticket lifecycle: a hash of the issue body seen at pickup, to notice a scope change.
  `ALTER TABLE tickets ADD COLUMN issue_hash TEXT;`,
  // Learning: tuned settings kept outside .factory/ (the active one per key has no undone_at), the
  // copy of them a ticket takes when it starts, and the lesson store with full-text search.
  `CREATE TABLE overrides (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, undone_at TEXT);
   ALTER TABLE tickets ADD COLUMN settings TEXT;
   CREATE TABLE lessons (
     id INTEGER PRIMARY KEY, area TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'you',
     hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, retired_at TEXT, dup_of INTEGER REFERENCES lessons(id)
   );
   CREATE VIRTUAL TABLE lessons_fts USING fts5(text, area, content = 'lessons', content_rowid = 'id');
   CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN INSERT INTO lessons_fts (rowid, text, area) VALUES (new.id, new.text, new.area); END;
   CREATE TRIGGER lessons_ad AFTER DELETE ON lessons BEGIN INSERT INTO lessons_fts (lessons_fts, rowid, text, area) VALUES ('delete', old.id, old.text, old.area); END;
   CREATE TRIGGER lessons_au AFTER UPDATE OF text, area ON lessons BEGIN
     INSERT INTO lessons_fts (lessons_fts, rowid, text, area) VALUES ('delete', old.id, old.text, old.area);
     INSERT INTO lessons_fts (rowid, text, area) VALUES (new.id, new.text, new.area);
   END;`,
  // Benchmarks (monitoring): one batch per suite run, and one row per task under a variant.
  // They aren't tickets, so they keep their own tables; runs.json lists them as kind benchmark.
  `CREATE TABLE bench_batches (
     id INTEGER PRIMARY KEY, suite TEXT NOT NULL, target TEXT NOT NULL, size TEXT NOT NULL, repo TEXT NOT NULL,
     variants TEXT NOT NULL, tasks INTEGER NOT NULL, max_usd REAL, max_tokens INTEGER,
     started_at TEXT NOT NULL, ended_at TEXT, stopped TEXT
   );
   CREATE TABLE bench_runs (
     id INTEGER PRIMARY KEY, batch INTEGER NOT NULL REFERENCES bench_batches(id), task INTEGER NOT NULL, title TEXT NOT NULL,
     variant TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'skipped')), detail TEXT,
     harness TEXT, model TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
     holdout_pass INTEGER, diff_lines INTEGER, pr_lines INTEGER, cwd TEXT, transcript TEXT
   );
   CREATE INDEX bench_runs_batch ON bench_runs(batch);`,
  // Review rounds: a comment's repo, round, diff hunk, the cheap model's suggested verdict,
  // when its pushback reply was posted and the commit that fixed it; each round's token
  // start (for review.round_budget) and which PRs got its one summary comment.
  `ALTER TABLE comments ADD COLUMN repo TEXT;
   ALTER TABLE comments ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE comments ADD COLUMN hunk TEXT;
   ALTER TABLE comments ADD COLUMN suggested TEXT;
   ALTER TABLE comments ADD COLUMN suggested_why TEXT;
   ALTER TABLE comments ADD COLUMN replied_at TEXT;
   ALTER TABLE comments ADD COLUMN fix_commit TEXT;
   CREATE TABLE review_rounds (
     ticket INTEGER NOT NULL REFERENCES tickets(id), round INTEGER NOT NULL, started_at TEXT NOT NULL,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, closed_at TEXT,
     PRIMARY KEY (ticket, round)
   );
   CREATE TABLE review_posts (ticket INTEGER NOT NULL, round INTEGER NOT NULL, repo TEXT NOT NULL, posted_at TEXT NOT NULL, PRIMARY KEY (ticket, round, repo));`,
  // Split: the parts an agent proposed for a ticket, in order, and what became of them; a
  // part's ticket names its parent, and the one that keeps the work starts from its branch (base).
  `CREATE TABLE splits (
     id INTEGER PRIMARY KEY, ticket INTEGER NOT NULL REFERENCES tickets(id), n INTEGER NOT NULL,
     title TEXT NOT NULL, scope TEXT, keeps_work INTEGER NOT NULL DEFAULT 0, proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL,
     decided TEXT CHECK (decided IN ('created', 'rejected')), child INTEGER, UNIQUE (ticket, n)
   );
   ALTER TABLE tickets ADD COLUMN parent INTEGER;
   ALTER TABLE tickets ADD COLUMN base TEXT;`,
  // per: slice: the slice of SLICES.md each session built (by its S<n>, or its place), and
  // the slices a stage finished.
  `ALTER TABLE sessions ADD COLUMN slice TEXT;
   CREATE TABLE slices (
     ticket INTEGER NOT NULL REFERENCES tickets(id), stage TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
     session INTEGER REFERENCES sessions(id), done_at TEXT, PRIMARY KEY (ticket, stage, key)
   );`,
  // Agreement benchmark: your own verdict on a comment (`factory label`), and each run that
  // re-judged the labelled comments, with what the judge said for each.
  `ALTER TABLE comments ADD COLUMN label TEXT CHECK (label IN ('fix', 'pushback', 'escalate'));
   ALTER TABLE comments ADD COLUMN labelled_at TEXT;
   CREATE TABLE agreement_runs (
     id INTEGER PRIMARY KEY, model TEXT NOT NULL, examples INTEGER NOT NULL, agreed INTEGER NOT NULL, failed INTEGER NOT NULL,
     rate REAL NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL
   );
   CREATE TABLE agreement_items (
     run INTEGER NOT NULL REFERENCES agreement_runs(id), ticket INTEGER NOT NULL, n INTEGER NOT NULL,
     yours TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('you', 'kept')), got TEXT, why TEXT,
     PRIMARY KEY (run, ticket, n)
   );`,
  // Shared plans: each ticket file an agent published to claude.ai, one stable link per file (artifacts.ts).
  `CREATE TABLE ticket_artifacts (
     ticket INTEGER NOT NULL REFERENCES tickets(id), file TEXT NOT NULL, url TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('artifact', 'doc')), published_at TEXT NOT NULL, PRIMARY KEY (ticket, file)
   );`,
  // Factory agents (M7): an agreement run names the judge's words too (a hash of its prompt
  // from babysitter.md), and each learner run is kept with what it spent from budget.learning.
  `ALTER TABLE agreement_runs ADD COLUMN prompt TEXT;
   CREATE TABLE learner_runs (
     id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, model TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'unreadable')), why TEXT,
     merged INTEGER NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, usd REAL,
     proposals INTEGER NOT NULL DEFAULT 0, filed TEXT
   );`,
  // What GitHub last said of each PR (open, draft, merged, closed), for the window's PR links; null before the first look.
  `ALTER TABLE ticket_repos ADD COLUMN pr_state TEXT CHECK (pr_state IN ('open', 'draft', 'merged', 'closed'));`,
];

export function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  // busy_timeout: the daemon and the CLI an agent runs share this file; a writer waits
  // for the other's transaction (a PR push can take seconds) instead of failing.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  return db;
}

export const getMeta = (db: Database, key: string) =>
  (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
export const setMeta = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

// The factory's repos. The lead is the repo the factory was made for (its factory.yaml
// is the factory's config); the others join cross-repo tickets.
export type Repo = { slug: string; path: string; lead: boolean };
const repoRow = (r: { slug: string; path: string; lead: number } | null): Repo | null => r && { slug: r.slug, path: r.path, lead: r.lead === 1 };

export const leadRepo = (db: Database) => repoRow(db.query("SELECT * FROM repos WHERE lead = 1").get() as any);
export const listRepos = (db: Database) => (db.query("SELECT * FROM repos ORDER BY lead DESC, slug").all() as any[]).map((r) => repoRow(r)!);

// The lead repo, or why there's none: every command that touches a checkout needs it.
export function needLead(db: Database): Repo {
  const r = leadRepo(db);
  if (!r) throw new Error("this factory has no repo; run factory init --repo owner/name --path <repo>");
  return r;
}

// A repo the factory may work in: the lead, or one `repo add` recorded that factory.yaml's
// repos: still lists (`listed`, read by the caller from the lead's factory.yaml).
export function repoOf(db: Database, slug: string, listed: string[] | undefined): Repo {
  const r = repoRow(db.query("SELECT * FROM repos WHERE slug = ?").get(slug) as any);
  if (r?.lead) return r;
  if (!(listed ?? []).includes(slug)) throw new Error(`${slug} isn't in factory.yaml's repos:`);
  if (!r) throw new Error(`${slug} has no checkout here; run factory repo add ${slug} --path <dir>`);
  return r;
}

// init sets the lead (again: a second init moves it); `repo add` records the others.
export function setRepo(db: Database, r: Repo) {
  if (r.lead) {
    const old = leadRepo(db);
    if (old && old.slug !== r.slug && db.query("SELECT 1 FROM ticket_repos WHERE repo = ?").get(old.slug))
      throw new Error(`tickets already worked in ${old.slug}; the lead repo can't change`);
    db.query("UPDATE repos SET lead = 0 WHERE lead = 1 AND slug != ?").run(r.slug);
    if (old && old.slug !== r.slug) db.query("DELETE FROM repos WHERE slug = ?").run(old.slug);
  }
  db.query("INSERT INTO repos (slug, path, lead) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET path = excluded.path, lead = excluded.lead")
    .run(r.slug, r.path, r.lead ? 1 : 0);
}

// A ticket's work in one repo: its worktree, branch and PR. Without `repo`, the lead
// repo's, whose row is made on the first write, in the factory's lead repo.
export type Work = { worktree: string | null; branch: string | null; pr_number: number | null; pr_watched: number; pr_checked_at: string | null; merged_at: string | null; merge_pos: number | null; pr_state: "open" | "draft" | "merged" | "closed" | null };
export function setWork(db: Database, ticket: number, w: Partial<Work>, repo?: string) {
  const keys = Object.keys(w) as (keyof Work)[];
  if (!keys.length) return;
  const has = db.query("SELECT 1 FROM ticket_repos WHERE ticket = ? AND lead = 1").get(ticket);
  if (!has) db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (?, ?, 1)").run(ticket, needLead(db).slug);
  const where = repo ? "repo = ?" : "lead = 1";
  const r = db.query(`UPDATE ticket_repos SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ticket = ? AND ${where}`)
    .run(...(keys.map((k) => w[k]) as any[]), ticket, ...(repo ? [repo] : []));
  if (r.changes === 0) throw new Error(`#${ticket} doesn't work in ${repo}`);
}

// Every repo a ticket works in, lead first, with its checkout. One with no rows yet
// works in the factory's lead repo.
export type TicketRepo = Work & { repo: string; lead: number; path: string };
export function ticketRepos(db: Database, ticket: number): TicketRepo[] {
  const rows = db.query("SELECT tr.*, r.path FROM ticket_repos tr JOIN repos r ON r.slug = tr.repo WHERE tr.ticket = ? ORDER BY tr.lead DESC, tr.repo").all(ticket) as TicketRepo[];
  if (rows.length) return rows;
  const lead = needLead(db);
  return [{ repo: lead.slug, lead: 1, path: lead.path, worktree: null, branch: null, pr_number: null, pr_watched: 0, pr_checked_at: null, merged_at: null, merge_pos: null, pr_state: null }];
}

// The order a cross-repo ticket's PRs merge in: the places set (`factory merge-order`),
// else the other repos by name and the lead last, so its PR lands on what it needs.
export const mergeOrder = (repos: TicketRepo[]) =>
  [...repos].sort((a, b) => (a.merge_pos ?? Infinity) - (b.merge_pos ?? Infinity) || a.lead - b.lead || a.repo.localeCompare(b.repo));
