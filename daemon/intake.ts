// How a ticket enters the factory: from a GitHub issue (a link, #412 or 412) or a
// one-line goal. D6 adds the Project's Ready column and grooming on top of this.
import type { Database } from "bun:sqlite";
import type { Run } from "./runner.ts";

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

export function newTicket(db: Database, o: { text: string; repo: string; blueprint: string; run: Run; now: string }) {
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
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, ?, ?, ?)").run(id, title, o.blueprint, o.now);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(id, `added ${"goal" in src ? "a goal" : `issue #${id}`}`, o.now);
  return { id, title };
}
