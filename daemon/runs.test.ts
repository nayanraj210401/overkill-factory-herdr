import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { transcriptDir } from "./usage.ts";
import { buildRuns, writeRuns, RUNS_CAP } from "./runs.ts";
import { validateRuns } from "../lib/runs.js";

const HOUR = 3_600_000;

test("runs.json: every session newest first, with its kind, model, time, tokens, cost and transcript", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "runs-")), "factory.db"));
  const cwd = "/work/trees/acme/factory-7-runs";
  const t0 = new Date();
  const at = (ms: number) => new Date(t0.getTime() + ms).toISOString();
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (7, 'Wire it', ?)").run(at(0));
  const add = (id: number, stage: string, argv: string[], start: string, end: string | null, c: string | null) =>
    db.query("INSERT INTO sessions (id, ticket, stage, argv, started_at, ended_at, tokens_in, tokens_out, cwd) VALUES (?, 7, ?, ?, ?, ?, 100, 20, ?)")
      .run(id, stage, JSON.stringify(argv), start, end, c);
  add(1, "groom", ["claude", "--model", "haiku", "brief"], at(-HOUR), at(-HOUR + 180_000), null);
  add(2, "implement", ["claude", "--model", "sonnet", "brief"], at(0), at(600_000), cwd);
  add(3, "verify", ["codex", "--model", "gpt-5", "brief"], at(HOUR), null, cwd);
  db.query(`INSERT INTO usage (message_id, ticket, session, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd)
    VALUES ('m1', 7, 2, ?, 'claude-opus-5-5', 100, 0, 0, 0, 20, 0.75)`).run(at(1000));
  // Session 2's transcript: the file born after it began, before session 3 did. Session 3 is Codex's: none.
  mkdirSync(transcriptDir(cwd), { recursive: true });
  writeFileSync(join(transcriptDir(cwd), "abc.jsonl"), "{}\n");

  const { runs } = buildRuns(db, t0);
  expect(runs.map((r) => r.id)).toEqual([3, 2, 1]);
  expect(runs[0]).toMatchObject({ kind: "stage", stage: "verify", harness: "codex", model: "gpt-5", duration_s: null, usd: null, transcript: null, title: "Wire it" });
  expect(runs[1]).toMatchObject({ harness: "claude", model: "claude-opus-5-5", duration_s: 600, usd: 0.75, tokens_in: 100, tokens_out: 20, transcript: join(transcriptDir(cwd), "abc.jsonl") });
  expect(runs[2]).toMatchObject({ kind: "grooming", model: "haiku", duration_s: 180, transcript: null });
  expect(validateRuns({ runs })).toEqual([]);
});

test("runs.json is capped at the newest runs and written next to status.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  const db = open(join(dir, "factory.db"));
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (1, 'x', '2026-11-21T00:00:00Z')").run();
  for (let i = 1; i <= RUNS_CAP + 5; i++)
    db.query("INSERT INTO sessions (id, ticket, stage, argv, started_at) VALUES (?, 1, 'spec', '[\"claude\"]', ?)").run(i, new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString());
  writeRuns(db, join(dir, "runs.json"));
  const doc = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"));
  expect(doc.runs).toHaveLength(RUNS_CAP);
  expect(doc.runs[0].id).toBe(RUNS_CAP + 5);
});
