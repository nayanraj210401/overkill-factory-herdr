// The agreement benchmark (plan: Away mode). Before the babysitter decides alone, it is
// checked against you: your past review comments are judged again by the judge
// (the babysitter's: review.judge_model or babysitter.md's model, with babysitter.md's
// words, the same call as prejudge.ts), and the share it gets the way you
// did is the agreement rate. Below away.min_agreement (85% unless set), no pushbacks while
// you're away: clear-cut fixes still go through, and the rest is escalated.
//
// Your verdict on a comment is the one you gave (`factory label`), or the one you kept:
// the verdict a comment had when you merged its PR, unless the judge itself applied it
// (an `auto:` fix while you were away), since that would grade the judge on its own answer.
import type { Database } from "bun:sqlite";
import type { Run } from "./runner.ts";
import { awayPolicy } from "./away.ts";
import { askJudge, babysitter, judgeId, judgeModel } from "./prejudge.ts";
import { VERDICTS } from "./comments.ts";

export const DEFAULT_MIN_AGREEMENT = 0.85;
// A rate from a handful of comments says little; below this many, it doesn't open the gate.
export const MIN_EXAMPLES = 10;
// The newest labelled comments a run judges, so a run's cost stays flat as history grows.
export const MAX_EXAMPLES = 100;

type Verdict = (typeof VERDICTS)[number];
export type Example = { ticket: number; n: number; author: string; place: string | null; body: string; hunk: string | null; yours: Verdict; source: "you" | "kept" };

export function examples(db: Database, limit = MAX_EXAMPLES): Example[] {
  return db.query(`SELECT c.ticket, c.n, c.author, c.place, c.body, c.hunk, COALESCE(c.label, c.verdict) AS yours,
      CASE WHEN c.label IS NOT NULL THEN 'you' ELSE 'kept' END AS source
    FROM comments c JOIN tickets t ON t.id = c.ticket
    WHERE c.insisted = 0 AND (c.label IS NOT NULL OR (c.verdict IS NOT NULL AND t.state = 'merged' AND COALESCE(c.reason, '') NOT LIKE 'auto:%'))
    ORDER BY COALESCE(c.labelled_at, c.judged_at, c.at) DESC, c.id DESC LIMIT ?`).all(limit) as Example[];
}

// `factory label <ticket> C<n> fix|pushback|escalate`: what you would have said. It is
// only a benchmark label; the comment's own verdict stays as it is.
export function label(db: Database, o: { ticket: number; n: number; verdict: string; now: string }) {
  if (!(VERDICTS as readonly string[]).includes(o.verdict)) throw new Error(`a verdict is ${VERDICTS.join(", ")}`);
  const r = db.query("UPDATE comments SET label = ?, labelled_at = ? WHERE ticket = ? AND n = ?").run(o.verdict, o.now, o.ticket, o.n);
  if (r.changes === 0) throw new Error(`#${o.ticket} has no comment C${o.n}`);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(o.ticket, `labelled C${o.n} ${o.verdict}`, o.now);
}

export type AgreementRun = { id: number; model: string; prompt: string | null; examples: number; agreed: number; failed: number; rate: number; started_at: string; ended_at: string };

// Judges every example, then records the run in one transaction (the calls are slow, and
// the database stays free while they run). A call that fails or can't be read counts as
// a disagreement: the gate errs toward asking you.
export function runAgreement(db: Database, o: { repo: string; run: Run; now: () => string; log?: (s: string) => void }) {
  const xs = examples(db);
  if (!xs.length) throw new Error("no labelled review comments yet: merge a factory PR that had review comments, or label some with factory label <id> C<n> <verdict>");
  const b = babysitter(o.repo);
  const { model, prompt } = judgeId(o.repo, b);
  const started = o.now();
  const items = xs.map((x) => {
    const a = askJudge(o.run, model, x, b);
    const got: Verdict | null = a.p?.verdict ?? null;
    const why = a.p ? a.p.why || null : a.why;
    o.log?.(`agreement: #${x.ticket} C${x.n}: yours ${x.yours}, judge ${got ?? "none"}`);
    return { ...x, got, why };
  });
  const agreed = items.filter((i) => i.got === i.yours).length;
  const failed = items.filter((i) => i.got == null).length;
  const rate = +(agreed / items.length).toFixed(3);
  let id = 0;
  db.transaction(() => {
    id = Number(db.query("INSERT INTO agreement_runs (model, prompt, examples, agreed, failed, rate, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(model, prompt, items.length, agreed, failed, rate, started, o.now()).lastInsertRowid);
    const add = db.query("INSERT INTO agreement_items (run, ticket, n, yours, source, got, why) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const i of items) add.run(id, i.ticket, i.n, i.yours, i.source, i.got, i.why);
  })();
  return latestAgreement(db, { model, prompt })!;
}

// The newest run, or the newest on one judge (its model and the hash of its words).
export const latestAgreement = (db: Database, judge?: { model: string; prompt: string }) =>
  (judge
    ? db.query("SELECT * FROM agreement_runs WHERE model = ? AND prompt = ? ORDER BY id DESC LIMIT 1").get(judge.model, judge.prompt)
    : db.query("SELECT * FROM agreement_runs ORDER BY id DESC LIMIT 1").get()) as AgreementRun | null;

export const minAgreement = (repo: string) => awayPolicy(repo).min_agreement ?? DEFAULT_MIN_AGREEMENT;

const pct = (n: number) => `${Math.round(n * 100)}%`;

// Whether the babysitter may push back while you're away, and why. Only a run on the judge
// in use now counts: a new model, or a changed babysitter.md, hasn't been checked against you yet.
export function pushbackGate(db: Database, repo: string): { ok: boolean; why: string; min: number; run: AgreementRun | null } {
  const min = minAgreement(repo);
  const judge = judgeId(repo);
  const run = latestAgreement(db, judge);
  if (min <= 0) return { ok: true, why: "away.min_agreement is 0, so the gate is off", min, run };
  if (!run) return { ok: false, why: `the judge (${judge.model}${latestAgreement(db, undefined)?.model === judge.model ? ", with babysitter.md as it is now" : ""}) hasn't been checked against the person's verdicts yet (factory agreement)`, min, run };
  if (run.examples < MIN_EXAMPLES) return { ok: false, why: `the judge was checked on only ${run.examples} past comment${run.examples === 1 ? "" : "s"}; the check needs ${MIN_EXAMPLES}`, min, run };
  if (run.rate < min) return { ok: false, why: `the judge matches the person's verdict on ${pct(run.rate)} of past comments, below away.min_agreement ${pct(min)}`, min, run };
  return { ok: true, why: `the judge matches the person's verdict on ${pct(run.rate)} of past comments (away.min_agreement ${pct(min)})`, min, run };
}

// The Metrics page's view of it: the latest run on the judge model in use, its breakdown
// by your verdict, and whether it opens the gate.
export function agreementMetrics(db: Database, repo: string | null) {
  if (!repo) return null;
  let gate: ReturnType<typeof pushbackGate>;
  try { gate = pushbackGate(db, repo); } catch { return null; }
  const r = gate.run;
  if (!r) return { rate: null, examples: 0, agreed: 0, failed: 0, model: judgeModel(repo), at: null, min: gate.min, ok: gate.ok, why: gate.why, by_verdict: [] };
  const by = db.query("SELECT yours, COUNT(*) AS n, SUM(got = yours) AS agreed FROM agreement_items WHERE run = ? GROUP BY yours").all(r.id) as { yours: string; n: number; agreed: number | null }[];
  return {
    rate: r.rate, examples: r.examples, agreed: r.agreed, failed: r.failed, model: r.model, at: r.ended_at, min: gate.min, ok: gate.ok, why: gate.why,
    by_verdict: VERDICTS.map((v) => by.find((b) => b.yours === v)).filter(Boolean).map((b) => ({ verdict: b!.yours, examples: b!.n, agreed: b!.agreed ?? 0 })),
  };
}

// The disagreements of a run, for `factory agreement`'s report.
export const disagreements = (db: Database, run: number) =>
  db.query(`SELECT i.ticket, i.n, i.yours, i.got, i.why, c.body FROM agreement_items i LEFT JOIN comments c ON c.ticket = i.ticket AND c.n = i.n
    WHERE i.run = ? AND (i.got IS NULL OR i.got != i.yours) ORDER BY i.ticket, i.n`).all(run) as { ticket: number; n: number; yours: string; got: string | null; why: string | null; body: string | null }[];
