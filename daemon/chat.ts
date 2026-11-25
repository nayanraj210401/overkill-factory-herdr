// A ticket's own chat session: the person's session on the ticket, outside its blueprint. It works
// in the ticket's worktree with the ticket's context, does whatever the person asks, and the
// runner never starts, waits on or advances it. Opening it pauses a running ticket, so two agents
// never edit the same files; when it ends (closed, or its terminal exits) a ticket it paused
// resumes. Its row is a session with stage "chat", so its transcript and cost are the ticket's.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ticketRepos } from "./db.ts";
import { STOPS, guardSettings, hardStopLog } from "./guard.ts";
import { withFactory } from "./herdr.ts";
import { DEFAULT_MODEL, pinModel } from "./models.ts";
import { digestBlock } from "./digest.ts";
import { claudeSession, endSessions, journal, journalSessionStart } from "./journal.ts";
import { pause, readFactory, resume, sh, type Run } from "./runner.ts";

export const CHAT = "chat";

type Open = { id: number; terminal: string; paused_ticket: number };

// A terminal Herdr stopped keeps a null exit code: finished counts as gone (globals.ts alive()).
const alive = (run: Run, terminal: string) => {
  const r = run(["hc", "get", terminal, "--json"]);
  try { const t = JSON.parse(r.out); return r.code === 0 && t.exit_code == null && t.state !== "finished"; } catch { return false; }
};

const openChat = (db: Database, id: number) =>
  db.query("SELECT id, terminal, paused_ticket FROM sessions WHERE ticket = ? AND stage = 'chat' AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(id) as Open | null;

// What the session is told: the ticket, where its files are, and that it answers to the person.
export function chatBrief(o: { id: number; title: string; folder: string; worktrees: string[]; intent: string; digest: string; paused: boolean }) {
  return [
    `## You are the person's own session on ticket #${o.id}: ${o.title}`,
    "The person opened you to work on this ticket directly, outside the factory's blueprint. Do what they ask, in this terminal: answer questions, explore, change code, run things. No stage owns you: there is no handoff, verdict or output file to write, and you don't move the ticket on.",
    `The ticket's code is in ${o.worktrees.join(", ")}; its files (TICKET.md, INTENT.md, SLICES.md, HANDOFF.md, GATES.md) are in ${o.folder}. Commit what you change on the ticket's branch, as a stage agent would; never push to main.`,
    o.paused ? "The ticket's blueprint is paused while you're open. When the person closes you, it resumes where it stopped and its next stage starts from the worktree as you leave it." : "",
    o.intent ? `## Intent\n\n${o.intent.trim()}` : "",
    o.digest,
    "Start by saying in one or two lines where the ticket stands, then ask the person what they want to do.",
  ].filter(Boolean).join("\n\n");
}

// The live chat session's terminal, or null. A row whose terminal is gone is ended here.
export function liveChat(db: Database, o: { dir?: string; repo?: string; id: number; run?: Run; now?: string }) {
  const s = openChat(db, o.id);
  if (!s) return null;
  if (alive(o.run ?? sh, s.terminal)) return s.terminal;
  chatEnded(db, { ...o, session: s });
  return null;
}

// `factory chat <id>`: the live chat session, or a new one. A running ticket is paused first.
export function startChat(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  const known = liveChat(db, { ...o, run, now });
  if (known) return { terminal: known, started: false, paused: false };
  if (t.state === "closed" || t.state === "merged") throw new Error(`#${o.id} is ${t.state}`);
  if (!t.worktree) throw new Error(`#${o.id} hasn't started, so it has no worktree to work in yet`);
  if (t.location === "cloud") throw new Error(`#${o.id} is in the cloud; bring it back first (⇧L)`);
  const paused = t.state === "running";
  if (paused) pause(db, { id: o.id, run, now, who: "your chat session" });
  const repos = ticketRepos(db, o.id);
  const worktrees = repos.flatMap((r) => r.worktree ?? []);
  const folder = join(o.dir, "tickets", String(o.id));
  const intent = existsSync(join(folder, "INTENT.md")) ? readFileSync(join(folder, "INTENT.md"), "utf8") : "";
  const text = chatBrief({ id: o.id, title: t.title, folder, worktrees, intent, digest: digestBlock(db, o.id), paused });
  // Auto mode like every factory session, with the factory's hard stops on its tool calls.
  const guard = guardSettings({ stops: readFactory(o.repo).hard_stops ?? [...STOPS], roots: [...worktrees, folder], log: hardStopLog(o.dir, o.id) });
  const settings = { skipAutoPermissionPrompt: true, permissions: { additionalDirectories: [...worktrees.slice(1), folder] }, ...(guard ? JSON.parse(guard) : {}) };
  const cs = claudeSession(["claude", "--permission-mode", "auto", "--settings", JSON.stringify(settings), "--model", pinModel(DEFAULT_MODEL)!, text], t.worktree);
  const cmd = withFactory(cs.argv, o.dir, { agent: CHAT, ticket: o.id, repo: repos[0]?.repo });
  const hc = run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f${o.id}-chat`, "--cwd", t.worktree,
    "--label", `factory.ticket=${o.id}`, "--label", "factory.stage=chat", ...cmd]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal: string;
  try { terminal = JSON.parse(hc.out).address; } catch { throw new Error(`hc run printed no address: ${hc.out.slice(0, 200)}`); }
  const session = Number(db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, cwd, claude_session, transcript, paused_ticket) VALUES (?, 'chat', 'chat', ?, ?, ?, ?, ?, ?, ?)")
    .run(o.id, terminal, JSON.stringify(cs.argv), now, t.worktree, cs.id, cs.transcript, paused ? 1 : 0).lastInsertRowid);
  journalSessionStart(db, { ticket: o.id, session, stage: CHAT, agent: CHAT, transcript: cs.transcript, at: now, why: "your own session, outside the blueprint" });
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(o.id, `opened a chat session${paused ? `; paused at ${t.stage}` : ""}`, now);
  return { terminal, started: true, paused };
}

// Its session ends; a ticket it paused, and that is still paused, resumes.
function chatEnded(db: Database, o: { dir?: string; repo?: string; id: number; run?: Run; now?: string; session: Open; why?: string }) {
  const now = o.now ?? new Date().toISOString();
  endSessions(db, { ticket: o.id, id: o.session.id, at: now, why: o.why ?? "chat closed" });
  const state = (db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as { state: string } | null)?.state;
  if (!o.session.paused_ticket || state !== "paused" || !o.dir || !o.repo) return { resumed: null };
  journal(db, { ticket: o.id, kind: "resume", text: "your chat session closed: the blueprint carries on", at: now });
  return { resumed: resume(db, { dir: o.dir, repo: o.repo, id: o.id, run: o.run, now }) };
}

// `factory chat <id> --close`, or the daemon's tick once its terminal is gone: it stops, and a
// ticket it paused resumes. `resume` (p on a paused ticket) closes it first, without resuming twice.
export function closeChat(db: Database, o: { dir?: string; repo?: string; id: number; run?: Run; now?: string; resume?: boolean; why?: string }) {
  const run = o.run ?? sh;
  const s = openChat(db, o.id);
  if (!s) return { closed: null, resumed: null };
  if (alive(run, s.terminal)) run(["hc", "kill", s.terminal]);
  const r = o.resume === false ? (endSessions(db, { ticket: o.id, id: s.id, at: o.now ?? new Date().toISOString(), why: o.why ?? "chat closed" }), { resumed: null })
    : chatEnded(db, { ...o, run, session: s });
  return { closed: s.terminal, ...r };
}
