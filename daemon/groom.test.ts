import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta } from "./db.ts";
import { advance, answer, sh, type Run } from "./runner.ts";
import { ask, parseAnswers, pick, questionsComment, readIssueAnswers, startGroomed, startGrooming, startPendingGrooming } from "./groom.ts";
import { recordUsage, transcriptDir } from "./usage.ts";

const now = "2026-11-21T10:00:00Z";
function setup(factoryYaml = "name: t\nquality_floor: [\"true\"]\n") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setMeta(db, "repo_path", repo);
  setMeta(db, "repo", "acme/api");
  const hc: string[][] = [];
  const gh: string[][] = [];
  let comments: object[] = [];
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return hc.push(argv), { code: 0, out: `{"address":"t${++n}"}` };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (argv.includes("author")) return { code: 0, out: "pat-po" };
    if (argv.includes("comments")) return { code: 0, out: JSON.stringify({ comments }) };
    return { code: 0, out: "" };
  };
  const add = (id: number, title = "Rate-limit login") =>
    db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, ?, 'feature', ?)").run(id, title, now);
  const ticket = (id = 412) => db.query("SELECT * FROM tickets WHERE id = ?").get(id) as any;
  const setComments = (c: object[]) => { comments = c; };
  return { db, dir, repo, run, hc, gh, add, ticket, setComments };
}

test("triage runs in the ticket's folder with a brief naming the issue, the blueprints and the commands", () => {
  const { db, dir, repo, run, hc, add, ticket } = setup();
  add(412);
  expect(startGrooming(db, { dir, repo, id: 412, run, now })).toBe("t1");
  const argv = hc[0];
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(join(dir, "tickets/412"));
  const brief = argv.at(-1)!;
  expect(brief).toContain("gh issue view 412 --repo acme/api --comments");
  expect(brief).toContain("one of chore, feature");
  expect(brief).toContain("factory question 412 product <question>");
  expect(brief).toContain("Read the issue and the code it touches"); // the triager agent's own prompt
  expect(ticket()).toMatchObject({ state: "grooming", stage: "groom" });
  expect(() => startGrooming(db, { dir, repo, id: 412, run, now })).toThrow("being groomed already");
  pick(db, { repo, id: 412, blueprint: "chore", now });
  expect(ticket().blueprint).toBe("chore");
  expect(() => pick(db, { repo, id: 412, blueprint: "bugfix", now })).toThrow(`"bugfix" isn't a blueprint grooming may pick: chore, feature`);
  expect(db.query("SELECT who, what FROM decisions").get()).toEqual({ who: "triager", what: "picked the chore blueprint" });
});

test("questions go to the issue (product ones to the PO); answers in Herdr and on the issue both count, then it starts", () => {
  const { db, dir, repo, run, gh, add, ticket, setComments } = setup();
  add(412);
  startGrooming(db, { dir, repo, id: 412, run, now });
  expect(ask(db, { id: 412, kind: "product", text: "Which plans get the limit?", now })).toBe(1);
  expect(ask(db, { id: 412, kind: "engineering", text: "Redis or in-memory?", now })).toBe(2);
  expect(ask(db, { id: 412, kind: "engineering", text: "Per IP too?", now })).toBe(3);
  expect(() => ask(db, { id: 412, kind: "other", text: "?", now })).toThrow("product or engineering");
  expect(advance(db, { dir, repo, id: 412, run, now })).toEqual({ questions: 3, stage: "groom" });
  expect(ticket()).toMatchObject({ state: "grooming", needs_kind: "question", needs_text: "3 questions · Q1: Which plans get the limit? (product: waiting on @pat-po)" });
  const comment = gh.find((a) => a[2] === "comment")!;
  expect(comment.slice(0, 5)).toEqual(["gh", "issue", "comment", "412", "--repo"]);
  expect(comment.at(-1)).toContain("**Q1** (product, @pat-po): Which plans get the limit?");
  expect(comment.at(-1)).toContain("**Q2** (engineering): Redis or in-memory?");

  // In Herdr: plain text answers the first open question, and is posted on the issue.
  gh.length = 0;
  expect(answer(db, { dir, repo, id: 412, text: "Pro and Team", run, now })).toMatchObject({ answered: [1], left: 2 });
  expect(gh[0].at(-1)).toContain("A1: Pro and Team");
  expect(ticket().needs_text).toBe("2 questions · Q2: Redis or in-memory?");

  // On the issue: numbered answers newer than the questions, not the factory's own comments.
  setComments([
    { author: { login: "old" }, body: "A2: ignore me", createdAt: "2026-11-20T00:00:00Z" },
    { author: { login: "bot" }, body: questionsComment([], null), createdAt: "2026-11-21T10:01:00Z" },
    { author: { login: "dev" }, body: "Thinking about it.", createdAt: "2026-11-21T10:02:00Z" },
    { author: { login: "dev" }, body: "A2: Redis, it's already deployed\nfor sessions.\nA3: no", createdAt: "2026-11-21T10:03:00Z" },
  ]);
  readIssueAnswers(db, { dir, repo, run, now: "2026-11-21T10:05:00Z" });
  expect(ticket()).toMatchObject({ state: "running", stage: "spec", needs_kind: null, blueprint: "feature" });
  const answers = db.query("SELECT n, answer, answered_by FROM questions ORDER BY n").all();
  expect(answers).toEqual([
    { n: 1, answer: "Pro and Team", answered_by: "you" },
    { n: 2, answer: "Redis, it's already deployed\nfor sessions.", answered_by: "@dev" },
    { n: 3, answer: "no", answered_by: "@dev" },
  ]);
  const gates = readFileSync(join(dir, "tickets/412/GATES.md"), "utf8");
  expect(gates).toContain("## Questions");
  expect(gates).toContain("## Q2 · answered by @dev on the issue");
  expect(gates).toContain("**Answer:** Redis, it's already deployed\nfor sessions.");
});

test("a ticket with no questions is groomed at once, and waits for room under max_running", () => {
  const { db, dir, repo, run, add, ticket } = setup("name: t\nmax_running: 1\nquality_floor: [\"true\"]\n");
  add(412); add(10000, "Export API");
  startGrooming(db, { dir, repo, id: 412, run, now });
  expect(advance(db, { dir, repo, id: 412, run, now })).toEqual({ groomed: true, started: true });
  expect(ticket()).toMatchObject({ state: "running", stage: "spec" });
  startGrooming(db, { dir, repo, id: 10000, run, now });
  expect(advance(db, { dir, repo, id: 10000, run, now })).toEqual({ groomed: true, started: false });
  expect(ticket(10000)).toMatchObject({ state: "queued", groomed_at: now });
  expect(startGroomed(db, { dir, repo, run, now })).toEqual([]);
  db.query("UPDATE tickets SET state = 'ready' WHERE id = 412").run();
  expect(startGroomed(db, { dir, repo, run, now })).toEqual([10000]);
  expect(ticket(10000).state).toBe("running");
});

test("a goal has no issue: its brief says so, and its questions stay in Herdr", () => {
  const { db, dir, repo, run, hc, gh, add } = setup();
  add(10000, "Export API");
  startGrooming(db, { dir, repo, id: 10000, run, now });
  expect(hc[0].at(-1)).toContain("It has no issue");
  ask(db, { id: 10000, kind: "product", text: "CSV or JSON?", now });
  advance(db, { dir, repo, id: 10000, run, now });
  expect(gh).toEqual([]);
  expect(answer(db, { dir, repo, id: 10000, text: "A1: CSV", run, now })).toMatchObject({ answered: [1], left: 0, groomed: true });
  expect(gh).toEqual([]);
  expect(() => answer(db, { dir, repo, id: 10000, text: "x", run, now })).toThrow("#10000 is running");
});

test("answers parse from A1: lines, or plain text", () => {
  expect(parseAnswers("A1: yes\na2) no, not\nthat\nA3. maybe")).toEqual([{ n: 1, text: "yes" }, { n: 2, text: "no, not\nthat" }, { n: 3, text: "maybe" }]);
  expect(parseAnswers("  just this  ")).toEqual([{ n: null, text: "just this" }]);
  expect(parseAnswers(" ")).toEqual([]);
});

test("triage's tokens count for its ticket, from transcripts in the ticket's folder", () => {
  const { db, dir, repo, run, add, ticket } = setup();
  add(412);
  startGrooming(db, { dir, repo, id: 412, run, now });
  const t = transcriptDir(join(dir, "tickets/412"));
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-11-21T10:01:00Z", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: 20 } } }));
  recordUsage(db);
  expect(ticket()).toMatchObject({ tokens_in: 100, tokens_out: 20 });
});

test("tickets from the queue wait for triage, at most max_running triage agents at once", () => {
  const { db, dir, repo, run, hc, ticket } = setup("name: t\nmax_running: 2\nquality_floor: [\"true\"]\n");
  for (const id of [412, 413, 414]) db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (?, 'x', 'grooming', ?)").run(id, now);
  expect(startPendingGrooming(db, { dir, repo, run, now })).toEqual([412, 413]);
  expect(startPendingGrooming(db, { dir, repo, run, now })).toEqual([]);
  ask(db, { id: 412, kind: "engineering", text: "Which store?", now });
  advance(db, { dir, repo, id: 412, run, now }); // 412 waits on its question: a triage slot frees
  expect(startPendingGrooming(db, { dir, repo, run, now })).toEqual([414]);
  expect(hc.length).toBe(3);
  expect(ticket(412).needs_kind).toBe("question");
});
