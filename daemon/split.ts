// Split (plan: Ticket lifecycle). Grooming, or any stage later, can find that a ticket is
// really several. Its agent proposes the parts in order (`factory split <id> add <title>
// --scope …`); at the end of its stage the daemon stops for you (`tickets.split: human`,
// the default) or creates them itself (`auto`). Each part becomes a GitHub sub-issue of the
// ticket's issue (a goal's parts become local tickets) and a groomed ticket here, each
// waiting on the one before it. Work done so far stays on the branch: the part marked
// --keeps-work (else the first) starts its branch from it. The parent waits, paused, and
// closes when every part is merged or closed.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { needLead } from "./db.ts";
import { LOCAL_IDS } from "./intake.ts";
import { closeTicket, unblock } from "./lifecycle.ts";
import { finishGrooming, startGroomed } from "./groom.ts";
import { advance, readFactory, type Run } from "./runner.ts";
import { decisionKind, journal } from "./journal.ts";

type Part = { n: number; title: string; scope: string | null; keeps_work: number };
type Row = Record<string, any>;

export const splitMode = (repo: string) => {
  const t = readFactory(repo).tickets;
  return (typeof t === "object" && t?.split) || "human";
};

export const pendingParts = (db: Database, id: number) =>
  db.query("SELECT n, title, scope, keeps_work FROM splits WHERE ticket = ? AND decided IS NULL ORDER BY n").all(id) as Part[];

export const childrenOf = (db: Database, id: number) =>
  db.query("SELECT id, state FROM tickets WHERE parent = ? ORDER BY id").all(id) as { id: number; state: string }[];

const note = (db: Database, id: number, who: string, what: string, why: string | null, now: string) => {
  const d = db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(id, who, what, why, now).lastInsertRowid;
  journal(db, { ticket: id, kind: decisionKind(what), text: `${who}: ${what}${why ? ` (${why})` : ""}`, ref: `decision:${d}`, at: now });
};

// `factory split <id> add <title…> [--scope text] [--keeps-work]`: one part, in order.
export function proposePart(db: Database, o: { id: number; title: string; scope?: string | null; keepsWork?: boolean; now: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!["grooming", "running"].includes(t.state)) throw new Error(`#${o.id} is ${t.state}; a split is proposed while it's groomed or running`);
  if (childrenOf(db, o.id).length) throw new Error(`#${o.id} is split already`);
  const title = o.title.trim();
  if (!title) throw new Error("usage: factory split <id> add <title…> [--scope text] [--keeps-work]");
  const n = ((db.query("SELECT MAX(n) AS m FROM splits WHERE ticket = ?").get(o.id) as { m: number | null }).m ?? 0) + 1;
  const s = db.query("SELECT agent FROM sessions WHERE ticket = ? AND ended_at IS NULL").get(o.id) as { agent: string } | null;
  db.query("INSERT INTO splits (ticket, n, title, scope, keeps_work, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.id, n, title, o.scope?.trim() || null, o.keepsWork ? 1 : 0, s?.agent ?? "you", o.now);
  return n;
}

const listing = (parts: Part[]) => parts.map((p, i) => `${i + 1}. ${p.title}${p.scope ? ` (${p.scope})` : ""}`).join("; ");

// At a stage boundary (the end of grooming, or of any stage): a proposed split stops the
// ticket for you, or is created at once under `tickets.split: auto`. null: nothing proposed.
export function splitGate(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  const parts = pendingParts(db, o.id);
  if (!parts.length) return null;
  if (splitMode(o.repo) === "auto") return { split: "created" as const, children: createSplit(db, { ...o, who: "daemon" }) };
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row;
  const text = `Split proposed into ${parts.length}: ${listing(parts)}. \`factory split ${o.id} approve\` creates them as sub-issues; \`factory split ${o.id} reject\` goes on as one ticket.`;
  db.query("UPDATE stages SET ended_at = ?, detail = 'split proposed' WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  // A running ticket waits paused (its worktree stays); one in grooming stays in grooming.
  db.query("UPDATE tickets SET state = ?, needs_kind = 'question', needs_text = ?, updated_at = ? WHERE id = ?")
    .run(t.state === "running" ? "paused" : "grooming", text, o.now, o.id);
  note(db, o.id, "daemon", `split proposed into ${parts.length}`, "tickets.split: human", o.now);
  return { split: "asked" as const };
}

// `factory split <id> approve|reject`, or `u` with yes/no.
export function decideSplit(db: Database, o: { dir: string; repo: string; id: number; approve: boolean; run: Run; now: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as Row | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!pendingParts(db, o.id).length) throw new Error(`#${o.id} has no split proposed`);
  if (o.approve) return { children: createSplit(db, { ...o, who: "you" }) };
  db.query("UPDATE splits SET decided = 'rejected' WHERE ticket = ? AND decided IS NULL").run(o.id);
  db.query("UPDATE tickets SET needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  note(db, o.id, "you", "kept it as one ticket", "split rejected", o.now);
  // Go on from where the split stopped it: grooming ends, or the stage that proposed it is followed.
  if (t.state === "grooming") return { rejected: true, ...finishGrooming(db, o) };
  if (t.state === "paused") {
    db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(o.id);
    return { rejected: true, ...advance(db, o) };
  }
  return { rejected: true };
}

const out = (run: Run, cwd: string, ...argv: string[]) => run(["git", "-C", cwd, ...argv]).out;

function createSplit(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; who: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Row;
  const parts = pendingParts(db, o.id);
  // The work so far is committed, so the part that keeps it starts from all of it.
  if (t.worktree && out(o.run, t.worktree, "status", "--porcelain")) {
    out(o.run, t.worktree, "add", "-A");
    out(o.run, t.worktree, "commit", "-q", "--no-verify", "-m", `factory: #${o.id} work in progress before the split`);
  }
  const keeper = (parts.find((p) => p.keeps_work) ?? parts[0]).n;
  const issue = o.id < LOCAL_IDS;
  const slug = needLead(db).slug;
  // Sub-issues already there (a split that failed half way) are reused by title, never made twice.
  const existing = issue ? subIssues(o.run, slug, o.id) : [];
  const made: number[] = [];
  for (const [i, p] of parts.entries()) {
    const body = `${p.scope ?? p.title}\n\nPart ${i + 1} of ${parts.length} of #${o.id}, split by the factory.${made.length ? ` After #${made.at(-1)}.` : ""}`;
    const child = issue ? existing.find((e) => e.title === p.title)?.number ?? newIssue(o.run, slug, o.id, p.title, body) : nextLocalId(db);
    db.query(`INSERT INTO tickets (id, title, state, blueprint, blocked_by, parent, base, groomed_at, trigger_name, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(child, p.title, made.length ? "blocked" : "queued", t.blueprint, made.at(-1) ?? null, o.id, p.n === keeper ? t.branch ?? null : null,
        o.now, t.trigger_name ?? "manual", `part ${i + 1} of #${o.id}`, o.now);
    // A cross-repo parent's parts work in the same repos.
    db.query("INSERT INTO ticket_repos (ticket, repo, lead) SELECT ?, repo, lead FROM ticket_repos WHERE ticket = ?").run(child, o.id);
    const folder = join(o.dir, "tickets", String(child));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "GROOMING.md"), `# Part ${i + 1} of ${parts.length} of #${o.id}: ${t.title}\n\n${p.scope ?? p.title}\n\n` +
      `The other parts: ${parts.filter((x) => x !== p).map((x) => x.title).join("; ") || "none"}. Build only this one.` +
      (p.n === keeper && t.branch ? `\n\nThis branch starts from ${t.branch}, with the work #${o.id} had done; keep what belongs to this part.\n` : "\n"));
    db.query("UPDATE splits SET decided = 'created', child = ? WHERE ticket = ? AND n = ?").run(child, o.id, p.n);
    note(db, child, o.who, `split from #${o.id}`, `part ${i + 1} of ${parts.length}`, o.now);
    made.push(child);
  }
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("UPDATE tickets SET state = 'paused', needs_kind = NULL, needs_text = NULL, detail = ?, updated_at = ? WHERE id = ?")
    .run(`split into ${made.map((c) => `#${c}`).join(", ")}; closes when they merge`, o.now, o.id);
  note(db, o.id, o.who, `split into ${made.map((c) => `#${c}`).join(", ")}`, listing(parts), o.now);
  startGroomed(db, o);
  return made;
}

function subIssues(run: Run, slug: string, parent: number) {
  const r = run(["gh", "api", `repos/${slug}/issues/${parent}/sub_issues`]);
  try { return r.code === 0 ? (JSON.parse(r.out) as { number: number; title: string }[]) : []; } catch { return []; }
}

// A new issue, linked as a sub-issue of the parent's. The link failing leaves a plain issue that names its parent.
function newIssue(run: Run, slug: string, parent: number, title: string, body: string) {
  const r = run(["gh", "issue", "create", "--repo", slug, "--title", title, "--body", body]);
  const n = Number(r.out.match(/\/issues\/(\d+)/)?.[1]);
  if (r.code !== 0 || !n) throw new Error(`gh issue create failed: ${r.out.slice(0, 200)}`);
  const id = run(["gh", "api", `repos/${slug}/issues/${n}`, "--jq", ".id"]).out.trim();
  if (/^\d+$/.test(id)) run(["gh", "api", "-X", "POST", `repos/${slug}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`]);
  return n;
}

const nextLocalId = (db: Database) =>
  ((db.query("SELECT MAX(id) AS m FROM tickets WHERE id >= ?").get(LOCAL_IDS) as { m: number | null }).m ?? LOCAL_IDS - 1) + 1;

// Every tick (no gh but the parent's close): a part waits until the one before it is
// merged or closed; a parent closes once all its parts are.
export function followSplits(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const done = "('merged', 'closed')";
  const waiting = db.query(`SELECT c.id, c.blocked_by FROM tickets c JOIN tickets b ON b.id = c.blocked_by AND b.parent = c.parent
    WHERE c.parent IS NOT NULL AND c.state = 'blocked' AND b.state IN ${done}`).all() as Row[];
  for (const c of waiting) {
    unblock(db, { ...o, id: c.id });
    o.log?.(`factory: #${c.id} goes on; #${c.blocked_by} is done`);
  }
  const parents = db.query(`SELECT p.id FROM tickets p WHERE p.state = 'paused' AND EXISTS (SELECT 1 FROM tickets c WHERE c.parent = p.id)
    AND NOT EXISTS (SELECT 1 FROM tickets c WHERE c.parent = p.id AND c.state NOT IN ${done})`).all() as Row[];
  for (const p of parents) {
    const kids = childrenOf(db, p.id);
    const merged = kids.filter((k) => k.state === "merged").map((k) => `#${k.id}`);
    closeTicket(db, { id: p.id, run: o.run, now: o.now, who: "daemon", what: "closed: every part is done", why: `merged ${merged.join(", ") || "none"}` });
    if (p.id < LOCAL_IDS)
      o.run(["gh", "issue", "close", String(p.id), "--repo", needLead(db).slug, "--comment", `Done in its parts: ${kids.map((k) => `#${k.id} (${k.state})`).join(", ")}.`]);
    o.log?.(`factory: #${p.id} closed; its parts are done`);
  }
}
