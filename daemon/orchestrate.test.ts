import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, sh, startTicket, type Run } from "./runner.ts";
import { parseChoice } from "./orchestrate.ts";

const now = "2026-11-21T10:00:00Z";

// A feature ticket at its spec stage, whose next is [plan, implement]; `answer` is what the orchestrator prints.
function setup(answer: { code: number; out: string }) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: [\"true\"]\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const asked: string[][] = [];
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: `{"address":"t${++n}"}` };
    if (argv[0] === "claude") return asked.push(argv), answer;
    return sh(argv, cwd);
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Fix the typo', 'feature', ?)").run(now);
  startTicket(db, { dir, repo, id: 7, run, now });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/INTENT.md"), "# Intent\n\nFix one typo in the README.\n");
  const step = () => advance(db, { dir, repo, id: 7, run, now });
  const decision = () => db.query("SELECT who, what, why FROM decisions WHERE what LIKE 'chose %'").get() as any;
  return { db, step, asked, decision };
}

test("the orchestrator skips plan when it says so, and the choice is in the decision log", () => {
  const s = setup({ code: 0, out: "NEXT: implement\nWHY: one obvious step, nothing to plan" });
  expect(s.step()).toMatchObject({ stage: "implement" });
  expect(s.asked).toHaveLength(1);
  const [cmd, , , model, text] = s.asked[0];
  expect([cmd, model]).toEqual(["claude", "claude-sonnet-5-5"]); // foreman.md's model
  expect(text).toContain("Fix one typo in the README.");
  expect(text).toContain("- plan: the planner agent, writes SLICES.md");
  expect(s.decision()).toEqual({ who: "foreman", what: "chose implement after spec", why: "one obvious step, nothing to plan (of plan, implement)" });
  // A stage with one next asks nobody.
  s.step();
  expect(s.asked).toHaveLength(1);
});

test("an answer naming no option, or a failed call, takes the first next", () => {
  const vague = setup({ code: 0, out: "Either plan or implement would work." });
  expect(vague.step()).toMatchObject({ stage: "plan" });
  expect(vague.decision()).toMatchObject({ who: "foreman", what: "chose plan after spec" });
  expect(vague.decision().why).toContain("named no option");
  const down = setup({ code: 1, out: "not logged in" });
  expect(down.step()).toMatchObject({ stage: "plan" });
  expect(down.decision().why).toContain("the call failed (not logged in)");
});

test("the choice is read from its NEXT line, through markdown, and only if it names one option", () => {
  const opts = ["plan", "implement"];
  expect(parseChoice("**NEXT:** `implement`\n**WHY:** small", opts)).toEqual({ to: "implement", why: "small" });
  expect(parseChoice("next: Plan", opts)).toEqual({ to: "plan", why: "" });
  expect(parseChoice("NEXT: plan or implement", opts)).toBeNull();
  expect(parseChoice("NEXT: review", opts)).toBeNull();
  expect(parseChoice("I'd go to implement", opts)).toBeNull();
});
