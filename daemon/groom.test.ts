import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { advance, answer, sh, type Run } from "./runner.ts";
import { ask, askMidRun, parseAnswers, pick, questionsComment, readIssueAnswers, startGroomed, startGrooming, startPendingGrooming } from "./groom.ts";
import { recordUsage, transcriptDir } from "./usage.ts";

const now = "2026-11-21T10:00:00Z";
// A fake triager that finishes: its last step is GROOMING.md in the folder it runs in.
const triaged = (argv: string[]) => {
  if (argv.includes("factory.stage=groom") && argv.includes("--cwd")) writeFileSync(join(argv[argv.indexOf("--cwd") + 1], "GROOMING.md"), "groomed\n");
};

function setup(factoryYaml = "name: t\nquality_floor: [\"true\"]\n") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const hc: string[][] = [];
  const gh: string[][] = [];
  let comments: object[] = [];
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return triaged(argv), hc.push(argv), { code: 0, out: `{"address":"t${++n}"}` };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (argv.includes("author")) return { code: 0, out: "pat-po" };
    if (argv.includes("comments")) return { code: 0, out: JSON.stringify({ comments }) };
    return { code: 0, out: "" };
  };
  const add = (id: number, title = "Rate-limit login") =>
    db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, ?, 'feature', ?)").run(id, title, now);
  const ticket = (id = 412) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
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
  // auto mode, like every agent: `factory pick` never waits for approval; questions are asked in the terminal
  expect(argv.slice(argv.indexOf("claude"), argv.indexOf("claude") + 3)).toEqual(["claude", "--permission-mode", "auto"]);
  expect(JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8")).permissions.allow).toContain("Bash(factory:*)");
  expect(brief).toContain("gh issue view 412 --repo acme/api --comments");
  expect(brief).toContain("one of address-review, bugfix, chore, feature");
  expect(brief).toContain("ask the person here, in this session, with your question tool (AskUserQuestion)");
  expect(brief).not.toContain("factory question");
  expect(brief).toContain("Read the issue and the code it touches"); // the triager agent's own prompt
  expect(ticket()).toMatchObject({ state: "grooming", stage: "groom" });
  expect(() => startGrooming(db, { dir, repo, id: 412, run, now })).toThrow("being groomed already");
  pick(db, { repo, id: 412, blueprint: "chore", now });
  expect(ticket().blueprint).toBe("chore");
  expect(() => pick(db, { repo, id: 412, blueprint: "hotfix", now })).toThrow(`"hotfix" isn't a blueprint grooming may pick: address-review, bugfix, chore, feature`);
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

test("an answer stays answered when the groomed ticket can't start yet; a later tick starts it", () => {
  const { db, dir, repo, run, gh, add, ticket } = setup();
  add(412);
  startGrooming(db, { dir, repo, id: 412, run, now });
  ask(db, { id: 412, kind: "engineering", text: "Redis?", now });
  advance(db, { dir, repo, id: 412, run, now });
  const logs: string[] = [];
  const down: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 1, out: "down" } : run(argv, cwd));
  gh.length = 0;
  const r = db.transaction(() => answer(db, { dir, repo, id: 412, text: "yes", run: down, now }))();
  expect(r).toMatchObject({ groomed: true, started: false });
  expect(ticket()).toMatchObject({ state: "queued", worktree: null });
  expect(gh.filter((a) => a[2] === "comment")).toHaveLength(1);
  expect(startGroomed(db, { dir, repo, run: down, now, log: (s) => logs.push(s) })).toEqual([]);
  expect(logs[0]).toStartWith("factory: #412 didn't start: hc run failed");
  expect(startGroomed(db, { dir, repo, run, now })).toEqual([412]);
  expect(ticket().state).toBe("running");
});

test("an agent's mid-run product question parks the ticket, goes on the issue, and the answer restarts the stage from GATES.md", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nquality_floor: ['true']\n");
  sh(["git", "-C", repo, "add", "."]); sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Wire it', 'feature', '2026-11-21T10:00:00Z')").run();
  const calls: string[][] = [];
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: `{"address":"t${++n}"}` };
    if (argv[0] === "gh") { calls.push(argv); return { code: 0, out: argv[2] === "view" ? "dana" : "" }; }
    return sh(argv, cwd);
  };
  const { startTicket } = require("./runner.ts");
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  const q = askMidRun(db, { repo, id: 7, kind: "product", text: "Per user or per IP?", run, now: "2026-11-21T10:05:00Z" });
  expect(q).toEqual({ n: 1, terminals: ["t1"] });
  expect(db.query("SELECT state, needs_text FROM tickets WHERE id = 7").get()).toEqual({ state: "parked", needs_text: "Q1 from the spec stage (product, for @dana): Per user or per IP?" });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get()).toEqual({ n: 0 });
  const comment = calls.find((c) => c[2] === "comment")!;
  expect(comment.at(-1)).toContain("@dana");
  expect(comment.at(-1)).toContain("A1:");
  expect(() => askMidRun(db, { repo, id: 7, kind: "product", text: "again?", run, now: "2026-11-21T10:06:00Z" })).toThrow("#7 is parked");
  const r = answer(db, { dir, repo, id: 7, text: "Per user", run, now: "2026-11-21T10:10:00Z" });
  expect(r).toMatchObject({ stage: "spec" });
  const gates = readFileSync(join(dir, "tickets/7/GATES.md"), "utf8");
  expect(gates).toContain("Q1 from the spec stage (product, for @dana): Per user or per IP?");
  expect(gates).toContain("**Your answer:** Per user");
});


test("triage that stops before GROOMING.md (killed, crashed) parks the ticket instead of starting it, and isn't retried on its own", () => {
  const { db, dir, repo, add, ticket } = setup();
  add(412);
  const hc: string[][] = [];
  const quiet: Run = (argv, cwd) => (argv[0] === "hc" ? (hc.push(argv), { code: 0, out: '{"address":"t1"}' }) : sh(argv, cwd)); // never writes GROOMING.md
  startGrooming(db, { dir, repo, id: 412, run: quiet, now });
  advance(db, { dir, repo, id: 412, run: quiet, now }); // its terminal exited
  expect(ticket().state).toBe("grooming");
  expect(ticket().needs_kind).toBe("parked");
  expect(ticket().needs_text).toContain("factory groom 412");
  expect(startPendingGrooming(db, { dir, repo, run: quiet, now })).toEqual([]); // no loop
  expect(startGrooming(db, { dir, repo, id: 412, run: quiet, now })).toBe("t1"); // `factory groom` reruns it
  expect(ticket().needs_kind).toBe(null);
});

test("grooming again withdraws the questions nobody answered and keeps the old GROOMING.md aside", () => {
  const { db, dir, repo, run, add, ticket } = setup();
  add(412);
  startGrooming(db, { dir, repo, id: 412, run, now });
  ask(db, { id: 412, kind: "product", text: "Which plan?", now });
  ask(db, { id: 412, kind: "engineering", text: "Redis or memory?", now });
  db.query("UPDATE questions SET answer = 'memory', answered_by = 'you', answered_at = ? WHERE ticket = 412 AND n = 2").run(now);
  advance(db, { dir, repo, id: 412, run, now }); // the triager's terminal is gone: waits on Q1
  expect(ticket()).toMatchObject({ state: "grooming", needs_kind: "question" });
  writeFileSync(join(dir, "tickets/412/GROOMING.md"), "first look\n");
  // The fake triager writes a new GROOMING.md only when it is told to (triaged); this one dies early.
  const dies: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: '{"address":"t9"}' } : run(argv, cwd));
  startGrooming(db, { dir, repo, id: 412, run: dies, now });
  expect(ticket()).toMatchObject({ state: "grooming", needs_kind: null });
  expect(db.query("SELECT n, answer FROM questions WHERE ticket = 412").all()).toEqual([{ n: 2, answer: "memory" }]);
  expect(readFileSync(join(dir, "tickets/412/GROOMING.before.md"), "utf8")).toBe("first look\n");
  // Without a fresh GROOMING.md, the second triager counts as stopped early, not finished.
  expect(advance(db, { dir, repo, id: 412, run: dies, now })).toMatchObject({ stage: "groom" });
  expect(ticket().needs_text).toContain("Triage stopped before it finished");
});
