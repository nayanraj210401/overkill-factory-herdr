// How a ticket enters the factory: from a GitHub issue (a link, #412 or 412) or a
// one-line goal. D6 adds the Project's Ready column and grooming on top of this.
import type { Database } from "bun:sqlite";
import type { Run } from "./runner.ts";
import { matchesFilter, type Trigger } from "./triggers.ts";
import { journal } from "./journal.ts";

// Goals without an issue get ids from here up, clear of any repo's issue numbers.
export const LOCAL_IDS = 10000;

export type Source = { issue: number; repo: string | null } | { goal: string };

export function parseSource(text: string): Source {
  const t = text.trim();
  const url = t.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/);
  if (url) return { issue: Number(url[2]), repo: url[1] };
  const num = t.match(/^#?(\d+)$/);
  if (num) return { issue: Number(num[1]), repo: null };
  return { goal: t.replace(/\s+/g, " ") };
}

// `parent`: the ticket this one re-requests (factory new --parent). Its digest is where this one's
// memory starts (digest.ts). A paused ticket can't be one: a paused ticket with parts is a split's,
// which closes once its parts merge.
export function newTicket(db: Database, o: { text: string; repo: string; blueprint: string; run: Run; now: string; trigger?: string; groom?: boolean; parent?: number; note?: string }) {
  if (o.parent != null) {
    const p = db.query("SELECT state FROM tickets WHERE id = ?").get(o.parent) as { state: string } | null;
    if (!Number.isInteger(o.parent) || !p) throw new Error(`--parent: no ticket ${o.parent}`);
    if (p.state === "paused") throw new Error(`--parent: #${o.parent} is paused; resume or drop it first (a paused ticket's parts come from factory split)`);
  }
  const src = parseSource(o.text);
  let id: number;
  let title: string;
  if ("goal" in src) {
    if (!src.goal) throw new Error("type an issue link, #number, or a one-line goal");
    const max = (db.query("SELECT MAX(id) AS m FROM tickets WHERE id >= ?").get(LOCAL_IDS) as { m: number | null }).m;
    id = (max ?? LOCAL_IDS - 1) + 1;
    title = src.goal;
  } else {
    const repo = src.repo ?? (o.repo !== "unknown" ? o.repo : null);
    if (!repo) throw new Error("this factory has no repo; use the issue's full link, or factory init --repo owner/name");
    if (src.repo && o.repo !== "unknown" && src.repo.toLowerCase() !== o.repo.toLowerCase()) throw new Error(`that issue is in ${src.repo}; this factory works on ${o.repo}`);
    const r = o.run(["gh", "issue", "view", String(src.issue), "--repo", repo, "--json", "number,title,state"]);
    if (r.code !== 0) throw new Error(`gh issue view failed: ${r.out}`);
    let issue: { number: number; title: string; state: string };
    try { issue = JSON.parse(r.out); } catch { throw new Error(`gh issue view printed no JSON: ${r.out.slice(0, 200)}`); }
    if (issue.state !== "OPEN") throw new Error(`issue #${issue.number} is ${issue.state.toLowerCase()}`);
    id = issue.number;
    title = issue.title;
  }
  if (db.query("SELECT 1 FROM tickets WHERE id = ?").get(id)) throw new Error(`#${id} is already a ticket`);
  const note = o.note?.trim() || null;
  // Groomed first (plan: grooming is the one stop), unless the caller starts it right away.
  db.query("INSERT INTO tickets (id, title, state, blueprint, trigger_name, parent, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, title, o.groom ? "grooming" : "queued", o.blueprint, o.trigger ?? "manual", o.parent ?? null, note, o.now);
  const added = `${"goal" in src ? "a goal" : `issue #${id}`}: ${title}`;
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(id, "goal" in src ? "added a goal" : `added issue #${id}`, o.now);
  journal(db, { ticket: id, kind: "created", text: `you added ${added} (${o.blueprint} blueprint${o.groom ? ", grooming first" : ""}${o.parent != null ? `; it re-requests #${o.parent}` : ""}${note ? "; with your note" : ""})`, ref: "goal" in src ? null : `issue:${id}`, at: o.now });
  if (note) journal(db, { ticket: id, kind: "note", text: `your note, which outweighs the factory's prompts in every brief: ${note}`, at: o.now });
  return { id, title };
}

// D6 queue (plan: Grooming): issues in the GitHub Project's Ready column, assigned to
// you, join as grooming tickets. factory.yaml: queue: { github_project: owner/<number
// or title>, column: Ready, assignee: me }. Triage starts on them a few at a time.
type Item = { status?: string; assignees?: string[]; labels?: string[]; content?: { type?: string; number?: number; title?: string; repository?: string; url?: string } };

const repoOf = (s = "") => s.replace(/^https:\/\/github\.com\//, "").split("/").slice(0, 2).join("/").toLowerCase();

export function json(run: Run, argv: string[]) {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.out.slice(0, 200)}`);
  try { return JSON.parse(r.out); } catch { throw new Error(`${argv.slice(0, 3).join(" ")} printed no JSON: ${r.out.slice(0, 200)}`); }
}

// Names are looked up once and kept in meta: the project's number and your login.
export function projectNumber(db: Database, run: Run, project: string) {
  const [owner, ...rest] = project.split("/");
  const name = rest.join("/");
  if (!owner || !name) throw new Error(`queue.github_project "${project}" isn't owner/<number or title>`);
  if (/^\d+$/.test(name)) return { owner, number: Number(name) };
  const key = `queue_project:${project}`;
  const known = (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  if (known) return { owner, number: Number(known) };
  const found = (json(run, ["gh", "project", "list", "--owner", owner, "--format", "json", "--limit", "100"]).projects as { number: number; title: string }[])
    .find((p) => p.title.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`no project "${name}" for ${owner}; gh needs the project scope: gh auth refresh -s project`);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(found.number));
  return { owner, number: found.number };
}

export function login(db: Database, run: Run, assignee: string) {
  if (assignee !== "me") return assignee.replace(/^@/, "");
  const known = (db.query("SELECT value FROM meta WHERE key = 'gh_login'").get() as { value: string } | null)?.value;
  if (known) return known;
  const r = run(["gh", "api", "user", "-q", ".login"]);
  if (r.code !== 0 || !r.out.trim()) throw new Error(`gh api user failed: ${r.out.slice(0, 200)}`);
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('gh_login', ?)").run(r.out.trim());
  return r.out.trim();
}

export function pollQueue(db: Database, o: { queue: { github_project?: string; column?: string; assignee?: string } | undefined; repo: string; run: Run; now: string; trigger?: Trigger }) {
  const q = o.queue;
  if (!q?.github_project) return [];
  const { owner, number } = projectNumber(db, o.run, q.github_project);
  const who = q.assignee ? login(db, o.run, q.assignee) : null;
  const column = (q.column ?? "Ready").toLowerCase();
  const items = (json(o.run, ["gh", "project", "item-list", String(number), "--owner", owner, "--format", "json", "--limit", "500"]).items ?? []) as Item[];
  const added: number[] = [];
  for (const it of items) {
    const c = it.content;
    if (c?.type !== "Issue" || !c.number || (it.status ?? "").toLowerCase() !== column) continue;
    if (repoOf(c.repository ?? c.url) !== o.repo.toLowerCase()) continue; // another repo's issue
    if (who && !(it.assignees ?? []).some((a) => a.toLowerCase() === who.toLowerCase())) continue;
    if (!matchesFilter(o.trigger?.filter, { repo: repoOf(c.repository ?? c.url), labels: it.labels })) continue;
    if (db.query("SELECT 1 FROM tickets WHERE id = ?").get(c.number)) continue;
    // Without a trigger the blueprint stays the column default; triage may still pick another.
    db.query("INSERT INTO tickets (id, title, state, blueprint, trigger_name, updated_at) VALUES (?, ?, 'grooming', ?, ?, ?)")
      .run(c.number, c.title ?? `Issue #${c.number}`, o.trigger?.blueprint ?? "feature", o.trigger?.name ?? "queue", o.now);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(c.number, `joined from ${q.github_project}'s ${q.column ?? "Ready"} column`, o.now);
    journal(db, { ticket: c.number, kind: "created", text: `joined from ${q.github_project}'s ${q.column ?? "Ready"} column: ${c.title ?? `Issue #${c.number}`}`, ref: `issue:${c.number}`, at: o.now });
    added.push(c.number);
  }
  return added;
}
