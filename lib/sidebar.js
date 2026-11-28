// The sidebar (plan.md, Layout design): only what's alive and what waits on the person.
// Waiting on you (pinned, hidden when empty), Working (live agents, each with a timer), a
// quiet line for the queue, and Settled (folded). Pure, no Herdr imports: the factory-tickets
// mod draws these rows and `node --test` checks them.
import { needsYou } from "./model.js";

// A Waiting on you row's glyph: the agent asks, the PR is ready, the ticket is parked.
export const GLYPH = { ask: "?", ready: "✓", parked: "⏸" };
const KIND = { attention: "ask", question: "ask", merge: "ready", parked: "parked" };

// "now", "5m", "2h", "3d": how long a row has waited.
export function age(iso, now) {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// A Working row's live timer: "42s", "12m", "1h 4m", "2d 3h". null with no start time.
export function elapsed(iso, now) {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// How often the sidebar redraws its timers: every second while one still shows seconds.
export const tickMs = (working, now) => (working.some((r) => r.since && now - Date.parse(r.since) < 60_000) ? 1000 : 5000);

// The global agents (Overwatch, the maintainer, the learner, the babysitter) in the live roster
// (agents-live.json's agents) for this factory: theirs, or every factory's (factory null).
const globalsOf = (roster, factory) => (roster ?? []).filter((a) => a?.tier === "global" && a.agent && (a.factory == null || a.factory === factory));

const rulesOf = (detail) => (detail ?? "").match(/(\d+ of \d+) ready rules/)?.[1] ?? null;
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// The second line of a Waiting on you row: why it waits on you.
export function waitingLine(kind, t) {
  if (kind === "attention") return [`${t.agent ?? "its agent"} asks you`, t.stage].filter(Boolean).join(" · ");
  if (kind === "question") {
    const n = t.questions?.length;
    return `grooming · ${n ? `${n} question${n === 1 ? "" : "s"} for you` : t.detail ?? "questions for you"}`;
  }
  if (kind === "parked") return `parked · ${t.detail ?? "stuck"}${t.stage ? ` in ${t.stage}` : ""}`;
  const rules = rulesOf(t.detail);
  return [t.pr ? `PR #${t.pr.number} ready to merge` : "ready to merge", rules && `${rules} rules`].filter(Boolean).join(" · ");
}

// The second line of a Working row: "builder · implement (S2 of 3)", "checker · verify · ☁ cloud".
export function workingLine(t) {
  const stage = t.stage ? `${t.stage}${t.slice ? ` (S${t.slice.n} of ${t.slice.of})` : ""}` : null;
  const parts = [t.agent, stage];
  if (t.resume_at) parts.push(`plan reset · resumes ${hhmm(t.resume_at)}`);
  if (t.where === "cloud") parts.push("☁ cloud");
  return parts.filter(Boolean).join(" · ") || "starting";
}

// ── the v2 sidebar's row extras (lib/model.js v2Sidebar gates the whole layout) ─────────

// A Working row's stage bar: how far the ticket is along its blueprint. While it builds slices
// the bar is the slices; otherwise the blueprint's planned path (status.json's progress, from
// status.ts) with the finished stages behind it. null with neither: no bar.
export function stageBar(t) {
  if (t.slice) return { done: t.slice.n - 1, now: 1, todo: t.slice.of - t.slice.n, label: `slice ${t.slice.n}/${t.slice.of}` };
  if (t.progress) return { done: t.progress.done, now: 1, todo: Math.max(0, t.progress.total - t.progress.done - 1), label: t.progress.now ?? t.stage ?? null };
  return null;
}

// A row's CI dot: the PR's checks (watch.ts's rollup, on ticket_repos.pr_ci). A merged PR is
// its own state; a PR with checks gets pass/fail/running; no checks yet shows nothing.
export function ciDot(t) {
  const pr = t.pr;
  if (!pr) return null;
  if (pr.state === "merged") return { state: "merged", fail: null };
  if (["pass", "fail", "running"].includes(pr.ci)) return { state: pr.ci, fail: pr.ci_fail ?? null };
  return null;
}

// The quiet line under Working: "4 queued · 1 blocked by #425 →". null when both are zero.
// Queued counts what waits its turn: queued, paused, and grooming with no question open.
export function quietLine(tickets) {
  const queued = tickets.filter((t) => ["queued", "paused"].includes(t.state) || (t.state === "grooming" && !t.needs)).length;
  const blocked = tickets.filter((t) => t.state === "blocked");
  if (!queued && !blocked.length) return null;
  const by = [...new Set(blocked.map((t) => t.blocked_by))];
  const b = blocked.length ? `${blocked.length} blocked${by.length === 1 ? ` by #${by[0]}` : ""}` : null;
  return { queued, blocked: blocked.length, text: `${[queued && `${queued} queued`, b].filter(Boolean).join(" · ")} →` };
}

export const SETTLED_DAYS = 7;
export const SETTLED_MAX = 10;

// Every group of the sidebar. s: status.json; roster: agents-live.json's agents ([] without one).
// A row: { key, kind: ask|ready|parked|work|settled, ticket (id) or agent (a global agent's
// name), title, sub, age (Waiting and Settled), since (Working's timer), terminal, idle }.
export function sidebarView(s, roster = [], now = Date.now()) {
  const tickets = s?.tickets ?? [];
  const globals = globalsOf(roster, s?.factory?.name);
  const agentRow = (a, kind) => ({
    key: `a-${a.agent}`, kind, ticket: null, agent: a.agent, title: a.agent, terminal: a.terminal ?? null,
    sub: kind === "ask" ? "asks you · in its terminal"
      : a.ticket ? `${a.stage ?? "working"} · #${a.ticket.id} ${a.ticket.title}` : a.factory ? `factory agent · ${a.factory}` : "factory agent · every factory",
    age: null, since: kind === "work" ? a.started_at ?? null : null, idle: false,
  });
  const needs = needsYou(tickets);
  const waiting = [
    ...globals.filter((a) => a.status === "waiting").map((a) => agentRow(a, "ask")),
    ...needs.map(({ ticket: t, kind }) => ({
      key: `t-${t.id}`, kind: KIND[kind], ticket: t.id, agent: null, title: t.title, sub: waitingLine(kind, t),
      age: age(t.updated_at, now), since: null, terminal: t.terminal ?? null, idle: false, ci: ciDot(t),
    })),
  ];
  const waits = new Set(needs.map((n) => n.ticket.id));
  const working = [
    ...tickets.filter((t) => t.state === "running" && !waits.has(t.id)).map((t) => ({
      key: `t-${t.id}`, kind: "work", ticket: t.id, agent: null, title: t.title, sub: workingLine(t),
      age: null, since: t.stage_started_at ?? null, terminal: t.terminal ?? null, idle: !!t.resume_at,
      bar: stageBar(t), ci: ciDot(t), note: t.notes ?? null,
    })),
    ...globals.filter((a) => a.status === "working").map((a) => ({ ...agentRow(a, "work"), bar: null, ci: null, note: null })),
  ];
  const since = now - SETTLED_DAYS * 86_400_000;
  const done = tickets.filter((t) => ["merged", "closed"].includes(t.state) && Date.parse(t.updated_at) >= since)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const settled = done.slice(0, SETTLED_MAX).map((t) => ({
    key: `t-${t.id}`, kind: "settled", ticket: t.id, agent: null, title: t.title, sub: null,
    age: `${t.state} ${age(t.updated_at, now)}`, since: null, terminal: null, idle: false,
  }));
  return { waiting, working, quiet: quietLine(tickets), settled, settledCount: done.length };
}

// A row's first line: "#412 Rate-limit login", or a global agent's name.
export const rowTitle = (r) => (r.ticket != null ? `#${r.ticket} ${r.title}` : r.title);

// ── the sidebar as the chat's thread list (V2_UI; plan.md, Chat (V2)) ─────────

// Where a row's click goes. A global agent opens as it always has. A ticket opens on the Ticket
// page; with the gate on and the Ticket page shown on its Chat view, a Waiting on you or Working
// row opens that ticket on Chat. `page`: the page the stack shows; `view`: the Ticket page's view.
export function threadTarget(r, { v2 = false, page = null, view = null } = {}) {
  if (r.ticket == null) return { agent: r.agent };
  const chat = v2 && page === "ticket" && view === "chat" && r.kind !== "settled";
  return { ticket: r.ticket, view: chat ? "chat" : null };
}

// The chat-unread marker: the ticket's live transcript grew since this viewer last saw it.
// `seen`: { [ticket id]: { file, size } }, this viewer's (kept in shared.json); `size`: the
// transcript's bytes now, or null before it's read. A ticket never seen has no marker: its
// first sighting is the baseline. A new session's transcript (a handoff) is unread once it has text.
export function chatUnread(t, seen, size) {
  const was = seen?.[t?.id];
  if (!t?.transcript || !(size > 0) || !was) return false;
  return was.file !== t.transcript || size > was.size;
}

// `seen` after a look at the rows' transcripts: a ticket first sighted is its baseline, the one
// on screen in the chat (`viewing`, a ticket id) is read up to now, and tickets no longer in the
// rows drop out. The same object back when nothing changed, so the mod writes shared.json only then.
// `tickets`: the rows' tickets ({ id, transcript }); `sizes`: { [file]: bytes }.
export function seenNext(seen, tickets, sizes, viewing = null) {
  const out = {};
  let changed = false;
  for (const t of tickets) {
    const was = seen?.[t.id];
    const size = t.transcript ? sizes[t.transcript] : undefined;
    if (size == null) { if (was) out[t.id] = was; continue; }
    const now = { file: t.transcript, size };
    if (!was || t.id === viewing) {
      out[t.id] = now;
      if (!was || was.file !== now.file || was.size !== now.size) changed = true;
    } else out[t.id] = was;
  }
  if (Object.keys(seen ?? {}).some((id) => !(id in out))) changed = true;
  return changed ? out : seen ?? {};
}
