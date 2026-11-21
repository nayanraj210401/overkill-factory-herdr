// Review rounds (plan: Closing the review loop). A round starts when the watcher stores
// new comments on a ready ticket's PRs and ends when its fixes are pushed and every PR has
// its one summary comment. In between:
//   - REVIEW-ROUND-<n>.md, the fix brief: only the comments marked fix, so the fresh fix
//     session never needs the session that wrote the PR;
//   - a token cap per round (review.round_budget, checked at stage boundaries in advance);
//   - pushback replies on the comments and the summary, posted through gh, each once.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./runner.ts";
import { ticketRepos } from "./db.ts";
import { prComments } from "./watch.ts";

type C = { n: number; repo: string | null; pr: number; gh_id: string; thread: string; author: string; place: string | null; body: string; hunk: string | null; verdict: string | null; reason: string | null; suggested: string | null; replied_at: string | null; fix_commit: string | null; url: string | null };

// The round new comments belong to: the open one, or a new one that remembers where the
// ticket's token counts stood.
export function openRound(db: Database, ticket: number, now: string) {
  const open = db.query("SELECT round FROM review_rounds WHERE ticket = ? AND closed_at IS NULL ORDER BY round DESC LIMIT 1").get(ticket) as { round: number } | null;
  if (open) return open.round;
  const last = (db.query("SELECT MAX(round) AS n FROM review_rounds WHERE ticket = ?").get(ticket) as { n: number | null }).n ?? 0;
  const t = db.query("SELECT tokens_in, tokens_out FROM tickets WHERE id = ?").get(ticket) as { tokens_in: number; tokens_out: number };
  db.query("INSERT INTO review_rounds (ticket, round, started_at, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)").run(ticket, last + 1, now, t.tokens_in, t.tokens_out);
  return last + 1;
}

const roundComments = (db: Database, ticket: number, round: number) =>
  db.query("SELECT * FROM comments WHERE ticket = ? AND round = ? ORDER BY n").all(ticket, round) as C[];

// The ticket's acceptance checks (INTENT.md, its Acceptance section), one per line.
function acceptance(folder: string) {
  let text = "";
  try { text = readFileSync(join(folder, "INTENT.md"), "utf8"); } catch { return []; }
  const part = text.split(/^(?=#{1,6}[ \t])/m).find((p) => /^acceptance/i.test(p.replace(/^#+[ \t]+/, "")));
  return (part ?? "").split("\n").slice(1).map((l) => l.trim()).filter((l) => /^([-*]|\d+[.)])\s/.test(l));
}

// REVIEW-ROUND-<n>.md: the comments to fix, each with the reviewer's words, file and line,
// the diff hunk and the acceptance checks it touches (the ones naming its file; when none
// does, all of them, since the fix must keep every check passing). A comment with no
// verdict yet counts when the cheap model suggested fix.
export function writeBrief(db: Database, o: { dir: string; ticket: number; round: number }) {
  const folder = join(o.dir, "tickets", String(o.ticket));
  const checks = acceptance(folder);
  const fix = roundComments(db, o.ticket, o.round).filter((c) => c.verdict === "fix" || (c.verdict == null && c.suggested === "fix"));
  const blocks = fix.map((c) => {
    const file = c.place?.split(":")[0];
    const touched = file ? checks.filter((l) => l.includes(file) || l.includes(file.split("/").pop()!)) : [];
    const list = touched.length ? touched : checks;
    return [
      `## C${c.n} · @${c.author}${c.place ? ` · ${c.place}` : ""}${c.repo ? ` · ${c.repo}` : ""}`,
      "",
      c.body.trim().split("\n").map((l) => `> ${l}`).join("\n"),
      c.hunk ? `\n\`\`\`diff\n${c.hunk.trim()}\n\`\`\`` : "",
      list.length ? `\nAcceptance ${touched.length ? "check it touches" : "checks to keep passing"}:\n${list.join("\n")}` : "",
    ].filter((x) => x !== "").join("\n");
  });
  writeFileSync(join(folder, `REVIEW-ROUND-${o.round}.md`), [
    `# Review round ${o.round}`,
    "",
    `You are a fresh session for this round; don't look for the one that wrote the PR. Fix only the comments below, in this worktree, and keep every acceptance check passing. REVIEW.md lists the round's other comments: give each one a verdict (factory comment ${o.ticket} C<n> fix|pushback|escalate <reason>).`,
    "",
    blocks.length ? blocks.join("\n\n") : "No comment is marked fix yet. Judge them in REVIEW.md.",
  ].join("\n") + "\n");
  return fix.map((c) => c.n);
}

// The newest fix brief in a ticket's folder, for a stage's brief to name.
export function latestBrief(folder: string) {
  try {
    const n = readdirSync(folder).map((f) => f.match(/^REVIEW-ROUND-(\d+)\.md$/)?.[1]).filter(Boolean).map(Number);
    return n.length ? `REVIEW-ROUND-${Math.max(...n)}.md` : null;
  } catch { return null; }
}

const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");
const short = (s: string) => { const t = s.trim().replace(/\s+/g, " "); return t.length > 100 ? `${t.slice(0, 97)}...` : t; };

function summary(ticket: number, round: number, mine: C[], others: boolean) {
  const at = (c: C) => `C${c.n}${c.place ? ` (${c.place})` : ""}`;
  const part = (head: string, rows: string[]) => (rows.length ? [`**${head}**`, ...rows, ""] : []);
  const out = [
    `<!-- factory-round ${ticket}-${round} -->`,
    `**Review round ${round}**`,
    "",
    ...part("Fixed", mine.filter((c) => c.verdict === "fix").map((c) => `- ${at(c)}${c.fix_commit ? ` in ${c.fix_commit}` : ""}: ${short(c.body)}`)),
    ...part("Pushed back (replied on the comment)", mine.filter((c) => c.verdict === "pushback").map((c) => `- ${at(c)}: ${c.reason}`)),
    ...part("Escalated to a person", mine.filter((c) => c.verdict === "escalate").map((c) => `- ${at(c)}: ${c.reason}`)),
  ];
  if (!mine.length) out.push(others ? "No comments on this PR this round; the fixes are in this ticket's other PR." : "No comments this round.");
  return out.join("\n").trim();
}

// Once the round's fixes are pushed: a pushback reply on each pushed-back comment that has
// none yet, then one summary comment on each of the ticket's PRs. Both are recorded as they
// land and checked on the PR before posting, so a retry (or a crash between the post and the
// record) never posts twice. Returns true when the round is closed; a failing gh leaves it
// open for the next call (the watcher makes one every tick).
export function closeRound(db: Database, o: { ticket: number; run: Run; now: string; log?: (s: string) => void }) {
  const open = db.query("SELECT round FROM review_rounds WHERE ticket = ? AND closed_at IS NULL ORDER BY round DESC LIMIT 1").get(o.ticket) as { round: number } | null;
  if (!open) return false;
  const round = open.round;
  const rows = roundComments(db, o.ticket, round);
  if (rows.some((c) => c.verdict == null)) return false; // the fix stage isn't done judging
  const repos = ticketRepos(db, o.ticket).filter((r) => r.pr_number != null);
  const fail = (m: string) => { o.log?.(`factory: #${o.ticket} round ${round}: ${m}`); return false; };
  try {
    for (const r of repos) {
      const mine = rows.filter((c) => (c.repo ?? repos[0].repo) === r.repo);
      const there = prComments(o.run, r.repo, r.pr_number!).comments;
      const sha = r.worktree ? o.run(["git", "-C", r.worktree, "rev-parse", "--short", "HEAD"]).out.trim() : "";
      for (const c of mine.filter((c) => c.verdict === "fix" && !c.fix_commit && sha)) {
        db.query("UPDATE comments SET fix_commit = ? WHERE ticket = ? AND n = ?").run(sha, o.ticket, c.n);
        c.fix_commit = sha;
      }
      for (const c of mine.filter((c) => c.verdict === "pushback" && !c.replied_at)) {
        // The agent may have replied already, as its brief says to: look in the thread first.
        const said = there.some((x) => x.thread === c.thread && x.ghId !== c.gh_id && x.body.includes(short(c.reason ?? "").slice(0, 40)));
        if (!said) {
          const id = c.gh_id.startsWith("i") ? c.thread.slice(1) : null;
          const g = id
            ? o.run(["gh", "api", `repos/${r.repo}/pulls/${r.pr_number}/comments/${id}/replies`, "-f", `body=${c.reason}`])
            : o.run(["gh", "pr", "comment", String(r.pr_number), "--repo", r.repo, "--body", `${quote(c.body)}\n\n${c.reason}`]);
          if (g.code !== 0) return fail(`reply to C${c.n} on ${r.repo}#${r.pr_number} failed: ${g.out.slice(0, 200)}`);
        }
        db.query("UPDATE comments SET replied_at = ? WHERE ticket = ? AND n = ?").run(o.now, o.ticket, c.n);
      }
      if (db.query("SELECT 1 FROM review_posts WHERE ticket = ? AND round = ? AND repo = ?").get(o.ticket, round, r.repo)) continue;
      const body = summary(o.ticket, round, mine, rows.length > mine.length);
      if (!there.some((x) => x.body.includes(`<!-- factory-round ${o.ticket}-${round} -->`))) {
        const g = o.run(["gh", "pr", "comment", String(r.pr_number), "--repo", r.repo, "--body", body]);
        if (g.code !== 0) return fail(`summary on ${r.repo}#${r.pr_number} failed: ${g.out.slice(0, 200)}`);
      }
      db.query("INSERT OR IGNORE INTO review_posts (ticket, round, repo, posted_at) VALUES (?, ?, ?, ?)").run(o.ticket, round, r.repo, o.now);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
  db.query("UPDATE review_rounds SET closed_at = ? WHERE ticket = ? AND round = ?").run(o.now, o.ticket, round);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(o.ticket, `posted review round ${round} summary`, o.now);
  return true;
}
