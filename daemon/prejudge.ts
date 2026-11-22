// Cheap pre-judging (plan: Closing the review loop, step 2). When new review comments
// arrive, the babysitter's judge (review.judge_model, else babysitter.md's model) proposes a verdict for
// each, seeing only the comment and the lines it points at. The proposal is recorded as
// the comment's suggested verdict and shown in REVIEW.md; it pre-fills, and `factory
// comment` still decides. The one exception: while you're away, a clear-cut `fix`
// proposal is applied as the verdict. A pushback or an escalation is never applied on a
// cheap model's guess; a pushback needs the agreement gate (daemon/agreement.ts) too.
import { createHash } from "node:crypto";
import { pinModel } from "./models.ts";
import type { Database } from "bun:sqlite";
import { loadAgent, readFactory, type Run } from "./runner.ts";
import { isAway } from "./away.ts";
import { judge, VERDICTS, type Row } from "./comments.ts";

export type Proposal = { verdict: (typeof VERDICTS)[number]; why: string; clear: boolean };

// The babysitter is a factory agent: babysitter.md (the shipped default unless the factory
// has its own) gives the judge its words, model and context, and the fix rounds their
// guidance. The rules stay here, in code: the answer's format, insistence after
// review.pushbacks, the away rules and the agreement gate (agreement.ts).
export type Babysitter = { model: string | null; context: string[]; intro: string; judging: string; rounds: string };

// "## Heading" sections of an agent's prompt; the text before the first one is the intro.
export function sections(prompt: string) {
  const parts = prompt.split(/^(?=##[ \t])/m);
  const intro = /^##[ \t]/.test(parts[0]) ? "" : parts.shift()!.trim();
  return { intro, parts: parts.map((p) => ({ head: p.split("\n")[0].replace(/^##[ \t]+/, "").trim().toLowerCase(), text: p.trim() })) };
}

export function babysitter(repo: string): Babysitter {
  const a = loadAgent(repo, "babysitter");
  if (!a) throw new Error("no babysitter agent: agents/babysitter.md is missing from the factory and the shipped defaults");
  const { intro, parts } = sections(a.prompt as string);
  const part = (start: string) => parts.find((p) => p.head.startsWith(start))?.text ?? "";
  const judging = part("judg");
  return {
    model: typeof a.model === "string" && a.model.trim() ? a.model.trim() : null,
    context: Array.isArray(a.context) ? a.context.map(String) : ["comment", "lines"],
    intro,
    judging: judging || (a.prompt as string).trim(), // no judging section: the whole prompt
    rounds: part("fix round"),
  };
}

// review.judge_model in factory.yaml wins, then babysitter.md's model, then haiku.
export const judgeModel = (repo: string, b: Babysitter = babysitter(repo)) => {
  const m = ((readFactory(repo) as any).review ?? {}).judge_model;
  return pinModel(typeof m === "string" && m.trim() ? m.trim() : b.model ?? "haiku")!;
};

// The judge's answer format, which parseProposal reads. It is code, not the agent's text,
// so a change to babysitter.md can't make answers unreadable.
const FORMAT = [
  `Answer with exactly these three lines and nothing else:`,
  `VERDICT: fix | pushback | escalate`,
  `CLEAR: yes | no`,
  `WHY: one short sentence`,
];

type Comment = { author: string; place: string | null; body: string; hunk?: string | null };

// The role's own text, the fixed format, then the comment and (when babysitter.md's
// context lists `lines`) the lines it points at. Nothing about the ticket.
export const judgePrompt = (c: Comment, b: Babysitter) => [
  ...(b.intro ? [b.intro, ""] : []),
  b.judging,
  "",
  `You see only the comment${b.context.includes("lines") ? " and the lines it points at" : ""}.`,
  ...FORMAT,
  "",
  `Comment by @${c.author}${c.place ? ` on ${c.place}` : ""}:`,
  c.body.trim().slice(0, 2000),
  c.hunk && b.context.includes("lines") ? `\nThe lines it points at:\n${c.hunk.slice(0, 3000)}` : "",
].join("\n");

// Which judge this is, for the agreement benchmark: its model and its words. A changed
// babysitter.md is a new judge, so a run on the old one no longer opens the gate.
export function judgeId(repo: string, b: Babysitter = babysitter(repo)) {
  const model = judgeModel(repo, b);
  const text = judgePrompt({ author: "", place: null, body: "" }, b);
  return { model, prompt: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

// One judgement: the claude -p call and its parsed answer; null when the call fails or
// the answer can't be read. Pre-judging and the agreement benchmark both call this.
export function askJudge(run: Run, model: string, c: Comment, b: Babysitter): { p: Proposal | null; why: string | null } {
  try {
    const r = run(["claude", "-p", "--model", model, judgePrompt(c, b)]);
    if (r.code !== 0) return { p: null, why: `exit ${r.code}: ${r.out.split("\n")[0].slice(0, 120)}` };
    const p = parseProposal(r.out);
    return p ? { p, why: null } : { p: null, why: "unreadable answer" };
  } catch (e) { return { p: null, why: (e as Error).message.slice(0, 120) }; }
}

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
  const b = babysitter(o.repo);
  const model = judgeModel(o.repo, b);
  const away = isAway(db);
  for (const c of o.rows) {
    if (c.insisted) continue; // fix it or escalate; nothing to guess
    const { p } = askJudge(o.run, model, c, b);
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
