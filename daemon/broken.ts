// Broken checks (PRD 7.5): a check that can't run says nothing about the change. Its result
// is "broken", not "fail": the ticket doesn't loop back to implement over it, its PR opens
// saying "⚠ check broken", gate: auto won't merge it, and one "Repair check" chore is filed.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_IDS } from "./intake.ts";

export type CheckResult = "pass" | "fail" | "broken";
// The evidence table's word for each result.
export const EVIDENCE_OF: Record<CheckResult, "PASS" | "FAIL" | "BROKEN"> = { pass: "PASS", fail: "FAIL", broken: "BROKEN" };

// The check couldn't run: its program or a file is missing, a service it needs is down.
const CANT_RUN = [/command not found/i, /^\S*sh: (\d+: )?[^:\n]+: not found$/m, /\bENOENT\b/, /\bECONNREFUSED\b/];
// It ran but tested nothing.
const NO_TESTS = [/\bno tests? (were )?(found|collected|ran|to run)\b/i, /\bno test files found\b/i, /\bcollected 0 items\b/i, /\bRan 0 tests\b/, /^# tests 0$/m];
// Signs that tests ran and failed, or passed: either makes a broken signal ambiguous.
const FAILED = [/\b[1-9]\d* (tests? )?(failed|failing)\b/i, /\bAssertionError\b/, /^\s*(✗|✕|×|FAIL)\s/m];
const PASSED = [/\b[1-9]\d* (tests? )?(passed|passing|pass)\b/i];

const any = (res: RegExp[], out: string) => res.some((re) => re.test(out));

// Pass, fail or broken, from the command's exit code and output. Anything ambiguous is a
// fail: a broken signal next to failing tests is a real failure, and an exit 0 that also
// shows tests passing (one package of several had none) is a pass.
export function classify(code: number, out: string): CheckResult {
  if (code === 0) return any(NO_TESTS, out) && !any(PASSED, out) ? "broken" : "pass";
  if (any(FAILED, out)) return "fail";
  return code === 127 || any(CANT_RUN, out) || any(NO_TESTS, out) ? "broken" : "fail";
}

export const REPAIR_TRIGGER = "broken-check";
export const repairTitle = (check: string) => `Repair check: ${check}`;

// The open repair ticket for a check, if one is filed.
export function repairFor(db: Database, check: string): number | null {
  const row = db.query("SELECT id FROM tickets WHERE trigger_name = ? AND title = ? AND state NOT IN ('merged', 'closed') ORDER BY id LIMIT 1").get(REPAIR_TRIGGER, repairTitle(check)) as { id: number } | null;
  return row?.id ?? null;
}

// Whether ticket `id` is the one repairing `check`: there a broken check is the work to do,
// so it fails like any other and goes back to implement.
export const repairs = (db: Database, id: number, check: string) =>
  !!db.query("SELECT 1 FROM tickets WHERE id = ? AND trigger_name = ? AND title = ?").get(id, REPAIR_TRIGGER, repairTitle(check));

// One chore per broken check, however often it breaks: an open repair ticket for it is
// reused. It is groomed (its brief is BROKEN-CHECK.md), so it queues like a maintainer request.
export function fileRepair(db: Database, o: { dir?: string; check: string; detail: string; from: number; now: string }) {
  const found = repairFor(db, o.check);
  if (found != null) return { id: found, filed: false };
  const max = (db.query("SELECT MAX(id) AS m FROM tickets WHERE id >= ?").get(LOCAL_IDS) as { m: number | null }).m;
  const id = (max ?? LOCAL_IDS - 1) + 1;
  db.query("INSERT INTO tickets (id, title, state, blueprint, trigger_name, groomed_at, updated_at) VALUES (?, ?, 'queued', 'chore', ?, ?, ?)")
    .run(id, repairTitle(o.check), REPAIR_TRIGGER, o.now, o.now);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', 'filed: a check is broken', ?, ?)").run(id, `seen on #${o.from}: ${o.detail}`, o.now);
  if (o.dir) {
    const folder = join(o.dir, "tickets", String(id));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "BROKEN-CHECK.md"), [
      `# Repair check: \`${o.check}\``, "",
      `The check \`${o.check}\` can't run, so it proves nothing about the changes it checks. First seen on ticket #${o.from}:`, "",
      "```", o.detail, "```", "",
      "Make it run again: install or name the missing program, fix the path or the service it needs, or point it at the tests that exist.",
      "Done when the check runs and passes on this branch. Don't change what it tests to make it pass.", "",
    ].join("\n"));
  }
  return { id, filed: true };
}
