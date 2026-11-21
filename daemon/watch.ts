// M3 PR watcher (plan: the babysitter; PRD 6.5). Every factory PR waiting on you is
// read on GitHub: merged or closed there, the ticket follows; new review comments
// from other people go into REVIEW.md and send the ticket back to its fix stage,
// whose agent fixes each one or replies with its reasoning. The factory acts as your
// gh account, so your own comments (and the agent's replies) never trigger it; send
// your own notes with `x`.
import type { Database } from "bun:sqlite";
import { finishPr, reviewBack, type Run } from "./runner.ts";

type Comment = { author: string; body: string; at: string; where: string | null; url: string | null };

function ghJson(run: Run, argv: string[]) {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.out.slice(0, 200)}`);
  return JSON.parse(r.out);
}

// Conversation comments, review summaries with a body, and inline comments on lines.
export function prComments(run: Run, slug: string, pr: number) {
  const view = ghJson(run, ["gh", "pr", "view", String(pr), "--repo", slug, "--json", "state,comments,reviews"]);
  const inline = ghJson(run, ["gh", "api", `repos/${slug}/pulls/${pr}/comments`, "--paginate"]) as any[];
  const comments: Comment[] = [
    ...(view.comments ?? []).map((c: any) => ({ author: c.author?.login ?? "", body: c.body ?? "", at: c.createdAt, where: null, url: c.url ?? null })),
    ...(view.reviews ?? []).filter((r: any) => r.body?.trim()).map((r: any) => ({ author: r.author?.login ?? "", body: r.body, at: r.submittedAt, where: r.state === "CHANGES_REQUESTED" ? "changes requested" : null, url: null })),
    ...inline.map((c: any) => ({ author: c.user?.login ?? "", body: c.body ?? "", at: c.created_at, where: c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : null, url: c.html_url ?? null })),
  ];
  return { state: view.state as "OPEN" | "MERGED" | "CLOSED", comments: comments.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

export function commentsNote(pr: number, cs: Comment[]) {
  return [
    `For each comment: fix it, or reply on the PR with your reasoning (gh pr comment ${pr}, or a reply on the line). Fix anything that is correct and required; push back only with a reason a reviewer can check. Say in PR.md what you changed.`,
    "",
    ...cs.map((c) => `- **@${c.author}**${c.where ? ` (${c.where})` : ""}: ${c.body.trim().replace(/\n/g, "\n  ")}`),
  ].join("\n");
}

export function watchPrs(db: Database, o: { dir: string; repo: string; slug: string; me: string | null; run: Run; now: string; log?: (s: string) => void }) {
  const tickets = db.query("SELECT id, pr_number, pr_checked_at FROM tickets WHERE state = 'ready' AND pr_watched = 1 AND pr_number IS NOT NULL").all() as
    { id: number; pr_number: number; pr_checked_at: string | null }[];
  const out: { id: number; event: string }[] = [];
  for (const t of tickets) {
    try {
      const pr = prComments(o.run, o.slug, t.pr_number);
      db.transaction(() => {
        if (pr.state !== "OPEN") {
          finishPr(db, { repo: o.repo, id: t.id, run: o.run, now: o.now, state: pr.state === "MERGED" ? "merged" : "closed", why: "on GitHub", who: "daemon" });
          return out.push({ id: t.id, event: pr.state.toLowerCase() });
        }
        const since = Date.parse(t.pr_checked_at ?? "1970-01-01T00:00:00Z");
        const fresh = pr.comments.filter((c) => Date.parse(c.at) > since && c.body.trim() && c.author.toLowerCase() !== (o.me ?? "").toLowerCase());
        db.query("UPDATE tickets SET pr_checked_at = ? WHERE id = ?").run(o.now, t.id);
        if (!fresh.length) return;
        reviewBack(db, { dir: o.dir, repo: o.repo, id: t.id, run: o.run, now: o.now, text: commentsNote(t.pr_number, fresh),
          heading: `${fresh.length} review comment${fresh.length > 1 ? "s" : ""} on PR #${t.pr_number} · ${o.now.slice(0, 16).replace("T", " ")}` });
        out.push({ id: t.id, event: `${fresh.length} comment${fresh.length > 1 ? "s" : ""}` });
      })();
    } catch (e) {
      o.log?.(`factory: #${t.id}: watching PR #${t.pr_number}: ${(e as Error).message}`);
    }
  }
  return out;
}
