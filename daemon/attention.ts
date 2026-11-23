// An agent waiting on the person in its own terminal (a question it asked with Claude's
// question tool, or any prompt): Herdr's agent status says `blocked`, or says nothing yet. The ticket shows in
// Needs you as needing attention until the agent moves on. The answer is given in the
// terminal, never through the factory, and nothing is posted to the issue. Every agent
// asks this way: triage while grooming, and any stage's agent mid-run (its session stays
// open while it waits, so waiting is never a failure and burns no retry).
import type { Database } from "bun:sqlite";
import { journal } from "./journal.ts";

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
// `stage`: the session's stage (groom, spec, implement…), named in Needs you.
export const attentionText = (stage: string | null | undefined, terminal: string) =>
  `${stage || "its agent"} asks you in its terminal (${terminal}): press e to answer`;

export function noteAttention(db: Database, o: { ticket: number; terminal: string; stage?: string | null; waiting: boolean; now: string }) {
  const t = db.query("SELECT needs_kind FROM tickets WHERE id = ?").get(o.ticket) as { needs_kind: string | null } | null;
  if (!t) return null;
  if (o.waiting && !t.needs_kind) {
    db.query("UPDATE tickets SET needs_kind = 'attention', needs_text = ?, updated_at = ? WHERE id = ?")
      .run(attentionText(o.stage, o.terminal), o.now, o.ticket);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', 'its agent is waiting on you in the terminal', ?)").run(o.ticket, o.now);
    attention(db, o, `${o.stage || "its agent"} asks you in its terminal (${o.terminal})`);
    return "waiting";
  }
  if (!o.waiting && t.needs_kind === "attention") {
    db.query("UPDATE tickets SET needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(o.now, o.ticket);
    attention(db, o, `${o.stage || "its agent"} has its answer and goes on`);
    return "answered";
  }
  return null;
}

// The question and its answer live in the waiting session's transcript: the journal points there.
function attention(db: Database, o: { ticket: number; terminal: string; now: string }, text: string) {
  const s = db.query("SELECT id, transcript FROM sessions WHERE ticket = ? AND terminal = ? ORDER BY id DESC LIMIT 1").get(o.ticket, o.terminal) as { id: number; transcript: string | null } | null;
  journal(db, { ticket: o.ticket, session: s?.id ?? null, kind: "attention", text, ref: s?.transcript ? `transcript:${s.transcript}` : s ? `session:${s.id}` : null, at: o.now });
}

// What `factory question` says to a stage agent mid-run: the factory doesn't take questions
// any more (an older agent prompt may still name the command). Nothing is recorded or parked.
export const ASK_IN_TERMINAL = "Don't record the question with the factory: ask the person now, here in your terminal, with your question tool (AskUserQuestion; give the options you see, your pick first). Wait for the answer, product or engineering alike: don't guess it, don't stop and don't end the session. The ticket shows in Needs you while you wait. Then write the question and the answer in the ticket folder's GATES.md under \"## Q<n> · answered by the person in the terminal\", and carry on.";
