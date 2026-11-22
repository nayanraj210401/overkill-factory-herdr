import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { slicesOf } from "./slices.ts";

const now = "2026-11-21T10:00:00Z";
const SLICES = `# Slices

1. **S1 Counter store** — per-user counter in Redis. ✓ done
2. **S2 Middleware** — \`src/middleware/limit.ts\` returns 429.
   - Status: [ ]
3. **S3 429 page** — friendly page with retry-after.
`;

test("slices are ## sections, else the numbered items; [x], ✓ or done marks one done", () => {
  const listed = slicesOf(SLICES);
  expect(listed.map((s) => [s.key, s.marked])).toEqual([["S1", true], ["S2", false], ["S3", false]]);
  expect(listed[1].text).toContain("Status: [ ]");
  const headed = slicesOf("# Plan\n\n## Add the setting\n\nx\n\n## [x] Use it\n\ny\n\n### Docs\n\n- Status: [x] landed\n");
  expect(headed.map((s) => [s.key, s.title, s.marked])).toEqual([["#1", "Add the setting", false], ["#2", "Use it", true], ["#3", "Docs", true]]);
  expect(slicesOf("Just do it.")).toEqual([]);
});

// A feature ticket at implement (per: slice), with SLICES.md written by the planner.
function setup(floor = '"true"') {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: [${floor}]\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const briefs: string[] = [];
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] !== "hc") return sh(argv, cwd);
    if (argv[1] === "run") briefs.push(argv.at(-1)!);
    return { code: 0, out: `{"address":"t${++n}"}` };
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', ?)").run(now);
  startTicket(db, { dir, repo, id: 7, run, now });
  const step = (failed?: string) => advance(db, { dir, repo, id: 7, run, now, failed });
  step(); // spec → plan
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/SLICES.md"), SLICES);
  const sessions = () => db.query("SELECT stage, slice FROM sessions ORDER BY id").all();
  const detail = () => (db.query("SELECT detail FROM stages ORDER BY id DESC LIMIT 1").get() as any).detail;
  return { db, dir, step, briefs, sessions, detail };
}

test("implement runs once per open slice, a fresh session each, then moves on", () => {
  const s = setup();
  expect(s.step()).toMatchObject({ stage: "implement", terminal: "t3" });
  expect(s.briefs.at(-1)).toContain("The slice:\n2. **S2 Middleware**");
  expect(s.briefs.at(-1)).not.toContain("S3 429 page");
  expect(s.detail()).toBe("builder agent · slice 2 of 3");
  expect(s.step()).toMatchObject({ stage: "implement", terminal: "t4" }); // S2 built: a new session for S3
  expect(s.briefs.at(-1)).toContain("The slice:\n3. **S3 429 page**");
  expect(s.step()).toMatchObject({ stage: "holdout" }); // S3 built: verify ran and passed
  expect(s.sessions()).toEqual([
    { stage: "spec", slice: null }, { stage: "plan", slice: null },
    { stage: "implement", slice: "S2" }, { stage: "implement", slice: "S3" }, { stage: "holdout", slice: null },
  ]);
  expect(s.db.query("SELECT key, done_at FROM slices ORDER BY key").all()).toEqual([{ key: "S2", done_at: now }, { key: "S3", done_at: now }]);
});

test("a slice whose session failed isn't done; sent back after every slice, implement runs once for the whole ticket", () => {
  const s = setup('"exit 1"');
  s.step(); // → implement, S2
  expect(s.step("tests fail")).toMatchObject({ parked: true }); // implement has no on_fail
  expect(s.db.query("SELECT COUNT(*) AS n FROM slices").get()).toEqual({ n: 0 });

  const t = setup('"exit 1"');
  t.step(); t.step(); // S2, S3
  expect(t.step()).toMatchObject({ stage: "implement" }); // verify failed → on_fail
  expect(t.sessions().at(-1)).toEqual({ stage: "implement", slice: null });
  expect(t.briefs.at(-1)).not.toContain("The slice:");
  expect(t.detail()).toBe("builder agent");
});

test("with no SLICES.md the stage runs once", () => {
  const s = setup();
  writeFileSync(join(s.dir, "tickets/7/SLICES.md"), "Nothing to slice.\n");
  expect(s.step()).toMatchObject({ stage: "implement" });
  expect(s.step()).toMatchObject({ stage: "holdout" });
  expect(readFileSync(join(s.dir, "tickets/7/SLICES.md"), "utf8")).toBe("Nothing to slice.\n"); // the daemon never writes it
});
