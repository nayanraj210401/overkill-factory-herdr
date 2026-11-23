import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { ask, askerOf, briefNotes, deliveredInBrief, deliverToGlobal, deliverToRepoAgents, doneAsk, mayAsk, notesForBrief, openAsks, takeNotes } from "./ask.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { main, paths } from "./cli.ts";
import { withFactory } from "./herdr.ts";
import type { Run } from "./runner.ts";

const now = "2026-11-23T10:00:00Z";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ask-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: mkdtempSync(join(tmpdir(), "ask-repo-")), lead: true });
  const sends: string[][] = [];
  let busy = false;
  const run: Run = (argv) => {
    if (argv[0] === "hc" && argv[1] === "send") { sends.push(argv); return busy ? { code: 1, out: "blocked" } : { code: 0, out: "" }; }
    if (argv[0] === "hc" && argv[1] === "get") return { code: 0, out: JSON.stringify({ exit_code: null }) };
    return { code: 1, out: `${argv[0]} is stubbed` };
  };
  const base = { slug: "acme/api", run, now, name: "acme-api" };
  return { db, dir, run, sends, base, setBusy: (b: boolean) => { busy = b; } };
}

test("asking the maintainer is a note for it, with who asked and why, on Pending changes", () => {
  const s = setup();
  const r = ask(s.db, { ...s.base, to: "maintainer", from: "babysitter", text: "Turn the 'missing await' comment into a lint rule", why: "came back on #412, #415 and #420", about: 420 });
  expect(r).toMatchObject({ delivered: false, ask: { from: "babysitter", to: "maintainer", request: null, about: 420, why: "came back on #412, #415 and #420" } });
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  const status = buildStatus(s.db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.asks).toMatchObject([{ id: r.ask.id, from: "babysitter", to: "maintainer", ticket: 420 }]);
  // Live: typed into its terminal at once, like Overwatch's notes.
  const o = ask(s.db, { ...s.base, to: "maintainer", from: "overwatch", text: "Remove the worktrees of merged tickets", live: (a) => (a === "maintainer" ? "t9" : null) });
  expect(o.delivered).toBe(true);
  expect(s.sends.map((x) => x[2])).toEqual(["t9", "t9"]); // the waiting one went too
});

test("asking Overwatch: a note in Needs you, typed into its live terminal, once", () => {
  const s = setup();
  // No Overwatch running: the note waits.
  const a = ask(s.db, { ...s.base, to: "overwatch", from: "spec-writer", text: "#412 needs a product answer: free or paid tier?", about: 412, live: () => null });
  expect(a).toMatchObject({ delivered: false, ask: { from: "spec-writer", to: "overwatch", about: 412 } });
  expect(s.sends).toEqual([]);
  const st = buildStatus(s.db);
  expect(validateStatus(st)).toEqual([]);
  expect(st.asks).toEqual([{ id: a.ask.id, from: "spec-writer", to: "overwatch", text: "#412 needs a product answer: free or paid tier?", why: null, ticket: 412, at: now, delivered: false }]);
  // The daemon's tick types it once Overwatch is live; a busy send leaves it for the next tick.
  const { liveOverwatch } = require("./overwatch.ts") as typeof import("./overwatch.ts");
  const { stateFile } = require("./globals.ts") as typeof import("./globals.ts");
  const home = mkdtempSync(join(tmpdir(), "ask-home-"));
  require("node:fs").writeFileSync(stateFile(home), JSON.stringify({ terminal: "t5" }));
  s.setBusy(true);
  expect(deliverToGlobal(s.db, "overwatch", { run: s.run, now, terminal: () => liveOverwatch(s.run, home), name: "acme-api" })).toBe(0);
  s.setBusy(false);
  expect(deliverToGlobal(s.db, "overwatch", { run: s.run, now, terminal: () => liveOverwatch(s.run, home), name: "acme-api" })).toBe(1);
  expect(s.sends.at(-1)).toEqual(["hc", "send", "t5", `Note #${a.ask.id} from spec-writer about #412: #412 needs a product answer: free or paid tier?. When it's handled: factory asks done ${a.ask.id} --name acme-api`]);
  expect(deliverToGlobal(s.db, "overwatch", { run: s.run, now, terminal: () => "t5" })).toBe(0); // once
  // Asked while Overwatch is live: typed at once.
  const b = ask(s.db, { ...s.base, to: "overwatch", from: "learner", text: "Cost per PR is up 30% this week", live: () => "t5" });
  expect(b).toMatchObject({ delivered: true });
  expect(buildStatus(s.db).asks.map((x: any) => [x.id, x.delivered])).toEqual([[a.ask.id, true], [b.ask.id, true]]);
  // Handled: it leaves Needs you.
  doneAsk(s.db, a.ask.id, now);
  expect(openAsks(s.db, "overwatch").map((x) => x.id)).toEqual([b.ask.id]);
  expect(() => doneAsk(s.db, a.ask.id, now)).toThrow(/no open note/);
});

test("asking the learner or the babysitter queues a note for its next run", () => {
  const s = setup();
  const a = ask(s.db, { ...s.base, to: "learner", from: "overwatch", text: "Is Haiku enough for chores?", why: "the person asked" });
  ask(s.db, { ...s.base, to: "babysitter", from: "you", text: "Be gentler with the docs team's reviews" });
  expect(a).toMatchObject({ delivered: false });
  expect(openAsks(s.db, "learner").map((n) => n.text)).toEqual(["Is Haiku enough for chores?"]); // waiting, on Pending changes
  expect(takeNotes(s.db, "learner", now).map((n) => n.text)).toEqual(["Is Haiku enough for chores?"]);
  expect(takeNotes(s.db, "learner", now)).toEqual([]); // the run that read it handled it
  expect(openAsks(s.db, "learner")).toEqual([]);
  expect(takeNotes(s.db, "babysitter", now).map((n) => n.from)).toEqual(["you"]);
  // The decision log has every hand-off.
  expect(s.db.query("SELECT who, what FROM decisions ORDER BY id").all()).toEqual([
    { who: "overwatch", what: "asked learner: Is Haiku enough for chores?" }, { who: "you", what: "asked babysitter: Be gentler with the docs team's reviews" }]);
});

test("ask refuses an unknown agent, an empty note and asking yourself", () => {
  const s = setup();
  expect(() => ask(s.db, { ...s.base, to: "builder", from: "you", text: "x" })).toThrow(/no agent builder; you may ask: overwatch, babysitter, maintainer, learner$/);
  expect(() => ask(s.db, { ...s.base, to: "learner", from: "you", text: "  " })).toThrow(/say what you need/);
  expect(() => ask(s.db, { ...s.base, to: "learner", from: "learner", text: "x" })).toThrow(/can't ask itself/);
  expect(() => ask(s.db, { ...s.base, to: "acme/api:learner", from: "you", text: "x" })).toThrow(/learner is a factory agent/);
  expect(askerOf(null, { FACTORY_AGENT: "reviewer" })).toBe("reviewer");
  expect(askerOf("learner", { FACTORY_AGENT: "reviewer" })).toBe("learner");
  expect(askerOf(null, {})).toBe("you");
});

// Two repos, each with its own agents (plan: Peer review, Who can ask whom).
function twoRepos() {
  const s = setup();
  const agents = (slug: string, names: string[]) => {
    const path = mkdtempSync(join(tmpdir(), "ask-repo-"));
    mkdirSync(join(path, ".factory", "agents"), { recursive: true });
    for (const n of names) writeFileSync(join(path, ".factory", "agents", `${n}.md`), `---\nrole: build\n---\n${n}\n`);
    setRepo(s.db, { slug, path, lead: slug === "acme/api" });
  };
  agents("acme/api", ["builder", "reviewer"]);
  agents("acme/web", ["designer", "builder"]);
  return s;
}

test("the rule, pure: a repo agent asks the globals and its own repo; a global agent or you, anyone", () => {
  const builderApi = { agent: "builder", repo: "acme/api" };
  expect(mayAsk(builderApi, { agent: "overwatch", repo: null })).toBe(true); // a global agent
  expect(mayAsk(builderApi, { agent: "reviewer", repo: "acme/api" })).toBe(true); // its own repo
  expect(mayAsk(builderApi, { agent: "designer", repo: "acme/web" })).toBe(false); // another repo
  for (const g of ["overwatch", "babysitter", "maintainer", "learner"]) expect(mayAsk({ agent: g, repo: null }, { agent: "designer", repo: "acme/web" })).toBe(true);
  expect(mayAsk({ agent: "you", repo: null }, { agent: "designer", repo: "acme/web" })).toBe(true);
});

test("a repo agent asks its own repo's agents and the globals; another repo's is refused with where to go instead", () => {
  const s = twoRepos();
  const asBuilder = { ...s.base, from: "builder", fromRepo: "acme/api", live: () => null };
  // Its own repo, bare or named.
  const a = ask(s.db, { ...asBuilder, to: "reviewer", text: "Is the retry loop in scope?" });
  expect(a.ask).toMatchObject({ from: "builder", to: "reviewer", toRepo: "acme/api" });
  expect(ask(s.db, { ...asBuilder, to: "acme/api:reviewer", text: "And the timeout?" }).ask.toRepo).toBe("acme/api");
  // A bare name is its own repo's, even when another repo has one by that name too.
  expect(() => ask(s.db, { ...asBuilder, to: "builder", text: "x" })).toThrow(/can't ask itself/);
  // A global agent.
  expect(ask(s.db, { ...asBuilder, to: "overwatch", text: "Needs a product answer" }).ask).toMatchObject({ to: "overwatch", toRepo: null });
  // Another repo's agent: refused, whether it exists there or not, and nothing is recorded.
  const before = s.db.query("SELECT COUNT(*) AS n FROM asks").get();
  expect(() => ask(s.db, { ...asBuilder, to: "acme/web:designer", text: "Which colour?" }))
    .toThrow(/builder works in acme\/api and can't ask acme\/web:designer: .* Ask overwatch instead: factory ask overwatch/);
  expect(() => ask(s.db, { ...asBuilder, to: "acme/web:nobody", text: "x" })).toThrow(/can't ask acme\/web:nobody/);
  // A bare name only another repo has is unknown to it; the error lists whom it may ask.
  expect(() => ask(s.db, { ...asBuilder, to: "designer", text: "x" })).toThrow(/no agent designer in acme\/api; builder may ask: overwatch, babysitter, maintainer, learner, builder, reviewer$/);
  expect(s.db.query("SELECT COUNT(*) AS n FROM asks").get()).toEqual(before);
  // Every ask is in the decision log, its target named.
  expect(s.db.query("SELECT what FROM decisions WHERE who = 'builder' ORDER BY id").all().map((d: any) => d.what))
    .toEqual(["asked acme/api:reviewer: Is the retry loop in scope?", "asked acme/api:reviewer: And the timeout?", "asked overwatch: Needs a product answer"]);
});

test("a global agent, or you, asks any agent in any repo", () => {
  const s = twoRepos();
  for (const from of ["overwatch", "babysitter", "maintainer", "learner", "you"])
    expect(ask(s.db, { ...s.base, from, to: "acme/web:designer", text: `from ${from}` }).ask).toMatchObject({ to: "designer", toRepo: "acme/web" });
  // A bare name that one repo has is that repo's; one two repos have must say which.
  expect(ask(s.db, { ...s.base, from: "overwatch", to: "reviewer", text: "x" }).ask.toRepo).toBe("acme/api");
  expect(() => ask(s.db, { ...s.base, from: "overwatch", to: "builder", text: "x" })).toThrow(/builder is in acme\/api and acme\/web: say which, as acme\/api:builder/);
  expect(() => ask(s.db, { ...s.base, from: "overwatch", to: "acme/web:reviewer", text: "x" }))
    .toThrow(/no agent reviewer in acme\/web; overwatch may ask: overwatch, babysitter, maintainer, learner, acme\/api:builder, acme\/api:reviewer, acme\/web:builder, acme\/web:designer$/);
  expect(() => ask(s.db, { ...s.base, from: "you", to: "shop/x:builder", text: "x" })).toThrow(/no repo shop\/x in this factory/);
  expect(buildStatus(s.db).asks.map((a: any) => a.to)).toContain("acme/web:designer");
});

test("a note to a repo agent is typed into its live session there, else waits for its next brief", () => {
  const s = twoRepos();
  const ticket = (id: number, repo: string) => {
    s.db.query("INSERT INTO tickets (id, title, updated_at) VALUES (?, 't', ?)").run(id, now);
    s.db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (?, ?, 1)").run(id, repo);
  };
  const session = (id: number, agent: string, terminal: string) =>
    s.db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at) VALUES (?, 'build', ?, ?, '[]', ?)").run(id, agent, terminal, now);
  ticket(1, "acme/api"); ticket(2, "acme/web");
  session(1, "builder", "t-api"); session(2, "builder", "t-web");
  // Live in that repo: typed into that repo's session, not the other repo's builder.
  const a = ask(s.db, { ...s.base, from: "overwatch", to: "acme/web:builder", text: "Rebase on main first" });
  expect(a).toMatchObject({ delivered: true });
  expect(s.sends.at(-1)).toEqual(["hc", "send", "t-web", `Note #${a.ask.id} from overwatch: Rebase on main first. When it's handled: factory asks done ${a.ask.id} --name acme-api`]);
  // About a ticket: only that ticket's session; none live for it, so it waits.
  const b = ask(s.db, { ...s.base, from: "overwatch", to: "acme/web:builder", text: "#7 changed scope", about: 7 });
  expect(b.delivered).toBe(false);
  // No live session of the agent in the repo: it waits, and the daemon's tick doesn't type it anywhere.
  const c = ask(s.db, { ...s.base, from: "you", to: "acme/web:designer", text: "Use the new palette" });
  expect(c.delivered).toBe(false);
  const sent = s.sends.length;
  expect(deliverToRepoAgents(s.db, { run: s.run, now })).toBe(0);
  expect(s.sends.length).toBe(sent);
  // A busy send leaves it for the next tick.
  session(2, "designer", "t-design");
  s.setBusy(true);
  expect(deliverToRepoAgents(s.db, { run: s.run, now })).toBe(0);
  s.setBusy(false);
  expect(deliverToRepoAgents(s.db, { run: s.run, now })).toBe(1);
  expect(s.sends.at(-1)?.[2]).toBe("t-design");
  // The next brief of that agent in that repo takes what's still waiting: ticket 7's builder gets its note.
  const forSeven = notesForBrief(s.db, { agent: "builder", repo: "acme/web", ticket: 7 });
  expect(forSeven.map((n) => n.id)).toEqual([b.ask.id]);
  expect(notesForBrief(s.db, { agent: "builder", repo: "acme/api", ticket: 7 })).toEqual([]); // another repo's builder doesn't
  expect(notesForBrief(s.db, { agent: "builder", repo: "acme/web", ticket: 8 })).toEqual([]); // another ticket's doesn't
  expect(briefNotes(forSeven, "acme-api")).toBe(`## Notes other agents left you\n\n- Note #${b.ask.id} from overwatch about #7: #7 changed scope. When it's handled: factory asks done ${b.ask.id} --name acme-api`);
  deliveredInBrief(s.db, forSeven, now);
  expect(notesForBrief(s.db, { agent: "builder", repo: "acme/web", ticket: 7 })).toEqual([]); // once
  expect(openAsks(s.db, "builder").map((n) => n.id)).toEqual([a.ask.id, b.ask.id]); // open until handled
});

test("every agent session knows who it is: FACTORY_AGENT, FACTORY_TICKET and FACTORY_REPO", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "home-")), "acme-api");
  const argv = withFactory(["claude", "hi"], dir, { agent: "builder", ticket: 412, repo: "acme/web" });
  expect(argv).toEqual(expect.arrayContaining(["FACTORY_NAME=acme-api", "FACTORY_AGENT=builder", "FACTORY_TICKET=412", "FACTORY_REPO=acme/web"]));
  expect(withFactory(["claude", "hi"], dir).some((a) => a.startsWith("FACTORY_AGENT="))).toBe(false);
});

test("factory ask, asks and asks done from the CLI; factory request stays a request from you", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "ask-home-"));
  const out: string[] = [];
  const cli = (...a: string[]) => main([...a, "--name", "acme-api"], (x) => out.push(x));
  cli("init", "--repo", "acme/api", "--path", mkdtempSync(join(tmpdir(), "ask-repo-")));
  try {
    process.env.FACTORY_AGENT = "reviewer";
    process.env.FACTORY_TICKET = "412";
    cli("ask", "overwatch", "The", "spec", "contradicts", "the", "issue", "--why", "INTENT says 5, the issue says 10");
    expect(out.at(-1)).toMatch(/^note #1 for overwatch, from reviewer: in Needs you/);
    cli("request", "Raise", "the", "day's", "budget");
    // Tests never start a real terminal: the maintainer gets it when it next starts.
    expect(out.at(-1)).toMatch(/^note #2 for the maintainer, from you: the maintainer isn't running and didn't start .*; it gets it when it next starts/);
    cli("ask", "maintainer", "Make the reviewer stricter", "--from", "learner", "--why", "3 reverts");
    expect(out.at(-1)).toMatch(/^note #3 for the maintainer, from learner/);
    // The session's repo (FACTORY_REPO) is what the rule checks: another repo's agent is refused.
    process.env.FACTORY_REPO = "acme/api";
    expect(() => cli("ask", "acme/web:builder", "x")).toThrow(/reviewer works in acme\/api and can't ask acme\/web:builder/);
  } finally { delete process.env.FACTORY_AGENT; delete process.env.FACTORY_TICKET; delete process.env.FACTORY_REPO; }
  const status = JSON.parse(readFileSync(paths("acme-api").status, "utf8"));
  expect(validateStatus(status)).toEqual([]);
  expect(status.asks).toMatchObject([{ id: 1, from: "reviewer", to: "overwatch", ticket: 412, why: "INTENT says 5, the issue says 10" },
    { id: 2, from: "you", to: "maintainer", text: "Raise the day's budget" }, { id: 3, from: "learner", to: "maintainer", why: "3 reverts" }]);
  expect(status.tickets).toEqual([]);
  out.length = 0;
  cli("asks", "--json");
  expect(JSON.parse(out[0]).map((a: any) => a.id)).toEqual([1, 2, 3]);
  cli("asks", "done", "1");
  expect(JSON.parse(readFileSync(paths("acme-api").status, "utf8")).asks.map((a: any) => a.id)).toEqual([2, 3]);
  out.length = 0;
  cli("asks", "overwatch");
  expect(out).toEqual(["no open notes for overwatch", expect.stringMatching(/^Note #1 .* \[done\]$/)]);
  expect(() => cli("ask", "pr-writer", "x")).toThrow(/no agent pr-writer/);
});
