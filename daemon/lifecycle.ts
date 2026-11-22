// Ticket lifecycle (plan: Ticket lifecycle). A ticket's issue changes after pickup and the
// factory follows it instead of finishing the wrong work:
//   blocked late   a "blocked by #n" in the issue, or an agent's `factory block`, stops the
//                  ticket (pause keeps the worktree) until #n is closed or merged
//   scope changed  the issue's acceptance criteria stopped matching INTENT.md: back to grooming
//                  with the difference as questions; a cosmetic edit is noted and ignored
//   pulled back    closed, unassigned, or out of the Project's Ready column: paused, and Needs
//                  you asks "keep or drop the branch?" (`factory resume` keeps, `factory drop`)
//   split          daemon/split.ts: a ticket that is really several becomes sub-issues
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, needLead, setMeta, ticketRepos, setWork } from "./db.ts";
import { json, login, projectNumber, LOCAL_IDS } from "./intake.ts";
import { ask, needsText, questionsComment, grooming } from "./groom.ts";
import { closeSpace } from "./herdr.ts";
import { pause, readFactory, resume, type Run } from "./runner.ts";

export const LIFECYCLE_MS = 300_000; // each issue is a gh call: every 5 minutes

type Row = Record<string, any>;
type Issue = { state: string; body: string; assignees: string[] };

// "blocked by #430" (also "blocked by owner/name#430") in an issue body; the first one.
export const blockedBy = (body: string) => {
  const m = body.match(/\bblocked[ -]by:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i);
  return m ? Number(m[1]) : null;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// The acceptance criteria part: the section headed "Acceptance…", else the whole text.
const section = (text: string, re: RegExp) => text.split(/^(?=#{1,6}[ \t])/m).find((p) => re.test(p.replace(/^#+[ \t]+/, "")));
export const acceptance = (text: string) => {
  const s = section(text, /^acceptance/i);
  return (s ? s.replace(/^#+[ \t]+.*\n?/, "") : text).trim();
};

const lineKey = (l: string) => norm(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, ""));
// Case, markdown marks, punctuation and whitespace don't count as an edit.
const norm = (s: string) => s.toLowerCase().replace(/[`*_>#~]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Whitespace, case, punctuation and typos are cosmetic; a changed number never is.
export function cosmetic(was: string, now: string) {
  const [a, b] = [norm(was), norm(now)];
  if (a === b) return true;
  if (Math.max(a.length, b.length) > 5000) return false;
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(",");
  return digits(a) === digits(b) && distance(a, b) <= Math.max(2, Math.ceil(Math.max(a.length, b.length) * 0.02));
}

// What differs, as grooming questions: lines the issue gained, and lines INTENT.md has that it lost.
export function scopeQuestions(intent: string, issue: string) {
  const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => lineKey(l));
  const [was, now] = [lines(intent), lines(issue)];
  const have = (list: string[], l: string) => list.some((x) => lineKey(x) === lineKey(l));
  const text = (l: string) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "").slice(0, 200);
  return [
    ...now.filter((l) => !have(was, l)).map((l) => `The issue's acceptance criteria now say "${text(l)}", which INTENT.md doesn't. Does the plan change for it?`),
    ...was.filter((l) => !have(now, l)).map((l) => `INTENT.md says "${text(l)}", but the issue no longer does. Is it dropped?`),
  ].slice(0, 6);
}

const note = (db: Database, id: number, who: string, what: string, why: string | null, now: string) =>
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(id, who, what, why, now);

const onCloud = (t: Row) => t.location === "cloud";

// Blocked: the ticket stops (a running one pauses, which keeps its worktree), and waits.
export function blockTicket(db: Database, o: { id: number; by: number; run: Run; now: string; who: string; why?: string }) {
  const t = db.query("SELECT state, location FROM tickets WHERE id = ?").get(o.id) as Row | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!["running", "queued", "paused"].includes(t.state)) throw new Error(`#${o.id} is ${t.state}; only a running, queued or paused ticket is blocked`);
  if (o.by === o.id) throw new Error("a ticket can't be blocked by itself");
  if (t.state === "running") pause(db, { id: o.id, run: o.run, now: o.now, who: "daemon" });
  db.query("UPDATE tickets SET state = 'blocked', blocked_by = ?, updated_at = ? WHERE id = ?").run(o.by, o.now, o.id);
  note(db, o.id, o.who, `blocked by #${o.by}`, o.why ?? null, o.now);
}

// The blocker is closed or merged: back to work where it left off.
export function unblock(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  const t = db.query("SELECT worktree FROM ticket_lead WHERE id = ?").get(o.id) as Row;
  const by = (db.query("SELECT blocked_by FROM tickets WHERE id = ?").get(o.id) as Row).blocked_by;
  note(db, o.id, "daemon", `#${by} is done; unblocked`, null, o.now);
  db.query("UPDATE tickets SET blocked_by = NULL, state = ?, updated_at = ? WHERE id = ?").run(t.worktree ? "paused" : "queued", o.now, o.id);
  if (t.worktree) resume(db, o);
}

// `factory block <id> <#n>`: an agent reports it. A running ticket only records the report;
// the daemon stops it on its next tick, so the call never kills the agent that made it.
export function reportBlocked(db: Database, o: { id: number; by: number; run: Run; now: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "running") return blockTicket(db, { ...o, who: "you" });
  if (o.by === o.id) throw new Error("a ticket can't be blocked by itself");
  db.query("UPDATE tickets SET blocked_by = ?, updated_at = ? WHERE id = ?").run(o.by, o.now, o.id);
  note(db, o.id, "agent", `reported blocked by #${o.by}`, null, o.now);
}

// Reports from agents, stopped now: no gh, so it runs every tick.
export function applyReports(db: Database, o: { run: Run; now: string; log?: (s: string) => void }) {
  for (const t of db.query("SELECT id, blocked_by FROM tickets WHERE state = 'running' AND blocked_by IS NOT NULL AND location != 'cloud'").all() as Row[]) {
    try { db.transaction(() => blockTicket(db, { id: t.id, by: t.blocked_by, run: o.run, now: o.now, who: "daemon", why: "an agent reported it" }))(); o.log?.(`factory: #${t.id} blocked by #${t.blocked_by}`); }
    catch (e) { o.log?.(`factory: #${t.id}: ${(e as Error).message}`); }
  }
}

// Pulled back: stopped, and the keep-or-drop question is Needs you. `resume` keeps it.
function pullBack(db: Database, o: { id: number; run: Run; now: string; reason: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row;
  if (t.state === "running") pause(db, { id: o.id, run: o.run, now: o.now, who: "daemon" });
  const text = `${o.reason}. Keep or drop the branch? \`factory resume ${o.id}\` keeps it going; \`factory drop ${o.id}\` removes the worktree and closes it (the branch and notes stay).`;
  db.query("UPDATE tickets SET state = 'paused', blocked_by = NULL, needs_kind = 'question', needs_text = ?, updated_at = ? WHERE id = ?").run(text, o.now, o.id);
  note(db, o.id, "daemon", "pulled back", o.reason, o.now);
}

// Scope changed: back to grooming, with the difference asked as questions.
function regroom(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; questions: string[] }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row;
  if (t.state === "running") pause(db, { id: o.id, run: o.run, now: o.now, who: "daemon" });
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("UPDATE tickets SET state = 'grooming', stage = NULL, detail = NULL, groomed_at = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  for (const q of o.questions) ask(db, { id: o.id, kind: "product", text: q, now: o.now });
  const open = db.query("SELECT n, kind, text, asked_at, answer FROM questions WHERE ticket = ? AND answer IS NULL ORDER BY n").all(o.id) as any[];
  db.query("UPDATE tickets SET needs_kind = 'question', needs_text = ? WHERE id = ?").run(needsText(open, null), o.id);
  if (grooming(o.repo).questions.includes("issue"))
    o.run(["gh", "issue", "comment", String(o.id), "--repo", needLead(db).slug, "--body", questionsComment(open, null)]);
  note(db, o.id, "daemon", "scope changed; back to grooming", `${open.length} question${open.length > 1 ? "s" : ""}`, o.now);
}

type Item = { status?: string; assignees?: string[]; content?: { number?: number } };

// Every running, queued or blocked ticket's issue, read through gh at most every 5 minutes.
// `force` skips the throttle (tests, and `factory run` at start).
export function followIssues(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void; force?: boolean }) {
  applyReports(db, o);
  const key = "lifecycle_at"; // written before the reads: a failing gh waits its turn too
  if (!o.force && getMeta(db, key) && Date.parse(o.now) - Date.parse(getMeta(db, key)!) < LIFECYCLE_MS) return;
  setMeta(db, key, o.now);
  const slug = needLead(db).slug;
  const rows = db.query(`SELECT t.id, t.state, t.location, t.blocked_by, t.issue_hash, t.worktree,
      EXISTS (SELECT 1 FROM decisions d WHERE d.ticket = t.id AND d.what LIKE 'joined from %') AS from_queue
    FROM ticket_lead t WHERE t.state IN ('running', 'queued', 'blocked') AND t.location != 'cloud' AND t.id < ? ORDER BY t.id`).all(LOCAL_IDS) as Row[];
  if (!rows.length) return;
  const queue = readFactory(o.repo).queue;
  // The Project's items, once per pass, only if a ticket from the queue is followed.
  let items: Item[] | null = null;
  const column = (queue?.column ?? "Ready").toLowerCase();
  const itemOf = (n: number) => {
    if (!items) {
      const { owner, number } = projectNumber(db, o.run, queue!.github_project!);
      items = (json(o.run, ["gh", "project", "item-list", String(number), "--owner", owner, "--format", "json", "--limit", "500"]).items ?? []) as Item[];
    }
    return items.find((i) => i.content?.number === n);
  };
  const readIssue = (n: number): Issue => {
    const v = json(o.run, ["gh", "issue", "view", String(n), "--repo", slug, "--json", "number,state,body,assignees"]);
    return { state: v.state, body: v.body ?? "", assignees: (v.assignees ?? []).map((a: any) => a.login) };
  };
  for (const t of rows) {
    try {
      db.transaction(() => follow(db, { ...o, t, readIssue, itemOf: queue?.github_project && t.from_queue ? itemOf : null, queue }))();
    } catch (e) {
      o.log?.(`factory: #${t.id}: following its issue: ${(e as Error).message}`);
    }
  }
}

function follow(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void; t: Row; readIssue: (n: number) => Issue; itemOf: ((n: number) => Item | undefined) | null; queue: Row | undefined }) {
  const { t } = o;
  const issue = o.readIssue(t.id);
  const id = t.id as number;
  // Pulled back wins over everything else.
  let why: string | null = null;
  if (issue.state !== "OPEN") why = `Issue #${id} was ${issue.state.toLowerCase()}`;
  else if (o.queue?.assignee && o.itemOf && !issue.assignees.some((a) => a.toLowerCase() === login(db, o.run, o.queue!.assignee).toLowerCase())) why = `Issue #${id} is no longer assigned to you`;
  else if (o.itemOf) {
    const item = o.itemOf(id);
    if (!item || (item.status ?? "").toLowerCase() !== (o.queue!.column ?? "Ready").toLowerCase()) why = `Issue #${id} left the ${o.queue!.column ?? "Ready"} column`;
  }
  if (why) {
    pullBack(db, { id, run: o.run, now: o.now, reason: why });
    o.log?.(`factory: #${id} pulled back: ${why}`);
    return;
  }
  // Blocked: a ticket waits on its blocker; a new "blocked by #n" stops a ticket.
  if (t.state === "blocked") {
    if (t.blocked_by != null && o.readIssue(t.blocked_by).state !== "OPEN") {
      unblock(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now });
      o.log?.(`factory: #${id} unblocked; #${t.blocked_by} is done`);
    }
    return;
  }
  const by = blockedBy(issue.body);
  if (by != null && by !== id && o.readIssue(by).state === "OPEN") {
    blockTicket(db, { id, by, run: o.run, now: o.now, who: "daemon", why: "the issue says so" });
    o.log?.(`factory: #${id} blocked by #${by}`);
    return;
  }
  // Scope: the first read is the pickup baseline.
  const h = hash(issue.body);
  if (!t.issue_hash) return void db.query("UPDATE tickets SET issue_hash = ? WHERE id = ?").run(h, id);
  if (h === t.issue_hash) return;
  const path = join(o.dir, "tickets", String(id), "INTENT.md");
  if (!existsSync(path)) return; // nothing to compare with yet; looked at again next time
  const intent = acceptance(readFileSync(path, "utf8"));
  const now = acceptance(issue.body);
  db.query("UPDATE tickets SET issue_hash = ? WHERE id = ?").run(h, id);
  const questions = cosmetic(intent, now) ? [] : scopeQuestions(intent, now);
  if (!questions.length) return void note(db, id, "daemon", "the issue was edited; the acceptance criteria are the same", "cosmetic", o.now);
  regroom(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now, questions });
  o.log?.(`factory: #${id} scope changed; back to grooming`);
}

// `factory drop <id>`: the worktrees go, the ticket closes; the branch and its .md files stay.
export function dropTicket(db: Database, o: { id: number; run: Run; now: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state === "merged" || t.state === "closed") throw new Error(`#${o.id} is ${t.state} already`);
  if (db.query("SELECT 1 FROM tickets WHERE id = ? AND location = 'cloud'").get(o.id)) throw new Error(`#${o.id} is in the cloud; bring it back first (⇧L)`);
  return closeTicket(db, { ...o, who: "you", what: "dropped" });
}

// Closes a ticket: its live sessions stop and its worktrees go (one with uncommitted work stays).
export function closeTicket(db: Database, o: { id: number; run: Run; now: string; who: string; what: string; why?: string }) {
  const space = (db.query("SELECT space FROM tickets WHERE id = ?").get(o.id) as Row).space;
  const live = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("UPDATE stages SET ended_at = ?, detail = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.what, o.id);
  db.query("DELETE FROM planned WHERE ticket = ?").run(o.id);
  db.query("UPDATE tickets SET state = 'closed', detail = NULL, needs_kind = NULL, needs_text = NULL, blocked_by = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  for (const s of live) o.run(["hc", "kill", s.terminal]);
  const repos = ticketRepos(db, o.id).filter((r) => r.worktree);
  if (repos.length) closeSpace(o.run, space);
  let left = 0;
  for (const r of repos) {
    if (o.run(["git", "-C", r.path, "worktree", "remove", r.worktree!]).code === 0) setWork(db, o.id, { worktree: null }, r.repo);
    else left++;
  }
  if (repos.length && !left) db.query("UPDATE tickets SET space = NULL WHERE id = ?").run(o.id);
  const removed = `${repos.length - left} worktree${repos.length - left === 1 ? "" : "s"} removed; the branch stays${left ? `; ${left} worktree with uncommitted work stays` : ""}`;
  note(db, o.id, o.who, o.what, o.why ? `${o.why}; ${removed}` : removed, o.now);
  return { removed: repos.length - left, left };
}
