import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, answer, resume, sh, startTicket, type Run } from "./runner.ts";
import { startGrooming } from "./groom.ts";
import { decideSplit, followSplits, proposePart } from "./split.ts";
import { validateFile } from "./validate.ts";

const now = "2026-11-21T10:00:00Z";

// gh is stubbed: issue create hands out numbers from 500, sub_issues lists what it was told.
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
  const gh: string[][] = [];
  const linked: number[] = [];
  let issue = 500, term = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return { code: 0, out: `{"address":"t${++term}"}` };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (argv[1] === "issue" && argv[2] === "create") return { code: 0, out: `https://github.com/acme/api/issues/${issue++}` };
    if (argv[1] === "api" && argv.includes("--jq")) return { code: 0, out: `9${argv[2].split("/").at(-1)}` };
    if (argv[1] === "api" && argv[2] === "-X") return linked.push(Number(argv.at(-1)!.split("=")[1])), { code: 0, out: "{}" };
    if (argv[1] === "api") return { code: 0, out: "[]" };
    return { code: 0, out: "" };
  };
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  const add = (id: number, blueprint = "chore") => db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, 'Rate-limit everything', ?, ?)").run(id, blueprint, now);
  return { db, dir, repo, run, gh, linked, ticket, add };
}

test("a stage's split waits for you; approved, each part is a sub-issue that waits on the one before, and the parent closes after the last", () => {
  const s = setup();
  s.add(412);
  startTicket(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now });
  const wt = s.ticket(412).worktree;
  writeFileSync(join(wt, "login.ts"), "limit()\n"); // work so far, not committed yet
  proposePart(s.db, { id: 412, title: "Rate-limit login", scope: "the /login route", now });
  proposePart(s.db, { id: 412, title: "Rate-limit signup", keepsWork: true, now });
  expect(advance(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now })).toMatchObject({ split: "asked" });
  expect(s.ticket(412)).toMatchObject({ state: "paused", needs_kind: "question" });
  expect(s.ticket(412).needs_text).toContain("1. Rate-limit login (the /login route); 2. Rate-limit signup");
  expect(s.gh.length).toBe(0); // nothing on GitHub until you say so
  expect(() => resume(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now })).toThrow("split proposed");

  expect(answer(s.db, { dir: s.dir, repo: s.repo, id: 412, text: "approve", run: s.run, now })).toMatchObject({ children: [500, 501] });
  expect(s.linked).toEqual([9500, 9501]); // linked as sub-issues of #412
  expect(s.gh.find((a) => a[2] === "create" && a.includes("Rate-limit signup"))!.join(" ")).toContain("Part 2 of 2 of #412");
  expect(s.ticket(412)).toMatchObject({ state: "paused", needs_kind: null, detail: "split into #500, #501; closes when they merge" });
  expect(s.ticket(500)).toMatchObject({ state: "running", parent: 412 }); // groomed by the split: it starts
  expect(s.ticket(501)).toMatchObject({ state: "blocked", blocked_by: 500, parent: 412 });
  expect(readFileSync(join(s.dir, "tickets/501/GROOMING.md"), "utf8")).toContain("Part 2 of 2 of #412");
  // The part that keeps the work does not: part 1 starts clean from main.
  expect(existsSync(join(s.ticket(500).worktree, "login.ts"))).toBe(false);

  s.db.query("UPDATE tickets SET state = 'merged' WHERE id = 500").run();
  followSplits(s.db, { dir: s.dir, repo: s.repo, run: s.run, now });
  expect(s.ticket(501).state).toBe("queued");
  expect(s.ticket(412).state).toBe("paused"); // one part left
  startTicket(s.db, { dir: s.dir, repo: s.repo, id: 501, run: s.run, now });
  // Part 2 starts from the parent's branch, with its work committed there.
  expect(readFileSync(join(s.ticket(501).worktree, "login.ts"), "utf8")).toBe("limit()\n");

  s.db.query("UPDATE tickets SET state = 'merged' WHERE id = 501").run();
  followSplits(s.db, { dir: s.dir, repo: s.repo, run: s.run, now });
  expect(s.ticket(412).state).toBe("closed");
  expect(existsSync(wt)).toBe(false); // its worktree went; the branch stays
  expect(s.gh.at(-1)!.slice(0, 4)).toEqual(["gh", "issue", "close", "412"]);
});

test("rejected, the ticket goes on as one from the stage that proposed it", () => {
  const s = setup();
  s.add(412);
  startTicket(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now });
  proposePart(s.db, { id: 412, title: "A", now });
  advance(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now });
  expect(decideSplit(s.db, { dir: s.dir, repo: s.repo, id: 412, approve: false, run: s.run, now })).toMatchObject({ rejected: true, stage: "pr" });
  expect(s.ticket(412)).toMatchObject({ state: "running", stage: "pr", needs_kind: null }); // implement → verify passed → pr's writer
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets WHERE parent = 412").get()).toEqual({ n: 0 });
  expect(s.gh.length).toBe(0);
});

test("with tickets.split: auto, triage's split of a goal makes local parts at once", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\ntickets: { split: auto }\nmax_running: 0\n");
  s.add(10000);
  startGrooming(s.db, { dir: s.dir, repo: s.repo, id: 10000, run: s.run, now });
  proposePart(s.db, { id: 10000, title: "First", now });
  proposePart(s.db, { id: 10000, title: "Second", now });
  expect(advance(s.db, { dir: s.dir, repo: s.repo, id: 10000, run: s.run, now })).toMatchObject({ split: "created", children: [10001, 10002] });
  expect(s.gh.length).toBe(0); // a goal has no issue
  expect(s.ticket(10000)).toMatchObject({ state: "paused", groomed_at: null });
  expect(s.ticket(10001)).toMatchObject({ state: "queued", groomed_at: now, blueprint: "chore" }); // max_running 0: waits its turn
  expect(() => proposePart(s.db, { id: 10000, title: "Third", now })).toThrow("groomed or running");
});

test("tickets: is a source, or a map with split: human|auto", () => {
  expect(validateFile("factory.yaml", "name: t\ntickets: github\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: t\ntickets: { source: github, split: auto }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: t\ntickets: { split: sometimes }\n")).toEqual(['tickets.split: "sometimes" is not one of human, auto']);
  expect(validateFile("factory.yaml", "name: t\ntickets: { splits: auto }\n")[0]).toContain("tickets.splits: unknown key");
});
