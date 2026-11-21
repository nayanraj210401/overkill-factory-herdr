// The ticket folder's state files, written only by the daemon from rows:
// STATUS.md (the Ticket page's timeline) and EVIDENCE.md (its Checks tab).
import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketOf } from "./status.ts";

type Stage = { name: string; detail: string | null; started_at: string; ended_at: string | null };
type Check = { check_name: string; result: "PASS" | "FAIL"; detail: string | null; at: string };

const minutes = (from: string, to: string) => `${Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000))}m`;

// One plain sentence first (PRD 6.3), so the main point is never buried.
export function summary(t: ReturnType<typeof ticketOf>) {
  const cost = `$${t.usd.toFixed(2)} so far`;
  switch (t.state) {
    case "running": return `${t.title} is in ${t.stage ?? "a stage"}${t.detail ? `, ${t.detail}` : ""}, at ${cost}.`;
    case "ready": return `${t.title} is ready${t.pr ? `: PR #${t.pr.number}` : ""}, at ${cost}.`;
    case "parked": return `${t.title} is parked: ${t.needs?.text ?? "it is stuck"}.`;
    case "paused": return `${t.title} is paused at ${t.stage ?? "its start"}, at ${cost}.`;
    case "blocked": return `${t.title} waits on #${t.blocked_by}.`;
    case "grooming": return `${t.title} is being groomed${t.needs ? `: ${t.needs.text}` : ""}.`;
    case "merged": return `${t.title} is merged, at $${t.usd.toFixed(2)}.`;
    case "closed": return `${t.title} is closed.`;
    default: return `${t.title} is queued.`;
  }
}

export function statusMd(t: ReturnType<typeof ticketOf>, stages: Stage[], planned: string[], now: string) {
  const line = (state: string, s: Stage) =>
    `- ${state} ${s.name} · ${minutes(s.started_at, s.ended_at ?? now)}${s.detail ? ` · ${s.detail}` : ""}`;
  return [
    summary(t),
    "",
    ...stages.map((s) => line(s.ended_at ? "done" : "now", s)),
    ...planned.map((name) => `- next ${name}`),
    "",
  ].join("\n");
}

export function evidenceMd(checks: Check[]) {
  if (!checks.length) return "# Evidence\n\nNo checks have run yet.\n";
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  return [
    "# Evidence",
    "",
    "| Check | Result | Detail | When |",
    "| --- | --- | --- | --- |",
    ...checks.map((c) => `| \`${cell(c.check_name)}\` | ${c.result === "PASS" ? "✓ PASS" : "✗ FAIL"} | ${cell(c.detail ?? "")} | ${c.at.slice(0, 16).replace("T", " ")} |`),
    "",
  ].join("\n");
}

const write = (path: string, text: string) => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

export function writeTicketFiles(db: Database, dir: string, id: number, now = new Date().toISOString()) {
  const row = db.query("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, any> | null;
  if (!row) return;
  const stages = db.query("SELECT name, detail, started_at, ended_at FROM stages WHERE ticket = ? ORDER BY id").all(id) as Stage[];
  const planned = (db.query("SELECT name FROM planned WHERE ticket = ? ORDER BY pos").all(id) as { name: string }[]).map((p) => p.name);
  const checks = db.query("SELECT check_name, result, detail, at FROM evidence WHERE ticket = ? ORDER BY id").all(id) as Check[];
  const folder = join(dir, "tickets", String(id));
  mkdirSync(folder, { recursive: true });
  write(join(folder, "STATUS.md"), statusMd(ticketOf(row), stages, planned, now));
  write(join(folder, "EVIDENCE.md"), evidenceMd(checks));
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
