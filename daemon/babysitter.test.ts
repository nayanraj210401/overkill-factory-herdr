// The babysitter agent (babysitter.md): the judge's words, model and context come from it,
// the answer format and its parsing stay the daemon's, and the agreement benchmark
// measures the same judge. claude is stubbed.
import { afterEach, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import type { Run } from "./runner.ts";
import { askJudge, babysitter, judgeModel, prejudge } from "./prejudge.ts";
import { pushbackGate, runAgreement } from "./agreement.ts";
import { storeComments } from "./comments.ts";
import { openRound, writeBrief } from "./round.ts";
import { validateFile } from "./validate.ts";

// Each test gets its own FACTORY_HOME; put the preload's back so other files never see one with agents in it.
const HOME0 = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = HOME0; });
const NOW = "2026-11-22T12:00:00Z";
const OWN = `---
role: babysit
model: opus
context: [comment]
---
ZQ-INTRO you watch PRs.

## Your territory

ZQ-TERRITORY not for the judge.

## Judging a comment

ZQ-JUDGE weigh it carefully.

## Fix rounds

ZQ-ROUND fix the smallest thing.
`;

// The babysitter is a factory agent: ~/.factory/agents/babysitter.md (here a FACTORY_HOME
// per test), else the shipped one.
const ownFile = () => join(process.env.FACTORY_HOME!, "agents/babysitter.md");

function setup(yaml = "", own: string | null = null) {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(process.env.FACTORY_HOME, "agents"));
  if (own) writeFileSync(ownFile(), own);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${yaml}`);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (7, 'ZQ-TICKET title', 'merged', 'feature', ?)").run(NOW);
  const calls: string[][] = [];
  const say = { out: (_: string) => "VERDICT: fix\nCLEAR: no\nWHY: right" };
  const run: Run = (argv) => {
    if (argv[0] !== "claude") return { code: 1, out: `${argv[0]} is stubbed` };
    calls.push(argv);
    return { code: 0, out: say.out(argv.at(-1)!) };
  };
  const add = (body: string, verdict: string | null = null) => {
    const [row] = storeComments(db, { ticket: 7, pr: 1, limit: 2, repo: "acme/api", round: () => openRound(db, 7, NOW),
      comments: [{ ghId: `i${body}`, thread: `i${body}`, author: "sam", body, at: NOW, place: "src/a.ts:3", url: null, hunk: "@@ -1 +1 @@\n+ZQ-HUNK line" }] });
    if (verdict) db.query("UPDATE comments SET verdict = ?, judged_at = ? WHERE n = ?").run(verdict, NOW, row.n);
    return row;
  };
  return { db, dir, repo, calls, say, run, add };
}

test("the judge takes its words, model and context from ~/.factory/agents/babysitter.md; the format stays the daemon's", () => {
  const s = setup("", OWN);
  const row = s.add("Rename this variable.");
  prejudge(s.db, { repo: s.repo, ticket: 7, rows: [row], run: s.run, now: NOW });
  const [argv] = s.calls;
  expect(argv.slice(0, 4)).toEqual(["claude", "-p", "--model", "claude-opus-5-5"]);
  const prompt = argv[4];
  expect(prompt).toContain("ZQ-INTRO you watch PRs.");
  expect(prompt).toContain("ZQ-JUDGE weigh it carefully.");
  expect(prompt).not.toContain("ZQ-TERRITORY");
  expect(prompt).not.toContain("ZQ-ROUND");
  expect(prompt).toContain("VERDICT: fix | pushback | escalate\nCLEAR: yes | no\nWHY: one short sentence");
  expect(prompt).toContain("Rename this variable.");
  expect(prompt).not.toContain("ZQ-HUNK"); // context: [comment], no lines
  expect(prompt).not.toContain("ZQ-TICKET");
  expect(s.db.query("SELECT suggested FROM comments WHERE n = ?").get(row.n)).toEqual({ suggested: "fix" });
  // A repo's own copy is never read: the babysitter is one for every repo.
  mkdirSync(join(s.repo, ".factory/agents"));
  writeFileSync(join(s.repo, ".factory/agents/babysitter.md"), OWN.replace("ZQ-JUDGE", "ZQ-REPO-COPY"));
  expect(babysitter(s.repo).judging).toContain("ZQ-JUDGE");
  // review.judge_model in factory.yaml still wins over the agent's model.
  writeFileSync(join(s.repo, ".factory/factory.yaml"), "name: t\nreview: { judge_model: sonnet }\n");
  expect(judgeModel(s.repo)).toBe("claude-sonnet-5-5");
  expect(validateFile("agents/babysitter.md", OWN)).toEqual([]);
});

test("without its own babysitter.md the factory uses the shipped one: haiku, the comment and its lines", () => {
  const s = setup();
  const b = babysitter(s.repo);
  expect(b.model).toBe("claude-haiku-5-5");
  expect(b.context).toEqual(["comment", "lines"]);
  const row = s.add("Use the user id.");
  prejudge(s.db, { repo: s.repo, ticket: 7, rows: [row], run: s.run, now: NOW });
  expect(s.calls[0][3]).toBe("claude-haiku-5-5");
  expect(s.calls[0][4]).toContain("is it correct, is it required");
  expect(s.calls[0][4]).toContain("+ZQ-HUNK line");
  expect(s.calls[0][4]).not.toContain("What you never do");
  expect(validateFile("agents/babysitter.md", readFileSync(join(import.meta.dir, "../agents/babysitter.md"), "utf8"))).toEqual([]);
  expect(validateFile("agents/learner.md", readFileSync(join(import.meta.dir, "../agents/learner.md"), "utf8"))).toEqual([]);
});

test("an answer in the agent's own format is still unreadable: no suggestion, and the benchmark counts it against the judge", () => {
  const s = setup("", OWN.replace("ZQ-JUDGE weigh it carefully.", "Answer in JSON: {\"verdict\": ...}"));
  s.say.out = () => '{"verdict": "fix", "clear": true}';
  const row = s.add("Rename this.", "fix");
  prejudge(s.db, { repo: s.repo, ticket: 7, rows: [row], run: s.run, now: NOW });
  expect(s.db.query("SELECT suggested FROM comments WHERE n = ?").get(row.n)).toEqual({ suggested: null });
  expect(askJudge(s.run, "m", row, babysitter(s.repo))).toEqual({ p: null, why: "unreadable answer" });
  s.say.out = () => "VERDICT: fix or pushback\nCLEAR: yes\nWHY: both";
  expect(askJudge(s.run, "m", row, babysitter(s.repo)).p).toBeNull();
  s.say.out = () => '{"verdict": "fix"}';
  const r = runAgreement(s.db, { repo: s.repo, run: s.run, now: () => NOW });
  expect(r).toMatchObject({ examples: 1, agreed: 0, failed: 1 });
});

test("the agreement benchmark measures the judge in use: a changed babysitter.md closes the gate until it is checked again", () => {
  const s = setup("away: { min_agreement: 0.5 }\n", OWN);
  for (let i = 0; i < 10; i++) s.add(`Comment ${i}.`, "fix");
  const r = runAgreement(s.db, { repo: s.repo, run: s.run, now: () => NOW });
  expect(r).toMatchObject({ model: "claude-opus-5-5", examples: 10, agreed: 10 });
  expect(r.prompt).toMatch(/^[0-9a-f]{12}$/);
  // The benchmark sent the same prompt pre-judging does.
  expect(s.calls[0][4]).toContain("ZQ-JUDGE weigh it carefully.");
  expect(pushbackGate(s.db, s.repo).ok).toBe(true);
  writeFileSync(ownFile(), OWN.replace("weigh it carefully", "be lenient"));
  const gate = pushbackGate(s.db, s.repo);
  expect(gate.ok).toBe(false);
  expect(gate.why).toContain("with babysitter.md as it is now");
  runAgreement(s.db, { repo: s.repo, run: s.run, now: () => NOW });
  expect(pushbackGate(s.db, s.repo).ok).toBe(true);
  // A change outside the judge's part (its territory, its fix rounds) is the same judge.
  writeFileSync(ownFile(), OWN.replace("weigh it carefully", "be lenient").replace("ZQ-ROUND fix", "ZQ-ROUND mend"));
  expect(pushbackGate(s.db, s.repo).ok).toBe(true);
});

test("the fix brief carries babysitter.md's fix-round guidance, and the daemon's verdict command", () => {
  const s = setup("", OWN);
  mkdirSync(join(s.dir, "tickets/7"), { recursive: true });
  s.add("Rename this.", "fix");
  writeBrief(s.db, { dir: s.dir, ticket: 7, round: openRound(s.db, 7, NOW), repo: s.repo });
  const brief = readFileSync(join(s.dir, "tickets/7/REVIEW-ROUND-1.md"), "utf8");
  expect(brief).toContain("ZQ-ROUND fix the smallest thing.");
  expect(brief).not.toContain("## Fix rounds");
  expect(brief).toContain("factory comment 7 C<n> fix|pushback|escalate <reason>");
  expect(brief).toContain("> Rename this.");
});
