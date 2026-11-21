// Pure views over a validated status.json: the sidebar groups, Home's sections,
// and the short labels the mods print. No Herdr imports.

export const GROUPS = [
  { id: "needs", title: "Needs you" },
  { id: "running", title: "Running" },
  { id: "ready", title: "Ready for review" },
  { id: "queue", title: "Queue" },
];

// A grooming ticket needs you only while it has open questions.
export function groupOf(t) {
  if (t.state === "parked" || (t.state === "grooming" && t.needs)) return "needs";
  if (t.state === "running") return "running";
  if (t.state === "ready") return "ready";
  if (t.state === "queued" || t.state === "blocked" || t.state === "grooming") return "queue";
  return null; // merged, closed: Tickets page only
}

export function groupTickets(tickets) {
  const out = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
  for (const t of tickets) {
    const g = groupOf(t);
    if (g) out[g].push(t);
  }
  return out;
}

// Home's "Needs you": parked and questions, plus PRs ready to merge.
export function needsYou(tickets) {
  const rank = { question: 0, merge: 1, parked: 2 };
  return tickets
    .filter((t) => t.needs || t.state === "ready")
    .map((t) => ({ ticket: t, kind: t.needs?.kind ?? "merge" }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.ticket.id - b.ticket.id);
}

export function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function ago(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// The sidebar row's second line, as in docs/layouts/01-home.png.
export function subtitle(t, now = Date.now()) {
  switch (groupOf(t)) {
    case "needs":
      return t.state === "parked" ? `parked · ${t.detail ?? "stuck"}` : `grooming · ${t.detail ?? "questions"}`;
    case "running":
      return t.where === "cloud" ? `${t.stage} · in cloud` : `${t.stage} · ${compact(t.tokens.input)}/${compact(t.budget.input)} in`;
    case "ready":
      return t.pr?.watched && t.pr.checked_at ? `watching · checked ${ago(t.pr.checked_at, now)}` : "ready";
    case "queue":
      return t.state === "blocked" ? `blocked by #${t.blocked_by}` : t.state;
    default:
      return t.state;
  }
}

// The Tickets page's state chips (docs/layouts/03-tickets.png).
export const FILTERS = [
  { id: "all", title: "All", states: null },
  { id: "grooming", title: "Grooming", states: ["grooming"] },
  { id: "queue", title: "Queue", states: ["queued", "blocked"] },
  { id: "running", title: "Running", states: ["running"] },
  { id: "parked", title: "Parked", states: ["parked"] },
  { id: "ready", title: "Ready", states: ["ready"] },
  { id: "merged", title: "Merged", states: ["merged", "closed"] },
];

// Newest first; the query matches "#412", "412" or words of the title, blueprint or stage.
export function filterTickets(tickets, filterId, query = "") {
  const f = FILTERS.find((x) => x.id === filterId) ?? FILTERS[0];
  const words = query.toLowerCase().replace(/#/g, "").split(/\s+/).filter(Boolean);
  return tickets
    .filter((t) => !f.states || f.states.includes(t.state))
    .filter((t) => {
      const hay = `${t.id} ${t.title} ${t.blueprint} ${t.stage ?? ""} ${t.state}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export const countBy = (tickets) => Object.fromEntries(FILTERS.map((f) => [f.id, filterTickets(tickets, f.id).length]));

// The Config page's file list: factory.yaml first, then each kind in plan order.
const KINDS = ["factory.yaml", "blueprint.yaml", "blueprints/", "agents/", "triggers/", "benchmarks/"];
const rank = (p) => { const i = KINDS.findIndex((k) => (k.endsWith("/") ? p.startsWith(k) : p === k)); return i < 0 ? KINDS.length : i; };
export function configFiles(paths) {
  return paths
    .filter((p) => /\.(ya?ml|md)$/.test(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((path) => ({ path, language: path.endsWith(".md") ? "markdown" : "yaml" }));
}

// STATUS.md (written by the daemon): one plain sentence, then "- done|now|next Stage · …" lines.
export function parseStatusMd(text) {
  const lines = (text ?? "").split("\n");
  const summary = lines.find((l) => l.trim() && !l.startsWith("-"))?.trim() ?? "";
  const stages = lines
    .map((l) => l.match(/^- (done|now|next) ([^·]+?)\s*(?:· (.*))?$/))
    .filter(Boolean)
    .map(([, state, name, rest]) => {
      const parts = (rest ?? "").split(" · ").filter(Boolean);
      const time = /^\d+[smhd]$/.test(parts[0] ?? "") ? parts.shift() : null;
      return { state, name: name.trim(), time, detail: parts.join(" · ") };
    });
  return { summary, stages };
}

// The ticket page's numbered tabs.
export const TICKET_TABS = [
  { key: "1", title: "Plan", file: "SLICES.md" },
  { key: "2", title: "Checks", file: "EVIDENCE.md" },
  { key: "3", title: "Questions", file: "GATES.md" },
  { key: "4", title: "PR", file: "PR.md" },
];

// The Ticket page's ticket: the one last opened, else the first running one.
export const currentTicket = (tickets, id) =>
  tickets.find((t) => t.id === id) ?? tickets.find((t) => t.state === "running") ?? tickets[0];
