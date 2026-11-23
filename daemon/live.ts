// The live roster (M7): every agent running for every factory under FACTORY_HOME, one row
// each, with its factory, repo, ticket, PR, stage and status, and every repo of every
// factory, running or not. Overwatch reads it (agents-live.json, written each tick, or
// `factory agents live`) to answer "what's running, what's blocked, who is working on X".
// It reads only the factories' databases and one `hc ls`: no network.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listRepos, open, type Repo } from "./db.ts";
import { isFactoryAgent } from "./agents.ts";
import { writeIfChanged } from "./files.ts";
import { factoryHome, readState } from "./overwatch.ts";
import type { Run } from "./runner.ts";

export const liveFile = (home = factoryHome()) => join(home, "agents-live.json");

// working: Herdr says its agent is working. waiting: it waits on you in its terminal (Herdr
// says blocked, or the daemon flagged the ticket). blocked: the ticket can't go on by itself
// (waits on another ticket, parked, paused, stopped by the plan limit, or needs you outside
// the terminal). cloud: the ticket runs in the cloud. idle: none of these (its agent is
// between turns, its terminal is gone, or the stage is the daemon's own).
export type LiveStatus = "working" | "waiting" | "blocked" | "cloud" | "idle";

export type LiveAgent = {
  factory: string | null; // null: a factory agent for every factory (Overwatch)
  repo: string | null;
  agent: string | null; // null: a stage the daemon runs itself (a check, a gate, the PR)
  tier: "global" | "repo" | null;
  ticket: { id: number; title: string } | null;
  pr: number | null;
  stage: string | null;
  status: LiveStatus;
  why: string;
  terminal: string | null;
  live: boolean | null; // its terminal is in `hc ls`; null when Herdr couldn't be asked
  started_at: string | null;
  tokens: { input: number; output: number };
};

export type Roster = {
  version: 1;
  generated_at: string;
  herdr: boolean;
  factories: { name: string; dir: string; repos: Repo[] }[];
  agents: LiveAgent[];
};

type Term = { address: string; agent?: string; status?: string; name?: string };

// Every live terminal, by address (and by name: a session the fallback named), from one `hc ls`.
export function liveTerminals(run: Run): Map<string, Term> | null {
  try {
    const r = run(["hc", "ls", "--json"]);
    if (r.code !== 0) return null;
    const ts = (JSON.parse(r.out).terminals ?? []) as Term[];
    return new Map(ts.flatMap((t) => [[t.address, t] as const, ...(t.name ? [[t.name, t] as const] : [])]));
  } catch { return null; }
}

type Row = Record<string, any>;

export function statusOf(t: Row | null, term: Term | undefined, cloud: boolean): { status: LiveStatus; why: string } {
  if (cloud || t?.location === "cloud") return { status: "cloud", why: "runs in the cloud" };
  if (term?.status === "blocked") return { status: "waiting", why: `waiting on you in its terminal (${term.address})` };
  if (t?.needs_kind === "attention") return { status: "waiting", why: t.needs_text ?? "waiting on you in its terminal" };
  if (t?.state === "blocked") return { status: "blocked", why: `waits on #${t.blocked_by}` };
  if (t?.state === "parked" || t?.state === "paused") return { status: "blocked", why: `${t.state}${t.detail ? `: ${t.detail}` : ""}` };
  if (t?.resume_at) return { status: "blocked", why: `stopped by the plan limit; resumes at ${t.resume_at}` };
  if (t?.needs_kind) return { status: "blocked", why: `needs you: ${t.needs_text ?? t.needs_kind}` };
  if (term?.status === "working") return { status: "working", why: "working" };
  if (term) return { status: "idle", why: term.agent && !/claude|codex/.test(term.agent) ? "its agent exited; the shell is back" : `between turns (${term.status ?? "no status yet"})` };
  return { status: "idle", why: t?.detail ?? "no live terminal" };
}

const factoryNames = (home: string) =>
  existsSync(home) ? readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db"))).sort() : [];

// One factory's rows: each open session, and each running ticket with none (a daemon stage).
export function factoryAgents(db: Database, name: string, terms: Map<string, Term> | null): LiveAgent[] {
  const lead = listRepos(db).find((r) => r.lead)?.slug ?? null;
  const work = Map.groupBy(db.query("SELECT ticket, repo, lead, worktree, pr_number FROM ticket_repos ORDER BY lead DESC, repo").all() as Row[], (r) => r.ticket);
  const tickets = new Map((db.query("SELECT * FROM tickets").all() as Row[]).map((t) => [t.id, t]));
  // The repo a session works in: the one whose worktree is its folder, else the ticket's lead.
  const repoOf = (ticket: number, cwd: string | null) => {
    const rs = work.get(ticket) ?? [];
    return rs.find((r) => r.worktree && cwd && (cwd === r.worktree || cwd.startsWith(`${r.worktree}/`))) ?? rs[0] ?? null;
  };
  const sessions = db.query("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY ticket, id").all() as Row[];
  const rows: LiveAgent[] = sessions.map((s) => {
    const t = tickets.get(s.ticket) ?? null;
    const term = s.terminal ? terms?.get(s.terminal) : undefined;
    const r = repoOf(s.ticket, s.cwd);
    return {
      factory: name, repo: r?.repo ?? lead, agent: s.agent, tier: s.agent === "cloud" || !s.agent ? null : isFactoryAgent(s.agent) ? "global" : "repo",
      ticket: t && { id: t.id, title: t.title }, pr: r?.pr_number ?? null, stage: s.stage,
      ...statusOf(t, term, s.agent === "cloud"),
      terminal: s.terminal ?? null, live: terms ? !!term : null, started_at: s.started_at,
      tokens: { input: s.tokens_in, output: s.tokens_out },
    };
  });
  const withSession = new Set(sessions.map((s) => s.ticket));
  for (const t of tickets.values()) {
    if (t.state !== "running" || withSession.has(t.id)) continue;
    const r = repoOf(t.id, null);
    const began = db.query("SELECT started_at FROM stages WHERE ticket = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(t.id) as { started_at: string } | null;
    rows.push({
      factory: name, repo: r?.repo ?? lead, agent: null, tier: null, ticket: { id: t.id, title: t.title }, pr: r?.pr_number ?? null, stage: t.stage,
      ...statusOf(t, undefined, false), terminal: null, live: terms ? false : null, started_at: began?.started_at ?? null,
      tokens: { input: t.tokens_in, output: t.tokens_out },
    });
  }
  return rows.sort((a, b) => (a.ticket?.id ?? 0) - (b.ticket?.id ?? 0));
}

// `db`: the daemon's open handle for a factory, kept open; a factory it has none for is opened and closed.
export function liveRoster(o: { run: Run; now: string; home?: string; db?: (name: string) => Database | undefined }): Roster {
  const home = o.home ?? factoryHome();
  const terms = liveTerminals(o.run);
  const factories: Roster["factories"] = [];
  const agents: LiveAgent[] = [];
  // Overwatch, when its terminal is live: one for every factory (overwatch.ts).
  const ow = readState(home);
  const owTerm = ow.terminal ? terms?.get(ow.terminal) : undefined;
  if (owTerm) agents.push({ factory: null, repo: null, agent: "overwatch", tier: "global", ticket: null, pr: null, stage: null,
    ...statusOf(null, owTerm, false), terminal: ow.terminal!, live: true, started_at: ow.started_at ?? null, tokens: { input: 0, output: 0 } });
  for (const name of factoryNames(home)) {
    const kept = o.db?.(name);
    const db = kept ?? open(join(home, name, "factory.db"));
    try {
      factories.push({ name, dir: join(home, name), repos: listRepos(db) });
      agents.push(...factoryAgents(db, name, terms));
    } finally { if (!kept) db.close(); }
  }
  return { version: 1, generated_at: o.now, herdr: terms != null, factories, agents };
}

// Atomic, and skipped when only generated_at changed (files.ts).
export function writeLive(roster: Roster, home = factoryHome()) {
  writeIfChanged(liveFile(home), JSON.stringify(roster, null, 2) + "\n");
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// `factory agents live`, for a person or an agent reading a terminal.
export function rosterText(r: Roster) {
  const lines = [`${r.agents.length} running${r.herdr ? "" : " (Herdr didn't answer: statuses come from the stage state)"}`];
  for (const a of r.agents) {
    const who = a.agent ? `${a.agent} (${a.tier ?? "cloud"})` : "daemon";
    const what = a.ticket ? `#${a.ticket.id} ${a.ticket.title}` : "every factory";
    lines.push(`- ${a.status.padEnd(7)} ${a.factory ?? "all"} · ${a.repo ?? "-"} · ${what}${a.pr ? ` · PR #${a.pr}` : ""} · ${a.stage ?? "-"} · ${who}` +
      `${a.terminal ? ` · ${a.terminal}${a.live === false ? " (gone)" : ""}` : ""}${a.started_at ? ` · since ${a.started_at}` : ""}` +
      `${a.tokens.input || a.tokens.output ? ` · ${k(a.tokens.input)} in / ${k(a.tokens.output)} out` : ""} — ${a.why}`);
  }
  lines.push("", "Repos:");
  for (const f of r.factories) lines.push(`- ${f.name}: ${f.repos.length ? f.repos.map((x) => `${x.slug} (${x.path}${x.lead ? ", lead" : ""})`).join(", ") : "no repo yet"}`);
  return lines.join("\n");
}
