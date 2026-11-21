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
