import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { setAway } from "./away.ts";
import { judge } from "./comments.ts";
import { agreementMetrics, examples, label, MIN_EXAMPLES, pushbackGate, runAgreement } from "./agreement.ts";
import { buildMetrics } from "./metrics.ts";
import { validateMetrics, agreementCard } from "../lib/metrics.js";
import { validateAccount, validateFile } from "./validate.ts";
import type { Run } from "./runner.ts";

function setup(away = "") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"), { recursive: true });
  const yaml = (extra: string) => writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${extra}`);
  yaml(away);
  const db = open(join(mkdtempSync(join(tmpdir(), "factory-")), "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (1, 'merged one', 'merged', 'x'), (2, 'still open', 'ready', 'x')").run();
  let n = 0;
  // A reviewer's comment on a ticket, with the verdict it got.
  const comment = (ticket: number, body: string, verdict: string | null, o: { reason?: string; insisted?: number } = {}) => {
    n++;
    db.query("INSERT INTO comments (ticket, n, pr, gh_id, thread, author, place, body, at, verdict, reason, judged_at, insisted) VALUES (?, ?, 42, ?, ?, 'sam', 'a.ts:1', ?, ?, ?, ?, ?, ?)")
      .run(ticket, n, `g${n}`, `g${n}`, body, `2026-11-20T10:${String(n % 60).padStart(2, "0")}:00Z`, verdict, o.reason ?? null, verdict ? `2026-11-20T11:${String(n % 60).padStart(2, "0")}:00Z` : null, o.insisted ?? 0);
    return n;
  };
  return { db, repo, yaml, comment };
}

// The judge answers by the word in the comment: "fix", "pushback" or "escalate"; anything else is unreadable.
const judgeBy: (calls: string[][]) => Run = (calls) => (argv) => {
  if (argv[0] !== "claude") throw new Error(`unexpected ${argv[0]}`);
  calls.push(argv);
  const v = ["fix", "pushback", "escalate"].find((w) => argv.at(-1)!.includes(`say-${w}`));
  return { code: 0, out: v ? `VERDICT: ${v}\nCLEAR: yes\nWHY: because` : "no idea" };
};

test("the labelled comments: yours wins, then a verdict kept to merge; the judge's own and an insisted one don't count", () => {
  const s = setup();
  const kept = s.comment(1, "kept", "pushback", { reason: "taste" });
  s.comment(1, "auto", "fix", { reason: "auto: claude-haiku-5-5 judged it a clear fix" });
  s.comment(1, "insisted", "fix", { insisted: 1 });
  s.comment(2, "not merged yet", "fix");
  const relabelled = s.comment(2, "labelled", "fix");
  s.comment(1, "never judged", null);
  label(s.db, { ticket: 2, n: relabelled, verdict: "escalate", now: "2026-11-21T09:00:00Z" });
  expect(examples(s.db).map((x) => [x.n, x.yours, x.source])).toEqual([[relabelled, "escalate", "you"], [kept, "pushback", "kept"]]);
  expect(() => label(s.db, { ticket: 2, n: 99, verdict: "fix", now: "x" })).toThrow("#2 has no comment C99");
  expect(() => label(s.db, { ticket: 2, n: relabelled, verdict: "maybe", now: "x" })).toThrow("a verdict is fix, pushback, escalate");
  // The comment's own verdict is untouched.
  expect(s.db.query("SELECT verdict, label FROM comments WHERE n = ?").get(relabelled)).toEqual({ verdict: "fix", label: "escalate" });
});

test("a run re-judges each comment blind to your verdict, and an unreadable answer counts against it", () => {
  const s = setup("review: { judge_model: sonnet }\n");
  s.comment(1, "say-fix the typo", "fix");
  s.comment(1, "say-fix this too", "pushback", { reason: "zq-secret-reason" }); // judge says fix, you pushed back
  s.comment(1, "hmm", "escalate", { reason: "zq-secret-reason" }); // unreadable
  s.comment(1, "say-escalate who gets it", "escalate", { reason: "zq-secret-reason" });
  const calls: string[][] = [];
  const r = runAgreement(s.db, { repo: s.repo, run: judgeBy(calls), now: () => "2026-11-21T03:00:00Z" });
  expect(r).toMatchObject({ model: "claude-sonnet-5-5", examples: 4, agreed: 2, failed: 1, rate: 0.5 });
  expect(calls).toHaveLength(4);
  expect(calls[0].slice(0, 4)).toEqual(["claude", "-p", "--model", "claude-sonnet-5-5"]);
  // The prompt has the comment, never the verdict or its reason.
  for (const c of calls) expect(c[4]).not.toMatch(/zq-secret-reason|pushed back|escalated/);
  const items = s.db.query("SELECT yours, got FROM agreement_items WHERE run = ? ORDER BY n").all(r.id);
  expect(items).toEqual([{ yours: "fix", got: "fix" }, { yours: "pushback", got: "fix" }, { yours: "escalate", got: null }, { yours: "escalate", got: "escalate" }]);
  // No comments, no run.
  const empty = setup();
  expect(() => runAgreement(empty.db, { repo: empty.repo, run: judgeBy([]), now: () => "x" })).toThrow("no labelled review comments yet");
});

test("while away, a pushback needs a measured agreement at the bar, on the judge model in use", () => {
  const s = setup(); // min_agreement unset: 85%
  for (let i = 0; i < MIN_EXAMPLES - 1; i++) s.comment(1, `say-fix ${i}`, "fix");
  const open = s.comment(2, "rename it", null);
  setAway(s.db, true, "2026-11-21T00:00:00Z");
  const pushback = () => judge(s.db, { ticket: 2, n: open, verdict: "pushback", reason: "the name is public", now: "x", repo: s.repo });
  expect(pushback).toThrow("no pushbacks while the person is away (the judge (claude-haiku-5-5) hasn't been checked against the person's verdicts yet");
  const run = () => runAgreement(s.db, { repo: s.repo, run: judgeBy([]), now: () => "2026-11-21T03:00:00Z" });
  run(); // 9 of 9: too few to count
  expect(pushback).toThrow("checked on only 9 past comments; the check needs 10");
  s.comment(1, "say-pushback but you fixed it", "fix");
  run(); // 9 of 10
  expect(pushbackGate(s.db, s.repo)).toMatchObject({ ok: true, min: 0.85 });
  pushback();
  // A stricter bar closes it, and the factory's bar is the one that counts.
  s.yaml("away: { min_agreement: 0.95 }\n");
  expect(pushback).toThrow("matches the person's verdict on 90% of past comments, below away.min_agreement 95%");
  // A new judge model hasn't been checked yet.
  s.yaml("review: { judge_model: sonnet }\n");
  expect(pushback).toThrow("the judge (claude-sonnet-5-5) hasn't been checked");
  // 0 turns the gate off; and back home, it doesn't apply.
  s.yaml("away: { min_agreement: 0 }\n");
  pushback();
  s.yaml("away: { min_agreement: 0.95 }\n");
  setAway(s.db, false, "2026-11-21T04:00:00Z");
  pushback();
});

test("Metrics carries the latest agreement, by your verdict, and the page reads it", () => {
  const s = setup();
  expect(agreementMetrics(s.db, s.repo)).toMatchObject({ rate: null, examples: 0, ok: false });
  expect(agreementCard(buildMetrics(s.db).agreement).value).toBe("–");
  for (let i = 0; i < 8; i++) s.comment(1, `say-fix ${i}`, "fix");
  s.comment(1, "say-fix wrong", "pushback", { reason: "r" });
  s.comment(1, "say-pushback right", "pushback", { reason: "r" });
  runAgreement(s.db, { repo: s.repo, run: judgeBy([]), now: () => "2026-11-21T03:00:00Z" });
  const doc = buildMetrics(s.db, new Date("2026-11-21T05:00:00Z"));
  expect(validateMetrics(doc)).toEqual([]);
  expect(doc.agreement).toMatchObject({ rate: 0.9, examples: 10, agreed: 9, ok: true, model: "claude-haiku-5-5",
    by_verdict: [{ verdict: "fix", examples: 8, agreed: 8 }, { verdict: "pushback", examples: 2, agreed: 1 }] });
  const card = agreementCard(doc.agreement);
  expect(card.value).toBe("90%");
  expect(card.sub).toContain("Pushbacks while away: allowed");
  expect(card.rows).toEqual([["You said fix", "8 of 8"], ["You said push back", "1 of 2"]]);
  expect(validateMetrics({ ...doc, agreement: { rate: "high" } }).length).toBeGreaterThan(0);
});

test("away.min_agreement is a share from 0 to 1, and away: keys are checked in factory.yaml too", () => {
  expect(validateFile("factory.yaml", "name: t\naway: { min_agreement: 0.85, review_rounds: 2 }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: t\naway: { min_agreement: 85 }\n")).toEqual(["away.min_agreement: a share from 0 to 1, like 0.85 (0 turns the agreement gate off)"]);
  expect(validateFile("factory.yaml", "name: t\naway: { min_agrement: 0.85 }\n")[0]).toStartWith("away.min_agrement: unknown key");
  expect(validateAccount("away: { min_agreement: 1.5 }\n")).toEqual(["away.min_agreement: a share from 0 to 1, like 0.85 (0 turns the agreement gate off)"]);
});
