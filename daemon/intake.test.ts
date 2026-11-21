import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { LOCAL_IDS, newTicket, parseSource, pollQueue } from "./intake.ts";
import type { Run } from "./runner.ts";

const now = "2026-11-21T10:00:00Z";
function setup(issues: Record<number, { title: string; state?: string }> = {}) {
  const db = open(join(mkdtempSync(join(tmpdir(), "intake-")), "factory.db"));
  const calls: string[][] = [];
  const run: Run = (argv) => {
    calls.push(argv);
    const i = issues[Number(argv[3])];
    return i ? { code: 0, out: JSON.stringify({ number: Number(argv[3]), title: i.title, state: i.state ?? "OPEN" }) } : { code: 1, out: "GraphQL: Could not resolve to an issue" };
  };
  const add = (text: string, repo = "acme/api") => newTicket(db, { text, repo, blueprint: "feature", run, now });
  return { db, calls, add };
}

test("n reads an issue link, #412 or 412; anything else is a goal", () => {
  expect(parseSource("https://github.com/acme/api/issues/412")).toEqual({ issue: 412, repo: "acme/api" });
  expect(parseSource(" #412 ")).toEqual({ issue: 412, repo: null });
  expect(parseSource("412")).toEqual({ issue: 412, repo: null });
  expect(parseSource("Rate-limit   login\tper user")).toEqual({ goal: "Rate-limit login per user" });
  expect(parseSource("fix #412 properly")).toEqual({ goal: "fix #412 properly" });
});

test("an issue becomes a queued ticket with its number and title, read through gh", () => {
  const { db, calls, add } = setup({ 412: { title: "Rate-limit login" }, 9: { title: "Old", state: "CLOSED" } });
  expect(add("#412")).toEqual({ id: 412, title: "Rate-limit login" });
  expect(calls[0]).toEqual(["gh", "issue", "view", "412", "--repo", "acme/api", "--json", "number,title,state"]);
  expect(db.query("SELECT state, blueprint FROM tickets WHERE id = 412").get()).toEqual({ state: "queued", blueprint: "feature" });
  expect(() => add("412")).toThrow("#412 is already a ticket");
  expect(() => add("#9")).toThrow("issue #9 is closed");
  expect(() => add("#77")).toThrow("gh issue view failed: GraphQL");
  expect(() => add("https://github.com/other/repo/issues/412")).toThrow("that issue is in other/repo; this factory works on acme/api");
  expect(() => add("#412", "unknown")).toThrow("this factory has no repo");
});

test("goals get local ids from 10000, clear of issue numbers", () => {
  const { add, calls } = setup();
  expect(add("Rate-limit login")).toEqual({ id: LOCAL_IDS, title: "Rate-limit login" });
  expect(add("Export API").id).toBe(LOCAL_IDS + 1);
  expect(calls).toEqual([]);
  expect(() => add("   ")).toThrow("type an issue link");
});

test("the queue adds this repo's Ready issues assigned to you as grooming tickets, once", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "intake-")), "factory.db"));
  const calls: string[][] = [];
  const item = (number: number, status: string, assignees: string[], repository = "acme/api", type = "Issue") =>
    ({ status, assignees, content: { type, number, title: `Issue ${number}`, repository } });
  const run: Run = (argv) => {
    calls.push(argv);
    if (argv[1] === "api") return { code: 0, out: "pat\n" };
    if (argv[2] === "list") return { code: 0, out: JSON.stringify({ projects: [{ number: 3, title: "Engineering" }] }) };
    return { code: 0, out: JSON.stringify({ items: [
      item(412, "Ready", ["pat"]), item(413, "Todo", ["pat"]), item(414, "Ready", ["sam"]),
      item(415, "Ready", ["Pat"], "other/repo"), item(416, "ready", ["Pat", "sam"]), item(417, "Ready", ["pat"], "acme/api", "PullRequest"),
    ] }) };
  };
  const queue = { github_project: "acme/Engineering", column: "Ready", assignee: "me" };
  expect(pollQueue(db, { queue, repo: "acme/api", run, now })).toEqual([412, 416]);
  expect(calls.map((c) => c.slice(0, 4))).toEqual([["gh", "project", "list", "--owner"], ["gh", "api", "user", "-q"], ["gh", "project", "item-list", "3"]]);
  expect(db.query("SELECT id, state, title FROM tickets ORDER BY id").all()).toEqual([
    { id: 412, state: "grooming", title: "Issue 412" }, { id: 416, state: "grooming", title: "Issue 416" },
  ]);
  calls.length = 0;
  expect(pollQueue(db, { queue, repo: "acme/api", run, now })).toEqual([]); // known already; names are cached
  expect(calls.map((c) => c[2])).toEqual(["item-list"]);
  expect(pollQueue(db, { queue: undefined, repo: "acme/api", run, now })).toEqual([]);
  expect(() => pollQueue(db, { queue: { github_project: "Engineering" }, repo: "acme/api", run, now })).toThrow("isn't owner/<number or title>");
});
