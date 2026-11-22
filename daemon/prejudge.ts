// Cheap pre-judging (plan: Closing the review loop, step 2). When new review comments
// arrive, a small model (review.judge_model, haiku unless set) proposes a verdict for
// each, seeing only the comment and the lines it points at. The proposal is recorded as
// the comment's suggested verdict and shown in REVIEW.md; it pre-fills, and `factory
// comment` still decides. The one exception: while you're away, a clear-cut `fix`
// proposal is applied as the verdict. A pushback or an escalation is never applied on a
// cheap model's guess; a pushback needs the agreement gate (daemon/agreement.ts) too.
import { pinModel } from "./models.ts";
import type { Database } from "bun:sqlite";
import { readFactory, type Run } from "./runner.ts";
import { isAway } from "./away.ts";
import { judge, VERDICTS, type Row } from "./comments.ts";

export type Proposal = { verdict: (typeof VERDICTS)[number]; why: string; clear: boolean };

export const judgeModel = (repo: string) => {
  const m = ((readFactory(repo) as any).review ?? {}).judge_model;
  return pinModel(typeof m === "string" && m.trim() ? m.trim() : "haiku")!;
};

export const judgePrompt = (c: { author: string; place: string | null; body: string; hunk?: string | null }) => [
  `You triage one code review comment. You see only the comment and the lines it points at.`,
  `Is it correct, is it required, how risky is a change? Answer with exactly these three lines and nothing else:`,
  `VERDICT: fix | pushback | escalate`,
  `CLEAR: yes | no`,
  `WHY: one short sentence`,
  `fix: the comment is right and the change is small and safe. pushback: it is wrong or a matter of taste, and you can say why. escalate: a product question, or a call a person should make.`,
  `CLEAR is yes only when no reasonable reviewer would disagree with your verdict.`,
  "",
  `Comment by @${c.author}${c.place ? ` on ${c.place}` : ""}:`,
  c.body.trim().slice(0, 2000),
  c.hunk ? `\nThe lines it points at:\n${c.hunk.slice(0, 3000)}` : "",
].join("\n");

// Defensive: the first VERDICT line wins, in any case, with markdown around it. A line that
// names no verdict, or two different ones, is no proposal.
export function parseProposal(out: string): Proposal | null {
  const line = (key: string) => out.split("\n").map((l) => l.trim().replace(/^[-*>\s`]+/, "").replace(/\*\*/g, "")).find((l) => new RegExp(`^${key}\\s*:`, "i").test(l));
  const words = line("verdict")?.replace(/^verdict\s*:\s*/i, "").toLowerCase().match(/[a-z]+/g) ?? [];
  const named = [...new Set(words.filter((w) => (VERDICTS as readonly string[]).includes(w)))];
  if (named.length !== 1) return null;
  const clear = /^yes\b/i.test(line("clear")?.replace(/^clear\s*:\s*/i, "") ?? "");
  const why = (line("why")?.replace(/^why\s*:\s*/i, "") ?? "").slice(0, 200);
  return { verdict: named[0] as Proposal["verdict"], why, clear };
}

// Records a suggestion for each new comment (a failed or unreadable call just means none)
// and fills it into the rows.
export function prejudge(db: Database, o: { repo: string; ticket: number; rows: Row[]; run: Run; now: string }) {
  const model = judgeModel(o.repo);
  const away = isAway(db);
  for (const c of o.rows) {
    if (c.insisted) continue; // fix it or escalate; nothing to guess
    let p: Proposal | null = null;
    try {
      const r = o.run(["claude", "-p", "--model", model, judgePrompt(c)]);
      p = r.code === 0 ? parseProposal(r.out) : null;
    } catch { p = null; }
    if (!p) continue;
    db.query("UPDATE comments SET suggested = ?, suggested_why = ? WHERE ticket = ? AND n = ?").run(p.verdict, p.why || null, o.ticket, c.n);
    c.suggested = p.verdict;
    c.why = p.why;
    if (away && p.verdict === "fix" && p.clear) {
      judge(db, { ticket: o.ticket, n: c.n, verdict: "fix", reason: `auto: ${model} judged it a clear fix${p.why ? `; ${p.why}` : ""}`, now: o.now });
      c.verdict = "fix";
    }
  }
  return o.rows;
}
