// M3 PR watcher (plan: the babysitter; PRD 6.5). Every factory PR waiting on you is
// read on GitHub: merged or closed there, the ticket follows; new review comments
// from other people go into REVIEW.md and send the ticket back to its fix stage,
// whose agent fixes each one or replies with its reasoning. The factory acts as your
// gh account, so what it posts carries a hidden marker (comments.ts FACTORY_MARK) and only
// that is skipped: your own review comments on your own PRs count like anyone's.
import type { Database } from "bun:sqlite";
import { finishPr, readFactory, reviewBack, type Run } from "./runner.ts";
import { commentsNote, fromFactory, pushbackLimit, storeComments, type GhComment, type Row } from "./comments.ts";
import { reviewRoundsLeft } from "./away.ts";
import { closeRound, openRound, writeBrief } from "./round.ts";
import { prejudge } from "./prejudge.ts";
import { setWork, ticketRepos, type TicketRepo } from "./db.ts";

function ghJson(run: Run, argv: string[]) {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.out.slice(0, 200)}`);
  return JSON.parse(r.out);
}

// Conversation comments, review summaries with a body, and inline comments on lines.
export function prComments(run: Run, slug: string, pr: number) {
  const view = ghJson(run, ["gh", "pr", "view", String(pr), "--repo", slug, "--json", "state,isDraft,comments,reviews"]);
  const inline = ghJson(run, ["gh", "api", `repos/${slug}/pulls/${pr}/comments`, "--paginate"]) as any[];
  // An inline reply's thread is its root comment; anything else is a thread of its own.
  const comments: GhComment[] = [
    ...(view.comments ?? []).map((c: any) => ({ ghId: `c${c.id}`, thread: `c${c.id}`, author: c.author?.login ?? "", body: c.body ?? "", at: c.createdAt, place: null, url: c.url ?? null })),
    ...(view.reviews ?? []).filter((r: any) => r.body?.trim()).map((r: any) => ({ ghId: `r${r.id}`, thread: `r${r.id}`, author: r.author?.login ?? "", body: r.body, at: r.submittedAt, place: r.state === "CHANGES_REQUESTED" ? "changes requested" : null, url: null })),
    ...inline.map((c: any) => ({ ghId: `i${c.id}`, thread: `i${c.in_reply_to_id ?? c.id}`, author: c.user?.login ?? "", body: c.body ?? "", at: c.created_at, place: c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : null, url: c.html_url ?? null, hunk: c.diff_hunk ?? null })),
  ];
  return { draft: !!view.isDraft, state: view.state as "OPEN" | "MERGED" | "CLOSED", comments: comments.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

// Every repo's PR of each ready, watched ticket. Merged or closed there, its repo is done;
// when every PR is, the ticket follows (merged only if they all merged). New comments on
// any of them go back to the fix stage together, as one review round.
export function watchPrs(db: Database, o: { dir: string; repo: string; me: string | null; run: Run; now: string; log?: (s: string) => void }) {
  const ids = (db.query(`SELECT DISTINCT t.id FROM tickets t JOIN ticket_repos r ON r.ticket = t.id
    WHERE t.state = 'ready' AND r.pr_watched = 1 AND r.pr_number IS NOT NULL ORDER BY t.id`).all() as { id: number }[]).map((r) => r.id);
  const out: { id: number; event: string }[] = [];
  for (const id of ids) {
    const repos = ticketRepos(db, id).filter((r) => r.pr_number != null);
    const name = (r: TicketRepo) => (repos.length > 1 ? `${r.repo}#${r.pr_number}` : `PR #${r.pr_number}`);
    try {
      // A round whose fixes are pushed gets its replies and summary; one that couldn't post last time tries again.
      closeRound(db, { ticket: id, run: o.run, now: o.now, log: o.log });
      // GitHub first, outside the transaction; a repo merged earlier isn't asked again.
      const prs = repos.map((r) => ({ r, pr: r.merged_at ? null : prComments(o.run, r.repo, r.pr_number!) }));
      db.transaction(() => {
        for (const { r, pr } of prs) if (pr?.state === "MERGED") setWork(db, id, { merged_at: o.now }, r.repo);
        // What GitHub says of each PR, for the window's links.
        for (const { r, pr } of prs) if (pr) setWork(db, id, { pr_state: pr.state === "OPEN" ? (pr.draft ? "draft" : "open") : (pr.state.toLowerCase() as "merged" | "closed") }, r.repo);
        const open = prs.filter((p) => p.pr?.state === "OPEN");
        if (!open.length) {
          const all = prs.every((p) => p.r.merged_at || p.pr?.state === "MERGED");
          finishPr(db, { repo: o.repo, id, run: o.run, now: o.now, state: all ? "merged" : "closed", why: "on GitHub", who: "daemon" });
          return out.push({ id, event: all ? "merged" : "closed" });
        }
        for (const p of prs) if (p.pr && p.pr.state !== "OPEN") out.push({ id, event: `${name(p.r)} ${p.pr.state.toLowerCase()}` });
        // New is "not stored yet", not "after the last check": the pr stage moves the check
        // time when it updates the PR, and a comment made during the fix must still count.
        const limit = pushbackLimit((readFactory(o.repo) as any).review);
        const stored: { pr: number; rows: Row[] }[] = [];
        let count = 0;
        for (const { r, pr } of open) {
          const fresh = pr!.comments.filter((c) => c.body.trim() && !fromFactory(c.body));
          setWork(db, id, { pr_checked_at: o.now }, r.repo);
          const rows = storeComments(db, { ticket: id, pr: r.pr_number!, comments: fresh, limit, repo: r.repo, round: () => openRound(db, id, o.now) });
          if (rows.length) stored.push({ pr: r.pr_number!, rows });
          count += rows.length;
        }
        if (!count) return;
        // A cheap model proposes a verdict for each; the notes show it, and the fix brief starts from the fix ones.
        for (const s of stored) prejudge(db, { repo: o.repo, ticket: id, rows: s.rows, run: o.run, now: o.now });
        writeBrief(db, { dir: o.dir, ticket: id, round: openRound(db, id, o.now), repo: o.repo });
        const notes = stored.map((s) => commentsNote({ ticket: id, pr: s.pr, rows: s.rows, limit }));
        const on = open.length > 1 ? open.map((p) => name(p.r)).join(", ") : name(open[0].r);
        const park = reviewRoundsLeft(db, o.repo, id) <= 0 ? `${count} new review comment${count > 1 ? "s" : ""} on ${on}; away.review_rounds is used up while you're away` : undefined;
        reviewBack(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now, park, text: notes.join("\n\n"),
          heading: `${count} review comment${count > 1 ? "s" : ""} on ${on} · ${o.now.slice(0, 16).replace("T", " ")}` });
        out.push({ id, event: `${count} comment${count > 1 ? "s" : ""}${park ? ", parked (away)" : ""}` });
      })();
    } catch (e) {
      o.log?.(`factory: #${id}: watching ${repos.map(name).join(", ")}: ${(e as Error).message}`);
    }
  }
  return out;
}
