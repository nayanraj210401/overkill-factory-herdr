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
      age: age(t.updated_at, now), since: null, terminal: t.terminal ?? null, idle: false,
    })),
  ];
  const waits = new Set(needs.map((n) => n.ticket.id));
  const working = [
    ...tickets.filter((t) => t.state === "running" && !waits.has(t.id)).map((t) => ({
      key: `t-${t.id}`, kind: "work", ticket: t.id, agent: null, title: t.title, sub: workingLine(t),
      age: null, since: t.stage_started_at ?? null, terminal: t.terminal ?? null, idle: !!t.resume_at,
    })),
    ...globals.filter((a) => a.status === "working").map((a) => agentRow(a, "work")),
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
