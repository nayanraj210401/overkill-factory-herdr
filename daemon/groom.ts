// D6 grooming (plan: Autonomy). The triage agent reads the issue and the code, picks
// a blueprint, and asks what they can't settle. Product questions go to the product
// owner on the issue; engineering ones come to you. An answer in Herdr (`u`) or as an
// `A1:` comment on the issue counts. With every question answered the ticket is
// groomed, and groomed tickets start on their own, up to max_running at once.
import { DEFAULT_MODEL } from "./models.ts";
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { BLUEPRINT } from "./maintainer.ts";
import { join } from "node:path";
import { enterStage } from "./ticket.ts";
import { getMeta, listRepos, needLead, repoOf, type Repo } from "./db.ts";
import { LOCAL_IDS } from "./intake.ts";
import { capsOf, readTriggers, runningByTrigger, withinCaps } from "./triggers.ts";
import { argvFor, loadAgent, loadBlueprint, readFactory, startTicket, type Run } from "./runner.ts";
import { mayStart } from "./away.ts";
import { openAgent, withFactory } from "./herdr.ts";
import { withHandoffHook } from "./handoff-hook.ts";
import { estimateBudget, startHold } from "./budget.ts";
import { compact } from "../lib/model.js";
import { loadPrompt, render } from "./prompts.ts";
import { splitGate } from "./split.ts";

type Question = { n: number; kind: "product" | "engineering"; text: string; asked_at: string; answer: string | null };

export function grooming(repo: string) {
  const g = readFactory(repo).grooming ?? {};
  const dir = join(repo, ".factory", "blueprints");
  // The maintainer's blueprint (maintainer.ts) takes requests from Overwatch, never a groomed ticket.
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).filter((b) => b !== BLUEPRINT).sort() : [];
  return {
    agent: g.agent ?? "triager",
    blueprints: g.blueprints?.filter((b) => all.includes(b)) ?? all,
    questions: g.questions ?? ["herdr", "issue"],
    product_owner: g.product_owner ?? null,
  };
}

const isIssue = (id: number) => id < LOCAL_IDS;
const ticket = (db: Database, id: number) => {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${id}`);
  return t;
};
const openQuestions = (db: Database, id: number) =>
  db.query("SELECT n, kind, text, asked_at, answer FROM questions WHERE ticket = ? AND answer IS NULL ORDER BY n").all(id) as Question[];

export function triageBrief(t: { id: number; title: string }, o: { slug: string; repo: string; folder: string; blueprints: string[]; prompt: string | null; others?: Repo[] }) {
  const others = o.others ?? [];
  return render(loadPrompt(o.repo, "groom"), {
    "ticket.id": String(t.id),
    "ticket.title": t.title,
    repo: o.repo,
    slug: o.slug,
    folder: o.folder,
    blueprints: o.blueprints.join(", "),
    "agent.prompt": o.prompt,
    repos: others.map((r) => `${r.slug} (${r.path})`).join(", "),
    issue: isIssue(t.id) ? `Read the issue first: gh issue view ${t.id} --repo ${o.slug} --comments` : "It has no issue: the line above is the whole request.",
  });
}

// `factory groom <id>`: the triage agent starts on a ticket nobody has started.
export function startGrooming(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  const t = ticket(db, o.id);
  if (!["queued", "grooming"].includes(t.state) || t.worktree) throw new Error(`#${o.id} is ${t.state}${t.worktree ? " and has started" : ""}; only a ticket that hasn't started is groomed`);
  if (db.query("SELECT 1 FROM sessions WHERE ticket = ? AND ended_at IS NULL").get(o.id)) throw new Error(`#${o.id} is being groomed already`);
  const g = grooming(o.repo);
  const folder = join(o.dir, "tickets", String(o.id));
  mkdirSync(folder, { recursive: true });
  // Grooming again starts clean: what an earlier triager asked and nobody answered is withdrawn
  // (the new one asks again if it still matters), and its GROOMING.md is kept aside, since a
  // GROOMING.md is how a finished triage is told from one that died (finishGrooming).
  db.query("DELETE FROM questions WHERE ticket = ? AND answer IS NULL").run(o.id);
  const before = join(folder, "GROOMING.md");
  if (existsSync(before)) renameSync(before, join(folder, "GROOMING.before.md"));
  const agent = loadAgent(o.repo, g.agent);
  const argv = argvFor(agent, { harness: "claude", model: DEFAULT_MODEL },
    triageBrief(t as any, { slug: needLead(db).slug, repo: o.repo, folder, blueprints: g.blueprints, prompt: agent?.prompt ?? null, others: listRepos(db).filter((r) => !r.lead) }));
  // Auto mode and the allowlist like every agent, so `factory pick` never waits (allow.ts); its questions are asked in the terminal.
  const cmd = withFactory(withHandoffHook(argv, o.dir, o.id, null, readFactory(o.repo).quality_floor ?? []), o.dir);
  // In the window: a groom tab in the ticket's space (made here; its stage tabs join it
  // later), so you can watch the triage agent and answer it. No window: a background terminal.
  const made = openAgent(o.run, { folder, space: t.space ?? null, name: "groom", argv: cmd });
  let terminal: string;
  if (made) {
    terminal = made.terminal;
    o.run(["hc", "label", terminal, `factory.ticket=${o.id}`, "factory.stage=groom"]);
    db.query("UPDATE tickets SET space = ? WHERE id = ?").run(made.space, o.id);
  } else {
    const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f${o.id}-groom`, "--cwd", folder,
      "--label", `factory.ticket=${o.id}`, "--label", "factory.stage=groom", ...cmd]);
    if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
    terminal = (() => { try { return JSON.parse(hc.out).address ?? `f${o.id}-groom`; } catch { return `f${o.id}-groom`; } })();
  }
  db.query("UPDATE tickets SET state = 'grooming', needs_kind = NULL, needs_text = NULL, groomed_at = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  enterStage(db, o.id, "Groom", `${g.agent} agent`, [], o.now);
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd) VALUES (?, 'groom', ?, ?, ?, ?, ?, ?)")
    .run(o.id, g.agent, terminal, JSON.stringify(argv), o.now, made ? 1 : 0, folder);
  return terminal;
}

// `factory pick <id> <blueprint>`: grooming's choice, yours to change until it starts.
export function pick(db: Database, o: { repo: string; id: number; blueprint: string; now: string }) {
  const t = ticket(db, o.id);
  if (t.worktree || !["queued", "grooming"].includes(t.state)) throw new Error(`#${o.id} has started; its blueprint is set`);
  const g = grooming(o.repo);
  if (!g.blueprints.includes(o.blueprint)) throw new Error(`"${o.blueprint}" isn't a blueprint grooming may pick: ${g.blueprints.join(", ")}`);
  loadBlueprint(o.repo, o.blueprint); // it must parse
  const s = db.query("SELECT agent FROM sessions WHERE ticket = ? AND ended_at IS NULL").get(o.id) as { agent: string } | null;
  db.query("UPDATE tickets SET blueprint = ?, updated_at = ? WHERE id = ?").run(o.blueprint, o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(o.id, s?.agent ?? "you", `picked the ${o.blueprint} blueprint`, o.now);
}

// `factory repos <id> owner/name…`: the repos a cross-repo ticket works in, grooming's
// choice and yours to change until it starts. The lead is always one of them.
export function chooseRepos(db: Database, o: { repo: string; id: number; slugs: string[]; now: string }) {
  const t = ticket(db, o.id);
  if (t.worktree || !["queued", "grooming"].includes(t.state)) throw new Error(`#${o.id} has started; its repos are set`);
  const lead = needLead(db);
  const listed = readFactory(o.repo).repos;
  const slugs = [...new Set([lead.slug, ...o.slugs])];
  for (const s of slugs) repoOf(db, s, listed);
  db.query("DELETE FROM ticket_repos WHERE ticket = ? AND lead = 0").run(o.id);
  db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (?, ?, 1) ON CONFLICT DO NOTHING").run(o.id, lead.slug);
  for (const s of slugs.slice(1)) db.query("INSERT INTO ticket_repos (ticket, repo) VALUES (?, ?)").run(o.id, s);
  const s = db.query("SELECT agent FROM sessions WHERE ticket = ? AND ended_at IS NULL").get(o.id) as { agent: string } | null;
  db.query("UPDATE tickets SET updated_at = ? WHERE id = ?").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(o.id, s?.agent ?? "you", `works in ${slugs.join(", ")}`, o.now);
  return slugs;
}

// `factory question <id> product|engineering <text…>`: asked while grooming.
export function ask(db: Database, o: { id: number; kind: string; text: string; now: string }) {
  const t = ticket(db, o.id);
  if (t.state !== "grooming") throw new Error(`#${o.id} is ${t.state}; questions are asked while it's groomed`);
  if (o.kind !== "product" && o.kind !== "engineering") throw new Error("a question is product or engineering");
  if (!o.text.trim()) throw new Error("type the question");
  const n = ((db.query("SELECT MAX(n) AS m FROM questions WHERE ticket = ?").get(o.id) as { m: number | null }).m ?? 0) + 1;
  db.query("INSERT INTO questions (ticket, n, kind, text, asked_at) VALUES (?, ?, ?, ?, ?)").run(o.id, n, o.kind, o.text.trim(), o.now);
  return n;
}

// A question an agent asks mid-run (plan: a product question that turns up mid-run parks
// the ticket). The ticket parks with it, its session ends, and a product question also
// goes on the issue to the product owner. \`u\` (or factory answer) writes the answer to
// GATES.md and restarts the stage, whose brief reads it there.
export function askMidRun(db: Database, o: { repo: string; id: number; kind: string; text: string; run: Run; now: string }) {
  const t = ticket(db, o.id);
  if (t.state !== "running") throw new Error(`#${o.id} is ${t.state}; only a running ticket's agent asks mid-run`);
  if (o.kind !== "product" && o.kind !== "engineering") throw new Error("a question is product or engineering");
  const text = o.text.trim();
  if (!text) throw new Error("type the question");
  const n = ((db.query("SELECT MAX(n) AS m FROM questions WHERE ticket = ?").get(o.id) as { m: number | null }).m ?? 0) + 1;
  db.query("INSERT INTO questions (ticket, n, kind, text, asked_at) VALUES (?, ?, ?, ?, ?)").run(o.id, n, o.kind, text, o.now);
  const po = o.kind === "product" ? productOwner(db, o) : null;
  const who = o.kind === "product" ? `product, for ${po ? `@${po}` : "the product owner"}` : "engineering";
  db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?")
    .run(`Q${n} from the ${t.stage} stage (${who}): ${text}`, o.now, o.id);
  const ended = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'agent', ?, ?, ?)").run(o.id, `asked Q${n} mid-run and parked`, text, o.now);
  if (o.kind === "product" && isIssue(o.id)) {
    const body = `${po ? `@${po} ` : ""}The factory is building this and needs a product answer before it goes on:\n\n**Q${n}:** ${text}\n\nReply here with \`A${n}: …\`, or answer in Herdr.`;
    const r = o.run(["gh", "issue", "comment", String(o.id), "--repo", needLead(db).slug, "--body", body]);
    if (r.code !== 0) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(o.id, `couldn't post Q${n} on the issue`, r.out.slice(0, 200), o.now);
  }
  return { n, terminals: ended.map((e) => e.terminal) };
}

function productOwner(db: Database, o: { repo: string; id: number; run: Run }) {
  const named = grooming(o.repo).product_owner;
  if (named) return named;
  if (!isIssue(o.id)) return null;
  const r = o.run(["gh", "issue", "view", String(o.id), "--repo", needLead(db).slug, "--json", "author", "-q", ".author.login"]);
  return r.code === 0 && r.out ? r.out.trim() : null;
}

export const needsText = (open: Question[], po: string | null) => {
  const q = open[0];
  const who = q.kind === "product" ? ` (product: waiting on ${po ? `@${po}` : "the product owner"})` : "";
  return `${open.length} question${open.length > 1 ? "s" : ""} · Q${q.n}: ${q.text}${who}`;
};

const MARK = "<!-- factory:questions -->";
export function questionsComment(open: Question[], po: string | null) {
  return [
    MARK,
    "The factory groomed this issue and needs answers before it starts.",
    "",
    ...open.map((q) => `**Q${q.n}** (${q.kind}${q.kind === "product" && po ? `, @${po}` : ""}): ${q.text}`),
    "",
    "Answer in a comment, one line per answer, each starting with its number: `A1: …`. An answer here or in Herdr counts.",
  ].join("\n");
}

// The triage agent's session is over (stage-done, or its terminal exited).
export function finishGrooming(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  // The triager's last step is GROOMING.md. Without it, triage stopped early (killed, crashed,
  // closed): the ticket waits for you rather than start as if groomed. Parked, not retried,
  // so a triager that keeps dying doesn't loop; `factory groom <id>` runs it again.
  if (!existsSync(join(o.dir, "tickets", String(o.id), "GROOMING.md"))) {
    const why = `Triage stopped before it finished (no GROOMING.md). Rerun it: factory groom ${o.id}`;
    db.query("UPDATE tickets SET needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?").run(why, o.now, o.id);
    db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run("triage stopped early", o.id);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', 'triage stopped before GROOMING.md; parked', ?)").run(o.id, o.now);
    return { parked: why, stage: "groom" };
  }
  const open = openQuestions(db, o.id);
  if (!open.length) return groomed(db, o);
  const po = open.some((q) => q.kind === "product") ? productOwner(db, o) : null;
  db.query("UPDATE tickets SET needs_kind = 'question', needs_text = ?, updated_at = ? WHERE id = ?").run(needsText(open, po), o.now, o.id);
  db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(`waiting on ${open.length} answer${open.length > 1 ? "s" : ""}`, o.id);
  note(o.dir, o.id, "Questions", open.map((q) => `- **Q${q.n}** (${q.kind}): ${q.text}`).join("\n"));
  if (isIssue(o.id) && grooming(o.repo).questions.includes("issue")) {
    const r = o.run(["gh", "issue", "comment", String(o.id), "--repo", needLead(db).slug, "--body", questionsComment(open, po)]);
    // A comment that didn't post leaves the questions in Herdr; say so rather than fail grooming.
    db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
      .run(o.id, r.code === 0 ? `asked ${open.length} question${open.length > 1 ? "s" : ""} on the issue` : "couldn't post the questions on the issue", r.code === 0 ? null : r.out.slice(0, 200), o.now);
  }
  return { questions: open.length, stage: "groom" };
}

function note(dir: string, id: number, heading: string, text: string) {
  const folder = join(dir, "tickets", String(id));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "GATES.md");
  appendFileSync(path, `${existsSync(path) ? "\n" : "# GATES\n\n"}## ${heading}\n\n${text.trim()}\n`);
}

// Answers in a comment or the `u` box: "A2: …" lines, or plain text for the first open question.
export function parseAnswers(text: string): { n: number | null; text: string }[] {
  const marked = [...text.matchAll(/^\s*A(\d+)\s*[:.)]\s*(.+(?:\n(?!\s*A\d+\s*[:.)]).*)*)/gim)].map((m) => ({ n: Number(m[1]), text: m[2].trim() }));
  if (marked.length) return marked;
  return text.trim() ? [{ n: null, text: text.trim() }] : [];
}

// `u` on a grooming ticket, or answers read from the issue. `where` says which.
export function answerQuestions(db: Database, o: { dir: string; repo: string; id: number; text: string; by: string; where: "herdr" | "issue"; run: Run; now: string }) {
  const t = ticket(db, o.id);
  if (t.state !== "grooming" || t.needs_kind !== "question") throw new Error(`#${o.id} has no open questions`);
  const open = openQuestions(db, o.id);
  const done: Question[] = [];
  const given = new Map<number, string>();
  for (const a of parseAnswers(o.text)) {
    const q = a.n == null ? open.find((x) => !done.includes(x)) : open.find((x) => x.n === a.n);
    if (!q || done.includes(q)) continue;
    db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE ticket = ? AND n = ?").run(a.text, o.by, o.now, o.id, q.n);
    done.push(q);
    given.set(q.n, a.text);
    note(o.dir, o.id, `Q${q.n} · answered by ${o.by} ${o.where === "issue" ? "on the issue" : "in Herdr"} · ${o.now.slice(0, 16).replace("T", " ")}`, `${q.text}\n\n**Answer:** ${a.text}`);
  }
  if (!done.length) throw new Error(o.text.trim() ? `no open question matches; open: ${open.map((q) => `Q${q.n}`).join(", ")}` : "type an answer");
  // The other place is updated: an answer given in Herdr is posted on the issue.
  if (o.where === "herdr" && isIssue(o.id) && grooming(o.repo).questions.includes("issue")) {
    const lines = done.map((q) => `A${q.n}: ${given.get(q.n)}`);
    o.run(["gh", "issue", "comment", String(o.id), "--repo", needLead(db).slug, "--body", `${MARK}\nAnswered in Herdr:\n\n${lines.join("\n")}`]);
  }
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(o.id, o.by, `answered ${done.map((q) => `Q${q.n}`).join(", ")}`, o.now);
  const left = openQuestions(db, o.id);
  if (left.length) {
    db.query("UPDATE tickets SET needs_text = ?, updated_at = ? WHERE id = ?").run(needsText(left, productOwner(db, o)), o.now, o.id);
    return { answered: done.map((q) => q.n), left: left.length };
  }
  return { answered: done.map((q) => q.n), left: 0, ...groomed(db, o) };
}

// No questions left: the ticket is groomed, queued in order, and starts if there's room.
function groomed(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  // Triage found it is several tickets: the split waits for you, or its parts are groomed now.
  const split = splitGate(db, o);
  if (split) return { ...split, stage: "groom" };
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("UPDATE tickets SET state = 'queued', stage = NULL, detail = NULL, needs_kind = NULL, needs_text = NULL, groomed_at = ?, updated_at = ? WHERE id = ?").run(o.now, o.now, o.id);
  const b = (db.query("SELECT blueprint FROM ticket_lead WHERE id = ?").get(o.id) as { blueprint: string }).blueprint;
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(o.id, `groomed: runs the ${b} blueprint`, o.now);
  // Grooming sets the budget, unless you already set one yourself while it was groomed.
  const mine = db.query("SELECT 1 FROM decisions WHERE ticket = ? AND who = 'you' AND what LIKE 'set the budget to %'").get(o.id);
  const est = mine ? null : estimateBudget(db, o.repo, b);
  if (est) {
    db.query("UPDATE tickets SET budget_in = ?, budget_out = ? WHERE id = ?").run(est.input, est.output, o.id);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(o.id, `set the budget to ${compact(est.input)}/${compact(est.output)}`, o.now);
  }
  const started = startGroomed(db, o);
  return { groomed: true, started: started.includes(o.id) };
}

// Each start in its own savepoint: one that fails (a bad branch, hc down) rolls back
// alone, so what led up to it (an answer, a posted comment) stays, and a later tick retries.
function each(db: Database, ids: number[], start: (id: number) => unknown, log?: (s: string) => void) {
  const ok: number[] = [];
  for (const id of ids) {
    try { db.transaction(() => start(id))(); ok.push(id); }
    catch (e) { log?.(`factory: #${id} didn't start: ${(e as Error).message}`); }
  }
  return ok;
}

// Groomed tickets start oldest first while fewer than max_running tickets run.
export function startGroomed(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const max = readFactory(o.repo).max_running ?? 3;
  if (startHold(db, o.repo, new Date(o.now))) return []; // the groomed ones wait; status.json says why
  const running = (db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'running'").get() as { n: number }).n;
  // While you're away, only the blueprints away.blueprints names start.
  // A trigger's concurrency caps its own tickets: one at its cap waits, and the next ticket starts.
  const waiting = withinCaps(
    (db.query("SELECT id, blueprint, trigger_name AS trigger FROM tickets WHERE state = 'queued' AND groomed_at IS NOT NULL ORDER BY groomed_at, id").all() as { id: number; blueprint: string; trigger: string | null }[])
      .filter((w) => mayStart(db, o.repo, w.blueprint)), runningByTrigger(db), capsOf(readTriggers(o.repo).triggers),
  ).slice(0, Math.max(0, max - running));
  return each(db, waiting.map((w) => w.id), (id) => startTicket(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now }), o.log);
}

// Answers on the issue: `A1:` comments newer than the questions, not the factory's own.
export function readIssueAnswers(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  if (!grooming(o.repo).questions.includes("issue")) return;
  const waiting = db.query(`SELECT id FROM tickets t WHERE state = 'grooming' AND needs_kind = 'question' AND id < ?
    AND EXISTS (SELECT 1 FROM questions q WHERE q.ticket = t.id AND q.answer IS NULL)`).all(LOCAL_IDS) as { id: number }[];
  for (const { id } of waiting) {
    const since = (db.query("SELECT MIN(asked_at) AS at FROM questions WHERE ticket = ? AND answer IS NULL").get(id) as { at: string }).at;
    const r = o.run(["gh", "issue", "view", String(id), "--repo", needLead(db).slug, "--json", "comments"]);
    if (r.code !== 0) { o.log?.(`factory: #${id}: gh issue view failed: ${r.out.slice(0, 200)}`); continue; }
    let comments: { author?: { login?: string }; body: string; createdAt: string }[] = [];
    try { comments = JSON.parse(r.out).comments ?? []; } catch { continue; }
    for (const c of comments) {
      if (Date.parse(c.createdAt) < Date.parse(since) || c.body.includes(MARK)) continue;
      if (!parseAnswers(c.body).some((a) => a.n != null)) continue; // only numbered answers count on the issue
      try {
        const res = answerQuestions(db, { ...o, id, text: c.body, by: c.author?.login ? `@${c.author.login}` : "the issue", where: "issue" });
        o.log?.(`factory: #${id}: ${res.answered.map((n) => `A${n}`).join(", ")} from the issue`);
      } catch { /* answers to questions already answered */ }
      if (!openQuestions(db, id).length) break;
    }
  }
}

// Tickets waiting for triage (from the queue: grooming, no session yet, nothing
// asked) start it oldest first, with at most max_running triage agents at once.
export function startPendingGrooming(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const max = readFactory(o.repo).max_running ?? 3;
  const busy = (db.query("SELECT COUNT(*) AS n FROM sessions WHERE stage = 'groom' AND ended_at IS NULL").get() as { n: number }).n;
  const pending = db.query(`SELECT id FROM tickets t WHERE state = 'grooming' AND needs_kind IS NULL
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL) ORDER BY updated_at, id LIMIT ?`)
    .all(Math.max(0, max - busy)) as { id: number }[];
  return each(db, pending.map((p) => p.id), (id) => startGrooming(db, { ...o, id }), o.log);
}
