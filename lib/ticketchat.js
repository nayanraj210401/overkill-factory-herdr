// The V2 Ticket page's Chat view (mods/factory-chat, adapted from herdr-chat): which of the
// ticket's agent sessions it shows, the transcript it reads, and the terminal it types into.
// Pure, no Herdr imports, so the chat, the page and `node --test` share it.
import { v2UI } from "./model.js";
import { when, cut, digestView, activity } from "./ticketv2.js";

// The page's top-level switch, drawn only while the V2_UI gate is on. ⌘⌥7–9 (factory-ticket.view-*)
// pick them; ⌘⌥1–6 stay the Overview's own tabs.
export const TICKET_VIEWS = [
  { id: "overview", title: "Overview", key: "7" },
  { id: "chat", title: "Chat", key: "8" },
  { id: "diff", title: "Diff", key: "9" },
];
export const ticketViews = (s) => (v2UI(s) ? TICKET_VIEWS : null);
// A factory-ticket command ("view-chat", from keys.json) as the view it picks, or null.
export const viewOf = (command) => TICKET_VIEWS.find((v) => command === `view-${v.id}`)?.id ?? null;

export const NO_AGENT = "No agent running. Open Your session to work on it yourself, or use Talk it through (u) or Answer & resume.";

// A session with this stage is the person's own on the ticket, outside its blueprint (daemon/chat.ts).
export const OWN_STAGE = "chat";

// `factory sessions <id> --json`'s rows as the switcher's: oldest first, each numbered within
// its stage ("implement · 2 · 10:04"). `live`: the session whose terminal the ticket's agent
// runs in now (status.json's terminal is the open session's). `file`: its Claude transcript.
export function chatSessions(rows, ticket, now = Date.now()) {
  const seen = {};
  return (rows ?? []).filter((r) => r && typeof r.stage === "string").map((r) => {
    const n = (seen[r.stage] = (seen[r.stage] ?? 0) + 1);
    const live = !r.ended_at && Boolean(ticket?.terminal) && r.terminal === ticket.terminal;
    const own = r.stage === OWN_STAGE;
    return {
      id: r.id, stage: r.stage, n, agent: own ? "your session" : r.agent ?? null, terminal: r.terminal ?? null, live,
      open: !r.ended_at, own, paused: Boolean(r.paused_ticket),
      file: r.transcript ?? null, claude: r.claude_session ?? null, cloud: r.agent === "cloud",
      label: `${own ? "your session" : r.stage} · ${n} · ${r.started_at ? when(r.started_at, now) : "?"}`,
    };
  });
}

// The session the chat shows: the one you picked, else the live one, else the newest with a
// transcript, else the newest.
export function pickSession(list, picked = null) {
  return list.find((x) => x.id === picked) ?? list.find((x) => x.live) ?? list.findLast((x) => x.file || x.claude) ?? list.at(-1) ?? null;
}

// What the chat does with the shown session: the transcript it reads, the terminal it types
// into (only the live session's, only on a real factory), and why it's read-only when it is.
export function chatTarget(ticket, session, { daemon = true, sessions = [] } = {}) {
  const file = session?.file ?? null;
  if (!daemon) return { file, terminal: null, readonly: true, note: "Sample data: a real ticket's agent chats here." };
  if (!ticket?.terminal) return { file, terminal: null, readonly: true, note: NO_AGENT };
  if (session && !session.live) {
    const live = sessions.find((x) => x.live);
    return { file, terminal: null, readonly: true, note: `An earlier session, read-only.${live ? ` ${live.label} is live: pick it to message the agent.` : ""}` };
  }
  return { file, terminal: ticket.terminal, readonly: false, note: null };
}

// The Your session button in the chat's head: open your own session on the ticket (pausing a
// running blueprint), or close the open one (resuming a ticket it paused). Null where there's no
// worktree to work in, or on sample data. `factory chat <id> [--close]` does the work.
export function ownChat(ticket, sessions, daemon = true) {
  if (!daemon || !ticket || ["grooming", "queued", "closed", "merged"].includes(ticket.state)) return null;
  const open = (sessions ?? []).find((x) => x.own && x.open);
  if (open) return { action: "close", args: ["chat", String(ticket.id), "--close"], label: "Close your session",
    tip: open.paused ? "End your session; the blueprint resumes where it paused" : "End your session" };
  return { action: "open", args: ["chat", String(ticket.id)], label: "Your session",
    tip: ticket.state === "running" ? "Your own session on this ticket, outside the blueprint. The blueprint pauses until you close it." : "Your own session on this ticket, outside the blueprint" };
}

// The chat's empty state when there's nothing to read yet.
export function chatEmpty(session, sessions, target) {
  if (!sessions.length) return "No agent session yet: the chat shows one once a stage starts.";
  if (session?.cloud) return "This session runs in the cloud: its transcript isn't on this machine.";
  if (!session?.file && !session?.claude) return "This session has no transcript recorded.";
  return target.terminal ? "Loading the conversation…" : "Reading the transcript…";
}

// ── phase 2: the sidebar as the thread list, and the Changes + ticket memory panel ──────────

// shared.json keys (per viewer). The Ticket page writes the view it shows; the sidebar reads it
// and, to open a ticket on Chat, asks for it ({ id, view, at }); the panel's open or closed.
export const VIEW_KEY = "factory.ticket.view";
export const OPEN_KEY = "factory.ticket.open";
export const PANEL_KEY = "factory.chat.panel";
export const PANEL_W = 300; // the panel's width
export const PANEL_MIN = 860; // the Chat view's width under which the panel folds away (the chat keeps 560)
export const PANEL_HINT = "⌘⌥0";

// The view a sidebar click asked for, if it's for this ticket and fresh (a stale one in
// shared.json, from before a restart, is ignored).
export const askedView = (ask, id, now = Date.now()) => (ask && ask.id === id && TICKET_VIEWS.some((v) => v.id === ask.view) && now - ask.at < 10_000 ? ask.view : null);

// Open unless this viewer closed it; shown only when the Chat view is wide enough beside it.
export const panelOpen = (v) => v !== false;
export const panelShown = (open, width) => Boolean(open) && !(width > 0 && width < PANEL_MIN);

// The digest, short: "Current state" first, then the other sections in order, at most three,
// each to three lines; "- none" lines are left out.
export function shortDigest(sections, max = 3, lines = 3) {
  const order = [...sections].sort((a, b) => (b.heading === "Current state") - (a.heading === "Current state"));
  return order.map((s) => ({ heading: s.heading, lines: s.body.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-*]\s*none\.?$/i.test(l)).slice(0, lines).map((l) => cut(l, 160)) }))
    .filter((s) => s.lines.length).slice(0, max);
}

// What the panel shows. `diff`: diffFiles' answer ({ files, add, del, text }) or { error } or null
// while read; `memory`: { digest } | { error } | null while read (factory digest --json, as the
// Memory tab reads it); `digestView`/`activity` come from lib/ticketv2.js.
export function chatPanel({ ticket, diff, memory, daemon = true, now = Date.now(), events = 4 }) {
  const started = !["grooming", "queued"].includes(ticket.state);
  const changes = !started ? { note: "No changes: it hasn't started.", files: [], total: "" }
    : !daemon ? { note: "Sample data: a real ticket's changed files show here.", files: [], total: "" }
    : !diff ? { note: "Reading the diff…", files: [], total: "" }
    : diff.error ? { note: diff.error, files: [], total: "" }
    : !diff.files.length ? { note: "No changes yet.", files: [], total: "" }
    : { note: null, files: diff.files, total: diff.text };
  const v = memory && !memory.error ? digestView(memory.digest, ticket.id, now) : null;
  const digest = !daemon ? { note: "Sample data: a real ticket's digest shows here.", sections: [], age: null }
    : !memory ? { note: "Reading the digest…", sections: [], age: null }
    : memory.error ? { note: memory.error, sections: [], age: null }
    : v.state === "none" ? { note: "No digest yet.", sections: [], age: null }
    : { note: v.state === "inherited" ? `Inherited from #${memory.digest.from}.` : null, sections: shortDigest(v.sections), age: v.age };
  return { changes, digest, events: activity(ticket.events, now, events) };
}
