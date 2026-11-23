// Agents are neighbours (plan: The agents): any agent, or you, asks another with
// `factory ask <agent> "<text>" [--why "<evidence>"]`. The daemon routes it by the target's
// territory and records every hand-off in `asks`, with its origin and target:
//   maintainer          a maintainer request (maintainer.ts), as `factory request` files it
//   overwatch           a note in Needs you, typed into the live Overwatch terminal when one runs
//   learner, babysitter a note queued for the agent's next run
//   a repo agent        a note typed into its live session in that repo, else given to its next brief there
// A repo agent is `<owner/name>:<agent>`, or a bare `<agent>`: the asker's own repo, or for a
// global asker the one repo that has it.
//
// Who can ask whom (plan: Peer review): a repo agent asks the global agents and its own repo's
// agents; another repo's goes through a global agent. A global agent, or you, asks anyone.
import type { Database } from "bun:sqlite";
import { FACTORY_AGENTS, isFactoryAgent, repoAgents } from "./agents.ts";
import { leadRepo, listRepos } from "./db.ts";
import { request, type Kind } from "./maintainer.ts";
import type { Run } from "./runner.ts";

// `to` is the agent's name; `toRepo` the repo of a repo agent, null for a global one.
export type Ask = { id: number; from: string; to: string; toRepo: string | null; text: string; why: string | null; about: number | null; request: number | null; at: string; delivered_at: string | null; done_at: string | null };
const row = (r: any): Ask => ({ id: r.id, from: r.from_agent, to: r.to_agent, toRepo: r.to_repo ?? null, text: r.text, why: r.why, about: r.about, request: r.request, at: r.at, delivered_at: r.delivered_at, done_at: r.done_at });
// How a note names its target: `owner/name:agent` for a repo agent.
export const askTarget = (a: Pick<Ask, "to" | "toRepo">) => (a.toRepo ? `${a.toRepo}:${a.to}` : a.to);

// The asker: --from, else the agent this session runs as (FACTORY_AGENT, set by withFactory), else you.
export const askerOf = (flag: string | null | undefined, env = process.env) => flag || env.FACTORY_AGENT || "you";

// Who asks or is asked: a global agent or the person (repo null), or a repo agent in its repo.
export type Who = { agent: string; repo: string | null };
const tier = (w: Who) => (w.agent === "you" ? "you" : isFactoryAgent(w.agent) ? "global" : "repo");

// The rule, pure: a repo agent may ask a global agent or one in its own repo; anyone else, anyone.
export function mayAsk(from: Who, to: Who) {
  return tier(from) !== "repo" || to.repo == null || to.repo === from.repo;
}

// Everyone `from` may ask, as they're named to `factory ask`.
export function askable(db: Database, from: Who) {
  const repos = listRepos(db).filter((r) => mayAsk(from, { agent: "", repo: r.slug }));
  const own = tier(from) === "repo";
  return [...FACTORY_AGENTS, ...repos.flatMap((r) => repoAgents(r.path).map((n) => (own ? n : `${r.slug}:${n}`)))];
}

// `factory ask`'s target, checked against the rule and the factory's repos.
export function resolveTarget(db: Database, from: Who, raw: string): Who {
  const t = raw.trim().toLowerCase();
  const cut = t.lastIndexOf(":");
  const [repo, agent] = cut < 0 ? [null, t] : [t.slice(0, cut), t.slice(cut + 1)];
  const unknown = (what: string) => new Error(`${what}; ${from.agent === "you" ? "you" : from.agent} may ask: ${askable(db, from).join(", ") || "nobody yet"}`);
  if (!agent) throw unknown("ask whom?");
  if (isFactoryAgent(agent)) {
    if (repo != null) throw new Error(`${agent} is a factory agent, one for every repo: factory ask ${agent} "<text>"`);
    return { agent, repo: null };
  }
  const repos = listRepos(db);
  const named = repo ?? (tier(from) === "repo" ? from.repo : null);
  if (named != null) {
    if (!mayAsk(from, { agent, repo: named }))
      throw new Error(`${from.agent} works in ${from.repo} and can't ask ${named}:${agent}: an agent in another repo is asked through a global agent. Ask overwatch instead: factory ask overwatch "<what ${named}:${agent} should do, and why>"`);
    const r = repos.find((x) => x.slug === named);
    if (!r) throw unknown(`no repo ${named} in this factory`);
    if (!repoAgents(r.path).includes(agent)) throw unknown(`no agent ${agent} in ${named}`);
    return { agent, repo: r.slug };
  }
  const has = repos.filter((r) => repoAgents(r.path).includes(agent));
  if (has.length > 1) throw new Error(`${agent} is in ${has.map((r) => r.slug).join(" and ")}: say which, as ${has[0].slug}:${agent}`);
  if (!has.length) throw unknown(`no agent ${agent}`);
  return { agent, repo: has[0].slug };
}

export type AskResult = { kind: "request"; ask: Ask; id: number; title: string; requestKind: Kind; repo: string } | { kind: "note"; ask: Ask; delivered: boolean };

// `fromRepo`: the repo a repo agent's session works in (FACTORY_REPO); the factory's lead when unset.
export function ask(db: Database, o: {
  to: string; text: string; why?: string | null; from: string; fromRepo?: string | null; about?: number | null;
  slug: string; dir: string; run: Run; now: string; overwatch?: () => string | null; name?: string;
  requestKind?: Kind; target?: string; // for the maintainer: the request's kind and repo (maintainer.ts)
}): AskResult {
  const text = o.text.trim().replace(/\s+/g, " ");
  const from: Who = { agent: o.from, repo: isFactoryAgent(o.from) || o.from === "you" ? null : o.fromRepo || leadRepo(db)?.slug || o.slug };
  const to = resolveTarget(db, from, o.to);
  const name = askTarget({ to: to.agent, toRepo: to.repo });
  if (!text) throw new Error(`say what you need: factory ask ${name} "<text>" [--why "<evidence>"]`);
  if (from.agent === to.agent && from.repo === to.repo) throw new Error(`${to.agent} can't ask itself`);
  if (to.agent === "maintainer") {
    const r = request(db, { text, repo: o.slug, run: o.run, now: o.now, from: o.from, evidence: o.why ?? undefined, dir: o.dir, about: o.about, kind: o.requestKind, target: o.target });
    return { kind: "request", ask: row(db.query("SELECT * FROM asks WHERE request = ?").get(r.id)), id: r.id, title: r.title, requestKind: r.kind, repo: r.repo };
  }
  const id = Number(db.query("INSERT INTO asks (from_agent, to_agent, to_repo, text, why, about, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.from, to.agent, to.repo, text, o.why ?? null, o.about ?? null, o.now).lastInsertRowid);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(o.about ?? null, o.from, `asked ${name}: ${text}`.slice(0, 200), o.why ?? null, o.now);
  if (to.repo) deliverToRepoAgents(db, { run: o.run, now: o.now, name: o.name });
  else if (to.agent === "overwatch" && o.overwatch) deliverToOverwatch(db, { run: o.run, now: o.now, terminal: o.overwatch, name: o.name });
  const ask = row(db.query("SELECT * FROM asks WHERE id = ?").get(id));
  return { kind: "note", ask, delivered: !!ask.delivered_at };
}

// Open notes (not maintainer requests, which are tickets), oldest first; to one agent (in any repo), or all.
export function openAsks(db: Database, to?: string): Ask[] {
  return (db.query(`SELECT * FROM asks WHERE done_at IS NULL AND request IS NULL ${to ? "AND to_agent = ?" : ""} ORDER BY id`).all(...(to ? [to] : [])) as any[]).map(row);
}

export function doneAsk(db: Database, id: number, now: string) {
  const r = db.query("UPDATE asks SET done_at = ? WHERE id = ? AND done_at IS NULL AND request IS NULL").run(now, id);
  if (!r.changes) throw new Error(`no open note #${id}; factory asks lists them`);
}

// One note as the agent reads it: who asked, about what, and how to close it.
export function noteText(a: Ask, name?: string) {
  const from = a.from === "you" ? "the person" : a.from;
  return `Note #${a.id} from ${from}${a.about ? ` about #${a.about}` : ""}: ${a.text}${a.why ? ` (evidence: ${a.why})` : ""}. When it's handled: factory asks done ${a.id}${name ? ` --name ${name}` : ""}`;
}

// The learner's or babysitter's run: the notes waiting for it. Its runs are one-shot answers, so
// a note the run read is handled (delivered and done); read them with openAsks first, and take
// them once the run has answered.
export function takeNotes(db: Database, to: "learner" | "babysitter", now: string) {
  const notes = openAsks(db, to);
  for (const a of notes) db.query("UPDATE asks SET delivered_at = ?, done_at = ? WHERE id = ?").run(now, now, a.id);
  return notes;
}

// Notes to the babysitter. One about a ticket goes into that ticket's next fix-round brief and is
// done once the round has used it (`used` keeps the round, so a rewritten brief still has it).
// A general one (no ticket) goes into the judge's prompt for its next JUDGE_NOTE_RUNS judgements,
// or until it is closed.
export const JUDGE_NOTE_RUNS = 5;
export const roundNotes = (db: Database, ticket: number, round: number): Ask[] =>
  (db.query("SELECT * FROM asks WHERE to_agent = 'babysitter' AND request IS NULL AND about = ? AND (done_at IS NULL OR used = ?) ORDER BY id").all(ticket, round) as any[]).map(row);
export function useRoundNotes(db: Database, notes: Ask[], round: number, now: string) {
  for (const a of notes) db.query("UPDATE asks SET delivered_at = COALESCE(delivered_at, ?), done_at = COALESCE(done_at, ?), used = ? WHERE id = ?").run(now, now, round, a.id);
}
export const judgeNotes = (db: Database): Ask[] =>
  (db.query("SELECT * FROM asks WHERE to_agent = 'babysitter' AND request IS NULL AND about IS NULL AND done_at IS NULL ORDER BY id DESC LIMIT 3").all() as any[]).map(row).reverse();
// Counts `n` judgements against the notes given to them; a note that has had its share is done.
export function usedJudgeNotes(db: Database, notes: Ask[], n: number, now: string) {
  if (!n) return;
  for (const a of notes) db.query("UPDATE asks SET delivered_at = COALESCE(delivered_at, ?), used = used + ?, done_at = CASE WHEN used + ? >= ? THEN ? ELSE done_at END WHERE id = ?").run(now, n, n, JUDGE_NOTE_RUNS, now, a.id);
}
// Handled notes to one agent, newest first, for `factory asks <agent>`.
export const doneAsks = (db: Database, to: string, limit = 10): Ask[] =>
  (db.query("SELECT * FROM asks WHERE done_at IS NOT NULL AND request IS NULL AND to_agent = ? ORDER BY id DESC LIMIT ?").all(to, limit) as any[]).map(row);

// The notes, as a run's prompt carries them; "" with none.
export const notesSection = (notes: Ask[]) => notes.length
  ? ["Notes other agents left you (answer one with a proposal when the digest supports it; otherwise leave it):", ...notes.map((a) => `- Note #${a.id} from ${a.from === "you" ? "the person" : a.from}: ${a.text}${a.why ? ` (evidence: ${a.why})` : ""}`)].join("\n")
  : "";

// Notes to Overwatch: typed into its live terminal, once each. A terminal that's gone, or a
// send that fails, leaves the note for the next tick; it is in Needs you either way.
export function deliverToOverwatch(db: Database, o: { run: Run; now: string; terminal: () => string | null; name?: string }) {
  const waiting = openAsks(db, "overwatch").filter((a) => !a.delivered_at);
  if (!waiting.length) return 0;
  const terminal = o.terminal();
  if (!terminal) return 0;
  let n = 0;
  for (const a of waiting) {
    if (o.run(["hc", "send", terminal, noteText(a, o.name)]).code !== 0) break;
    db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(o.now, a.id);
    n++;
  }
  return n;
}

// Notes to repo agents: each typed into a live session of its agent in its repo, once. A note
// about a ticket goes only to that ticket's session; one about none, to the newest. A note no
// session is live for waits for the agent's next brief in that repo (notesForBrief).
export function deliverToRepoAgents(db: Database, o: { run: Run; now: string; name?: string }) {
  const waiting = (db.query("SELECT * FROM asks WHERE to_repo IS NOT NULL AND request IS NULL AND delivered_at IS NULL AND done_at IS NULL ORDER BY id").all() as any[]).map(row);
  if (!waiting.length) return 0;
  const lead = leadRepo(db)?.slug ?? null;
  let n = 0;
  for (const a of waiting) {
    const live = db.query(`SELECT s.terminal FROM sessions s JOIN ticket_lead t ON t.id = s.ticket
      WHERE s.agent = ? AND s.ended_at IS NULL AND s.terminal IS NOT NULL AND COALESCE(t.repo, ?) = ? ${a.about != null ? "AND s.ticket = ?" : ""}
      ORDER BY s.id DESC`).all(a.to, lead, a.toRepo, ...(a.about != null ? [a.about] : [])) as { terminal: string }[];
    const terminal = live.map((s) => s.terminal).find((t) => alive(o.run, t));
    if (!terminal || o.run(["hc", "send", terminal, noteText(a, o.name)]).code !== 0) continue;
    db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(o.now, a.id);
    n++;
  }
  return n;
}

const alive = (run: Run, terminal: string) => {
  const r = run(["hc", "get", terminal, "--json"]);
  try { return r.code === 0 && JSON.parse(r.out).exit_code == null; } catch { return false; }
};

// The notes waiting for `agent` in `repo` that a new session of it on `ticket` takes in its
// brief: ones about that ticket, or about none. Mark them with deliveredInBrief once it starts.
export const notesForBrief = (db: Database, o: { agent: string; repo: string; ticket: number }): Ask[] =>
  (db.query("SELECT * FROM asks WHERE to_agent = ? AND to_repo = ? AND request IS NULL AND delivered_at IS NULL AND done_at IS NULL AND (about IS NULL OR about = ?) ORDER BY id")
    .all(o.agent, o.repo, o.ticket) as any[]).map(row);
export const briefNotes = (notes: Ask[], name?: string) => notes.length
  ? ["## Notes other agents left you", "", ...notes.map((a) => `- ${noteText(a, name)}`)].join("\n")
  : "";
export function deliveredInBrief(db: Database, notes: Ask[], now: string) {
  for (const a of notes) db.query("UPDATE asks SET delivered_at = ? WHERE id = ?").run(now, a.id);
}
