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
  // An agent waiting on you in its terminal needs you, whatever stage it's in.
  if (t.state === "parked" || (t.state === "grooming" && t.needs) || t.needs?.kind === "attention") return "needs";
  if (t.state === "running") return "running";
  if (t.state === "ready") return "ready";
  if (["queued", "paused", "blocked", "grooming"].includes(t.state)) return "queue";
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
  const rank = { attention: 0, question: 1, merge: 2, parked: 3 }; // a live agent waiting comes first
  return tickets
    .filter((t) => t.needs || t.state === "ready")
    .map((t) => ({ ticket: t, kind: t.needs?.kind ?? "merge" }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.ticket.id - b.ticket.id);
}

// "62%", or "–" when nothing reports the plan's usage (no reading, no limits set).
export const planPct = (plan, key) => (plan?.source === "none" ? "–" : `${Math.round((plan?.[key] ?? 0) * 100)}%`);

export function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// compact()'s inverse, for what people type: "3M", "1.5m", "200k", "250000".
export function parseTokens(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? (m[2].toLowerCase() === "m" ? 1e6 : 1e3) : 1));
}

export function ago(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// Home's line for one repo's last full-suite run (status.json health[]): what happened, and
// the first failure's opening line when it failed. tone: pass | fail | none (couldn't run).
export function healthLine(h, now = Date.now()) {
  const where = [h.repo, h.branch].filter(Boolean).join(" · ");
  const when = ago(h.at, now);
  if (h.ok === true) return { tone: "pass", text: `${where} · full suite passed ${when}`, detail: null };
  if (h.ok === false) return { tone: "fail", text: `${where} · \`${h.command}\` failed ${when}${h.ticket != null ? ` · #${h.ticket}` : ""}`,
    detail: (h.failure ?? "").split("\n").find((l) => l.trim())?.trim() ?? null };
  return { tone: "none", text: `${where} · couldn't run ${when}`, detail: h.error ?? null };
}

// "watching · checked 2m ago": the daemon is reading the PR's comments; null when it isn't.
export const watchNote = (t, now = Date.now()) => (t.pr?.watched && t.pr.checked_at ? `watching · checked ${ago(t.pr.checked_at, now)}` : null);

// 14:05, in this machine's time.
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// The sidebar row's second line, as in docs/layouts/01-home.png.
export function subtitle(t, now = Date.now()) {
  switch (groupOf(t)) {
    case "needs":
      return t.state === "parked" ? `parked · ${t.detail ?? "stuck"}` : `grooming · ${t.detail ?? "questions"}`;
    case "running":
      if (t.resume_at) return `${t.stage} · plan reset · resumes ${clock(t.resume_at)}`;
      return t.where === "cloud" ? `${t.stage} · in cloud` : `${t.stage} · ${compact(t.tokens.input)}/${compact(t.budget.input)} in`;
    case "ready":
      return watchNote(t, now) ?? "ready";
    case "queue":
      return t.state === "blocked" ? `blocked by #${t.blocked_by}` : t.state === "paused" ? `paused at ${t.stage ?? "start"}` : t.state;
    default:
      return t.state;
  }
}

// The repos a ticket works in, lead first. Before multi-repo (or in a fixture without
// them) that's the factory's repo.
export const ticketRepos = (t, lead) => t.repos ?? [{ slug: lead, lead: true, pr: t.pr ?? null, worktree: null }];
export const factoryRepos = (s) => s.factory.repos ?? [s.factory.repo];
const short = (slug) => slug.slice(slug.indexOf("/") + 1);

// A row's repo badge: only when the factory has more than one repo. "api", or "api + web".
export function repoBadge(s, t) {
  if (factoryRepos(s).length < 2) return null;
  return ticketRepos(t, s.factory.repo).map((r) => short(r.slug)).join(" + ");
}

// The Ticket page's cross-repo cards (docs/layouts/02b-ticket-cross-repo.png), in the
// order the ticket's repos come (lead first). null for a ticket in one repo.
const NTH = ["1st", "2nd", "3rd"];
export function crossRepoCards(t) {
  const repos = t.repos ?? [];
  if (repos.length < 2) return null;
  const byOrder = [...repos].sort((a, b) => (a.merge ?? 99) - (b.merge ?? 99));
  const name = (r) => (r.pr ? `#${r.pr.number}` : r.slug);
  return repos.map((r) => {
    const at = byOrder.indexOf(r);
    const before = byOrder[at - 1];
    return {
      slug: r.slug, role: r.lead ? "lead" : "linked", branch: r.branch ?? "no branch yet",
      pr: r.pr ? `PR #${r.pr.number}` : "no PR yet",
      order: r.merged_at ? "merged" : `merges ${NTH[at] ?? `${at + 1}th`}${before ? `, after ${name(before)}` : ""}`,
      merged: !!r.merged_at,
    };
  });
}

// A ticket's pull requests, one per repo that has one, lead first: what the Tickets page
// and the Ticket page show and open. `text` is "#6", or "web#6" when the ticket spans repos.
// A PR from an older status.json has no url or state: the link is built, the state reads open.
const PR_WORDS = { open: "open", draft: "draft", merged: "merged", closed: "closed" };
export const prColor = (th, state) => ({ open: th.accent, draft: th.muted, merged: th.done, closed: th.dim })[state] ?? th.muted;
export function prLinks(t, lead = "") {
  const repos = ticketRepos(t, lead);
  const cross = repos.length > 1;
  return repos.filter((r) => r.pr).map((r) => {
    const state = r.pr.state ?? (t.state === "merged" ? "merged" : t.state === "closed" ? "closed" : "open");
    return {
      slug: r.slug, number: r.pr.number, state, word: PR_WORDS[state] ?? state,
      text: cross ? `${short(r.slug)}#${r.pr.number}` : `#${r.pr.number}`,
      url: r.pr.url ?? (r.slug ? `https://github.com/${r.slug}/pull/${r.pr.number}` : null),
    };
  });
}

// The Tickets page's state chips (docs/layouts/03-tickets.png).
export const FILTERS = [
  { id: "all", title: "All", states: null },
  { id: "grooming", title: "Grooming", states: ["grooming"] },
  { id: "queue", title: "Queue", states: ["queued", "paused", "blocked"] },
  { id: "running", title: "Running", states: ["running"] },
  { id: "parked", title: "Parked", states: ["parked"] },
  { id: "ready", title: "Ready", states: ["ready"] },
  { id: "merged", title: "Merged", states: ["merged", "closed"] },
];

// Newest first; the query matches "#412", "412" or words of the title, blueprint or stage.
// `repo` (a slug, or null for all) keeps the tickets that work in it; `lead` is the factory's repo.
export function filterTickets(tickets, filterId, query = "", repo = null, lead = "") {
  const f = FILTERS.find((x) => x.id === filterId) ?? FILTERS[0];
  const words = query.toLowerCase().replace(/#/g, "").split(/\s+/).filter(Boolean);
  return tickets
    .filter((t) => !f.states || f.states.includes(t.state))
    .filter((t) => !repo || ticketRepos(t, lead).some((r) => r.slug === repo))
    .filter((t) => {
      const hay = `${t.id} ${t.title} ${t.blueprint} ${t.stage ?? ""} ${t.state} ${ticketRepos(t, lead).map((r) => r.slug).join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export const countBy = (tickets, repo = null, lead = "") => Object.fromEntries(FILTERS.map((f) => [f.id, filterTickets(tickets, f.id, "", repo, lead).length]));

// The Config page's file list: factory.yaml first, then each kind in plan order.
const KINDS = ["factory.yaml", "blueprint.yaml", "blueprints/", "steps/", "agents/", "prompts/", "triggers/", "benchmarks/"];
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

// The Ticket page's links to the ticket's files shared on claude.ai, spec first.
const SHARED_ORDER = ["INTENT.md", "SLICES.md", "PR.md", "HANDOFF.md"];
export const sharedLinks = (t) => [...(t?.artifacts ?? [])]
  .sort((a, b) => (SHARED_ORDER.indexOf(a.file) + 1 || 99) - (SHARED_ORDER.indexOf(b.file) + 1 || 99))
  .map((a) => ({ file: a.file, url: a.url, label: `${a.file} ↗`, kind: a.kind === "doc" ? "Claude Doc" : "artifact" }));

// The Ticket page's ticket: the one last opened, else the first running one.
export const currentTicket = (tickets, id) =>
  tickets.find((t) => t.id === id) ?? tickets.find((t) => t.state === "running") ?? tickets[0];

// Config's Daemon bar, from `factory service status --json`, or the CLI's own words when it fails.
// atLogin drives the "Start at login" checkbox; before install it is null and the box is the
// window's own choice, which Install passes as --login.
// An older CLI says nothing of at_login: it always started at login.
export function daemonView(s, error = "") {
  if (!s) return { text: `factory CLI failed: ${error.trim().split("\n")[0] || "no answer"}`, tone: "blocked", actions: [], atLogin: null };
  if (!s.installed) return { text: "Not installed: the daemon runs only while a terminal runs `factory run`", tone: "dim", actions: ["install"], atLogin: null };
  const atLogin = s.at_login ?? true;
  if (s.state === "running") return { text: `Running · pid ${s.pid}${atLogin ? " · starts at login" : ""}`, tone: "done", actions: ["restart", "uninstall", "logs"], atLogin };
  if (!atLogin && s.state === "not running") return { text: "Stopped · it doesn't start at login", tone: "dim", actions: ["start", "uninstall", "logs"], atLogin };
  return { text: `Installed but ${s.state}`, tone: "blocked", actions: ["restart", "uninstall", "logs"], atLogin };
}

// The budget warning's short mark for a row: "83%" from "83% of its token budget used", else "!".
export const warnMark = (t) => (t.warning ? (t.warning.match(/^\d+%/)?.[0] ?? "!") : null);

// A stage's detail line on the Ticket page. The stage that is running gets "session N" once
// there's been a handoff (a first session says nothing); "handoff at 60%" shows in amber.
export function stageDetail(st, t) {
  const session = st.state === "now" && t.session > 1 ? `session ${t.session}` : "";
  const rest = (st.detail ?? "").split(" · ").filter((p) => !ROUNDS.test(p)).join(" · ");
  return { text: [rest, session].filter(Boolean).join(" · "), warn: /handoff at \d+%/.test(st.detail) };
}

// Home's hold line, and the running tickets the "move to cloud" button would move.
export const holdText = (s) => (s.plan.hold ? `Nothing new starts: ${s.plan.hold}` : null);
export const localRunning = (tickets) => tickets.filter((t) => t.state === "running" && t.where === "local");

// Which factory a space shows: a ticket's space sits in ~/.factory/<name>/tickets/<id>, and
// a ticket's worktree in ~/.herdr/worktrees/<repo>/<branch>; any other space is its
// repo's checkout, named by its folder (as \`factory\` names it).
export function factoryOf(folder, home) {
  if (!folder) return null;
  const under = (base) => (folder.startsWith(`${base}/`) ? folder.slice(base.length + 1).split("/")[0] || null : null);
  return under(`${home}/.factory`) ?? under(`${home}/.herdr/worktrees`) ?? folder.split("/").filter(Boolean).pop() ?? null;
}

// A grouped stage's rounds note ("4 rounds", "failed 3×, then passed"), which the daemon
// writes first in the detail. null for a stage that ran once.
const ROUNDS = /^(\d+ rounds|failed \d+×(?:, then passed)?)$/;
export const stageRounds = (st) => (st.detail ?? "").split(" · ").find((p) => ROUNDS.test(p)) ?? null;

// The Ticket page's questions: Q1, Q2… as the `A1:` answers number them, each with who answers.
// Product questions wait on the product owner; engineering ones are the person's own.
export function questionCards(t) {
  return (t.questions ?? []).map((q) => ({
    label: `Q${q.n}`, text: q.text, kind: q.kind,
    who: q.kind === "product" ? "product · waits on the product owner" : "engineering · yours to answer",
    reply: `A${q.n}: …`,
  }));
}
export const ANSWER_HOW = "Press u in this window, or reply on the issue with one line per answer, such as A1: …";

// An agent as a sentence names it: you, Overwatch, the learner, the builder.
export const agentLabel = (a) => (!a || a === "you" ? "you" : a === "overwatch" ? "Overwatch" : `the ${a}`);
// Config's Pending changes: notes agents left each other (factory ask), still open, requests
// for the maintainer among them: "from the learner to the maintainer".
export const pendingNotes = (asks = []) => asks.map((a) => ({ ...a, route: `from ${agentLabel(a.from)} to ${agentLabel(a.to)}` }));
// Home's Needs you: what other agents asked Overwatch to bring to you.
export const overwatchNotes = (asks = []) => pendingNotes(asks.filter((a) => a.to === "overwatch"));
