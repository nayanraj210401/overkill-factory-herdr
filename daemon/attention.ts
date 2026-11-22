// An agent waiting on the person in its own terminal (a question it asked with Claude's
// question tool, or any prompt): Herdr's agent status says `blocked`, or says nothing yet. The ticket shows in
// Needs you as needing attention until the agent moves on. The answer is given in the
// terminal, never through the factory, and nothing is posted to the issue.
import type { Database } from "bun:sqlite";

// A prompt Claude Code shows before its session starts (the one-time auto mode consent,
// "trust this folder?") comes before any agent status: a live terminal that has reported
// none a minute after its session started is waiting on you too.
export const SILENT_MS = 60_000;
type Info = { status?: { state?: string } | null } | null;
export function waiting(info: Info, o: { startedAt: string; now: number }) {
  const state = info?.status?.state;
  if (state && state !== "unknown") return state === "blocked";
  return o.now - Date.parse(o.startedAt) >= SILENT_MS;
}

// Sets or clears the ticket's attention flag; never touches another kind of need (a parked
// ticket, a split waiting for you). Returns what changed, for the log.
export function noteAttention(db: Database, o: { ticket: number; terminal: string; waiting: boolean; now: string }) {
  const t = db.query("SELECT needs_kind FROM tickets WHERE id = ?").get(o.ticket) as { needs_kind: string | null } | null;
  if (!t) return null;
  if (o.waiting && !t.needs_kind) {
    db.query("UPDATE tickets SET needs_kind = 'attention', needs_text = ?, updated_at = ? WHERE id = ?")
      .run(`Waiting on you in its terminal (${o.terminal}): open it to answer`, o.now, o.ticket);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', 'its agent is waiting on you in the terminal', ?)").run(o.ticket, o.now);
    return "waiting";
  }
  if (!o.waiting && t.needs_kind === "attention") {
    db.query("UPDATE tickets SET needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(o.now, o.ticket);
    return "answered";
  }
  return null;
}
