// M3 review loop (PRD 6.5): every reviewer comment gets a verdict from the fix agent:
// fix it, push back (a reply with reasoning a reviewer can check), or escalate to you.
// A reviewer who replies again in a thread after `review.pushbacks` pushbacks (default
// 2) wins: that comment can't be pushed back again.
import type { Database } from "bun:sqlite";
import type { Run } from "./runner.ts";
import { awayPolicy, isAway } from "./away.ts";

export type GhComment = { ghId: string; thread: string; author: string; body: string; at: string; place: string | null; url: string | null };
export type Row = { n: number; author: string; place: string | null; body: string; insisted: number; verdict: string | null; reason: string | null; thread: string };
export const VERDICTS = ["fix", "pushback", "escalate"] as const;

const pushbacksIn = (db: Database, ticket: number, thread: string) =>
  (db.query("SELECT COUNT(*) AS n FROM comments WHERE ticket = ? AND thread = ? AND verdict = 'pushback'").get(ticket, thread) as { n: number }).n;

// New comments only (a comment seen before keeps its number and verdict).
export function storeComments(db: Database, o: { ticket: number; pr: number; comments: GhComment[]; limit: number }) {
  const added: Row[] = [];
  for (const c of o.comments) {
    if (db.query("SELECT 1 FROM comments WHERE ticket = ? AND gh_id = ?").get(o.ticket, c.ghId)) continue;
    const n = ((db.query("SELECT MAX(n) AS m FROM comments WHERE ticket = ?").get(o.ticket) as { m: number | null }).m ?? 0) + 1;
    const insisted = pushbacksIn(db, o.ticket, c.thread) >= o.limit ? 1 : 0;
    db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, place, body, at, url, insisted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(o.ticket, n, o.pr, c.ghId, c.thread, c.author, c.place, c.body, c.at, c.url, insisted);
    added.push({ n, author: c.author, place: c.place, body: c.body, insisted, verdict: null, reason: null, thread: c.thread });
  }
  return added;
}

export function commentsNote(o: { ticket: number; pr: number; rows: Row[]; limit: number }) {
  return [
    `Give every comment a verdict before you finish: factory comment ${o.ticket} C<n> fix|pushback|escalate <reason>.`,
    `- fix: it's correct and required; change the code, and say so in PR.md.`,
    `- pushback: reply on the PR first (gh pr comment ${o.pr}, or a reply on the line) with a reason a reviewer can check. After ${o.limit} pushback${o.limit === 1 ? "" : "s"} in a thread, a reviewer who insists wins.`,
    `- escalate: a product question, or a call you shouldn't make; the ticket stops and asks the person.`,
    "",
    ...o.rows.map((c) => `- **C${c.n} · @${c.author}**${c.place ? ` (${c.place})` : ""}${c.insisted ? " · **insisted after pushbacks: fix it, or escalate**" : ""}: ${c.body.trim().replace(/\n/g, "\n  ")}`),
  ].join("\n");
}

// `factory comment <ticket> C3 fix|pushback|escalate <reason…>`
export function judge(db: Database, o: { ticket: number; n: number; verdict: string; reason: string; now: string; repo?: string }) {
  if (!(VERDICTS as readonly string[]).includes(o.verdict)) throw new Error(`a verdict is ${VERDICTS.join(", ")}`);
  const c = db.query("SELECT * FROM comments WHERE ticket = ? AND n = ?").get(o.ticket, o.n) as Record<string, any> | null;
  if (!c) throw new Error(`#${o.ticket} has no comment C${o.n}`);
  // The plan: below the measured agreement with you, no pushbacks while you're away. It
  // isn't measured yet, so only a factory that sets away.min_agreement holds to it.
  if (o.verdict === "pushback" && isAway(db) && o.repo && awayPolicy(o.repo).min_agreement != null) throw new Error(`C${o.n}: no pushbacks while the person is away; fix it, or escalate`);
  if (o.verdict === "pushback" && c.insisted) throw new Error(`C${o.n}: @${c.author} insisted after pushbacks; fix it, or escalate`);
  if (!o.reason.trim() && o.verdict !== "fix") throw new Error(`say why: factory comment ${o.ticket} C${o.n} ${o.verdict} <reason>`);
  db.query("UPDATE comments SET verdict = ?, reason = ?, judged_at = ? WHERE id = ?").run(o.verdict, o.reason.trim() || null, o.now, c.id);
}

// At the end of the stage that handled the comments: each needs a verdict, and an
// escalation stops the ticket for you.
export function commentGate(db: Database, ticket: number, now: string): { failed: string } | { park: string } | null {
  const open = db.query("SELECT n FROM comments WHERE ticket = ? AND verdict IS NULL ORDER BY n").all(ticket) as { n: number }[];
  if (open.length) return { failed: `review comment${open.length > 1 ? "s" : ""} ${open.map((c) => `C${c.n}`).join(", ")} ${open.length > 1 ? "have" : "has"} no verdict (factory comment ${ticket} C<n> fix|pushback|escalate <reason>)` };
  const up = db.query("SELECT n, author, body, reason FROM comments WHERE ticket = ? AND verdict = 'escalate' AND escalated_at IS NULL ORDER BY n").all(ticket) as { n: number; author: string; body: string; reason: string }[];
  if (!up.length) return null;
  db.query("UPDATE comments SET escalated_at = ? WHERE ticket = ? AND verdict = 'escalate' AND escalated_at IS NULL").run(now, ticket);
  return { park: `Escalated ${up.map((c) => `C${c.n}`).join(", ")}: @${up[0].author} "${up[0].body.trim().slice(0, 80)}" · ${up[0].reason}` };
}

export const pushbackLimit = (review: unknown) => {
  const n = (review as { pushbacks?: unknown } | undefined)?.pushbacks;
  return typeof n === "number" && n >= 0 ? n : 2;
};

export type { Run };
