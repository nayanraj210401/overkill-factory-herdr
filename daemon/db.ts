// The factory's system of record. One SQLite file per factory, WAL so the
// window and the CLI can read while the daemon writes.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
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
];

export function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
