// The ticket folder's state files, written only by the daemon from rows:
// STATUS.md (the Ticket page's timeline) and EVIDENCE.md (its Checks tab).
import type { Database } from "bun:sqlite";
import { writeIfChanged } from "./files.ts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketOf } from "./status.ts";

type Stage = { name: string; detail: string | null; started_at: string; ended_at: string | null };
type Check = { check_name: string; result: "PASS" | "FAIL"; detail: string | null; at: string };

// One plain sentence first (PRD 6.3), so the main point is never buried.
export function summary(t: ReturnType<typeof ticketOf>) {
  const cost = `$${t.usd.toFixed(2)} so far`;
  switch (t.state) {
    case "running": return `${t.title} is in ${t.stage ?? "a stage"}${t.detail ? `, ${t.detail}` : ""}, at ${cost}.`;
    case "ready": return `${t.title} is ready${t.pr ? `: PR #${t.pr.number}` : ""}, at ${cost}.`;
    case "parked": return `${t.title} is parked: ${t.needs?.text ?? "it is stuck"}.`;
    case "paused": return `${t.title} is paused at ${t.stage ?? "its start"}${t.detail ? ` (${t.detail})` : ""}, at ${cost}.`;
    case "blocked": return `${t.title} waits on #${t.blocked_by}.`;
    case "grooming": return `${t.title} is being groomed${t.needs ? `: ${t.needs.text.split(" · ")[0]}` : ""}.`; // the questions have their own card
    case "merged": return `${t.title} is merged, at $${t.usd.toFixed(2)}.`;
    case "closed": return `${t.title} is closed.`;
    default: return `${t.title} is queued.`;
  }
}

// A stage entered again (verify fails, implement runs again) is one step with rounds, in the
// order each stage first appeared. A round followed by an earlier stage was sent back
// ("failed"); "then passed" shows only once the ticket moved on to a later stage.
// The latest round's detail shows; every round stays in `stages` as the history.
export type Step = { name: string; detail: string | null; ms: number; open: boolean; rounds: string | null };
export function groupStages(stages: Stage[], now: string): Step[] {
  const order = [...new Set(stages.map((s) => s.name.toLowerCase()))];
  const groups = new Map<string, { rows: Stage[]; failed: number; passed: boolean }>();
  stages.forEach((s, i) => {
    const key = s.name.toLowerCase();
    const g = groups.get(key) ?? { rows: [], failed: 0, passed: false };
    groups.set(key, g);
    g.rows.push(s);
    const next = stages[i + 1]?.name.toLowerCase();
    g.passed = false;
    if (next === undefined || next === key) return;
    if (order.indexOf(next) < order.indexOf(key)) g.failed++;
    else g.passed = true;
  });
  return [...groups.values()].map((g) => {
    const last = g.rows[g.rows.length - 1];
    const rounds = g.failed ? `failed ${g.failed}×${g.passed ? ", then passed" : ""}` : g.rows.length > 1 ? `${g.rows.length} rounds` : null;
    return { name: last.name, detail: last.detail, open: !last.ended_at, rounds,
      ms: g.rows.reduce((a, r) => a + Math.max(0, Date.parse(r.ended_at ?? now) - Date.parse(r.started_at)), 0) };
  });
}

export function statusMd(t: ReturnType<typeof ticketOf>, stages: Stage[], planned: string[], now: string) {
  const steps = groupStages(stages, now);
  const names = new Set(steps.map((s) => s.name.toLowerCase()));
  return [
    summary(t),
    "",
    ...steps.map((s) => `- ${s.open ? "now" : "done"} ${s.name} · ${Math.round(s.ms / 60000)}m${s.rounds ? ` · ${s.rounds}` : ""}${s.detail ? ` · ${s.detail}` : ""}`),
    ...planned.filter((n) => !names.has(n.toLowerCase())).map((name) => `- next ${name}`),
    "",
  ].join("\n");
}

type Verdict = { kind: string; voter: string; result: string; detail: string | null; at: string };

export function evidenceMd(checks: Check[], verdicts: Verdict[] = []) {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const result = (r: string) => (r === "PASS" ? "✓ PASS" : "✗ FAIL");
  const when = (at: string) => at.slice(0, 16).replace("T", " ");
  return [
    "# Evidence",
    "",
    ...(checks.length ? [
      "| Check | Result | Detail | When |",
      "| --- | --- | --- | --- |",
      ...checks.map((c) => `| \`${cell(c.check_name)}\` | ${result(c.result)} | ${cell(c.detail ?? "")} | ${when(c.at)} |`),
    ] : ["No checks have run yet."]),
    "",
    ...(verdicts.length ? [
      "## Verdicts",
      "",
      "| Kind | From | Result | Detail | When |",
      "| --- | --- | --- | --- | --- |",
      ...verdicts.map((v) => `| ${v.kind} | ${cell(v.voter)} | ${result(v.result)} | ${cell(v.detail ?? "")} | ${when(v.at)} |`),
      "",
    ] : []),
  ].join("\n");
}

const write = writeIfChanged;

export function writeTicketFiles(db: Database, dir: string, id: number, now = new Date().toISOString()) {
  const row = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as Record<string, any> | null;
  if (!row) return;
  const stages = db.query("SELECT name, detail, started_at, ended_at FROM stages WHERE ticket = ? ORDER BY id").all(id) as Stage[];
  const planned = (db.query("SELECT name FROM planned WHERE ticket = ? ORDER BY pos").all(id) as { name: string }[]).map((p) => p.name);
  const checks = db.query("SELECT check_name, result, detail, at FROM evidence WHERE ticket = ? ORDER BY id").all(id) as Check[];
  const folder = join(dir, "tickets", String(id));
  mkdirSync(folder, { recursive: true });
  write(join(folder, "STATUS.md"), statusMd(ticketOf(row), stages, planned, now));
  const verdicts = db.query("SELECT kind, voter, result, detail, at FROM verdicts WHERE ticket = ? ORDER BY id").all(id) as Verdict[];
  write(join(folder, "EVIDENCE.md"), evidenceMd(checks, verdicts));
}

// Moves a ticket into a stage: the stage it was in ends now, the new one starts.
// `next` replaces the planned stages shown after it.
export function enterStage(db: Database, id: number, name: string, detail: string | null, next: string[] | null, now: string) {
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, id);
  db.query("INSERT INTO stages (ticket, name, detail, started_at) VALUES (?, ?, ?, ?)").run(id, name, detail, now);
  const planned = next ?? (db.query("SELECT name FROM planned WHERE ticket = ? ORDER BY pos").all(id) as { name: string }[])
    .map((p) => p.name).filter((n) => n.toLowerCase() !== name.toLowerCase());
  db.query("DELETE FROM planned WHERE ticket = ?").run(id);
  planned.forEach((n, i) => db.query("INSERT INTO planned (ticket, pos, name) VALUES (?, ?, ?)").run(id, i, n));
  db.query("UPDATE tickets SET stage = ?, detail = ?, updated_at = ? WHERE id = ?").run(name.toLowerCase(), detail, now, id);
}
