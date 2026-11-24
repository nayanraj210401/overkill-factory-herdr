// The V2 Ticket page's Chat view (mods/factory-chat, adapted from herdr-chat): which of the
// ticket's agent sessions it shows, the transcript it reads, and the terminal it types into.
// Pure, no Herdr imports, so the chat, the page and `node --test` share it.
import { v2UI } from "./model.js";
import { when } from "./ticketv2.js";

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

export const NO_AGENT = "No agent running. Use Talk it through (u) or Answer & resume.";

// `factory sessions <id> --json`'s rows as the switcher's: oldest first, each numbered within
// its stage ("implement · 2 · 10:04"). `live`: the session whose terminal the ticket's agent
// runs in now (status.json's terminal is the open session's). `file`: its Claude transcript.
export function chatSessions(rows, ticket, now = Date.now()) {
  const seen = {};
  return (rows ?? []).filter((r) => r && typeof r.stage === "string").map((r) => {
    const n = (seen[r.stage] = (seen[r.stage] ?? 0) + 1);
    const live = !r.ended_at && Boolean(ticket?.terminal) && r.terminal === ticket.terminal;
    return {
      id: r.id, stage: r.stage, n, agent: r.agent ?? null, terminal: r.terminal ?? null, live,
      file: r.transcript ?? null, claude: r.claude_session ?? null, cloud: r.agent === "cloud",
      label: `${r.stage} · ${n} · ${r.started_at ? when(r.started_at, now) : "?"}`,
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

// The chat's empty state when there's nothing to read yet.
export function chatEmpty(session, sessions, target) {
  if (!sessions.length) return "No agent session yet: the chat shows one once a stage starts.";
  if (session?.cloud) return "This session runs in the cloud: its transcript isn't on this machine.";
  if (!session?.file && !session?.claude) return "This session has no transcript recorded.";
  return target.terminal ? "Loading the conversation…" : "Reading the transcript…";
}
