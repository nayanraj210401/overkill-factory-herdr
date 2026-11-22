import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { ask, askerOf, deliverToOverwatch, doneAsk, openAsks, takeNotes } from "./ask.ts";
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
  const base = { slug: "acme/api", dir, run, now, name: "acme-api" };
  return { db, dir, run, sends, base, setBusy: (b: boolean) => { busy = b; } };
}

test("asking the maintainer files a maintainer request, with who asked and why", () => {
  const s = setup();
  const r = ask(s.db, { ...s.base, to: "maintainer", from: "babysitter", text: "Turn the 'missing await' comment into a lint rule", why: "came back on #412, #415 and #420", about: 420 });
  expect(r.kind).toBe("request");
  if (r.kind !== "request") return;
  expect(s.db.query("SELECT blueprint, state FROM tickets WHERE id = ?").get(r.id)).toEqual({ blueprint: "factory", state: "queued" });
  expect(r.ask).toMatchObject({ from: "babysitter", to: "maintainer", request: r.id, about: 420, why: "came back on #412, #415 and #420" });
  const md = readFileSync(join(s.dir, "tickets", String(r.id), "REQUEST.md"), "utf8");
  expect(md).toContain("From: the babysitter agent");
  expect(md).toContain("About: ticket #420");
  expect(md).toContain("## Evidence\n\ncame back on #412, #415 and #420");
  const status = buildStatus(s.db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.tickets.find((t: any) => t.id === r.id)).toMatchObject({ requested_by: "babysitter" });
  expect(status.asks).toEqual([]); // a request is a ticket on Pending changes, not a note
  // Overwatch asking on its own says so.
  const o = ask(s.db, { ...s.base, to: "maintainer", from: "overwatch", text: "Remove the worktrees of merged tickets" });
  expect(buildStatus(s.db).tickets.find((t: any) => t.id === (o as any).id)).toMatchObject({ requested_by: "overwatch" });
});

test("asking Overwatch: a note in Needs you, typed into its live terminal, once", () => {
  const s = setup();
  // No Overwatch running: the note waits.
  const a = ask(s.db, { ...s.base, to: "overwatch", from: "spec-writer", text: "#412 needs a product answer: free or paid tier?", about: 412, overwatch: () => null });
  expect(a).toMatchObject({ kind: "note", delivered: false, ask: { from: "spec-writer", to: "overwatch", about: 412 } });
  expect(s.sends).toEqual([]);
  const st = buildStatus(s.db);
  expect(validateStatus(st)).toEqual([]);
  expect(st.asks).toEqual([{ id: a.ask.id, from: "spec-writer", to: "overwatch", text: "#412 needs a product answer: free or paid tier?", why: null, ticket: 412, at: now, delivered: false }]);
  // The daemon's tick types it once Overwatch is live; a busy send leaves it for the next tick.
  const { liveOverwatch, stateFile } = require("./overwatch.ts") as typeof import("./overwatch.ts");
  const home = mkdtempSync(join(tmpdir(), "ask-home-"));
  require("node:fs").writeFileSync(stateFile(home), JSON.stringify({ terminal: "t5" }));
  s.setBusy(true);
  expect(deliverToOverwatch(s.db, { run: s.run, now, terminal: () => liveOverwatch(s.run, home), name: "acme-api" })).toBe(0);
  s.setBusy(false);
  expect(deliverToOverwatch(s.db, { run: s.run, now, terminal: () => liveOverwatch(s.run, home), name: "acme-api" })).toBe(1);
  expect(s.sends.at(-1)).toEqual(["hc", "send", "t5", `Note #${a.ask.id} from spec-writer about #412: #412 needs a product answer: free or paid tier?. When it's handled: factory asks done ${a.ask.id} --name acme-api`]);
  expect(deliverToOverwatch(s.db, { run: s.run, now, terminal: () => "t5" })).toBe(0); // once
  // Asked while Overwatch is live: typed at once.
  const b = ask(s.db, { ...s.base, to: "overwatch", from: "learner", text: "Cost per PR is up 30% this week", overwatch: () => "t5" });
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
  expect(a).toMatchObject({ kind: "note", delivered: false });
  expect(openAsks(s.db, "learner").map((n) => n.text)).toEqual(["Is Haiku enough for chores?"]); // waiting, on Pending changes
  expect(takeNotes(s.db, "learner", now).map((n) => n.text)).toEqual(["Is Haiku enough for chores?"]);
  expect(takeNotes(s.db, "learner", now)).toEqual([]); // the run that read it handled it
  expect(openAsks(s.db, "learner")).toEqual([]);
  expect(takeNotes(s.db, "babysitter", now).map((n) => n.from)).toEqual(["you"]);
  // The decision log has every hand-off.
  expect(s.db.query("SELECT who, what FROM decisions ORDER BY id").all()).toEqual([
    { who: "overwatch", what: "asked learner: Is Haiku enough for chores?" }, { who: "you", what: "asked babysitter: Be gentler with the docs team's reviews" }]);
});

test("ask refuses a repo agent, an empty note and asking yourself", () => {
  const s = setup();
  expect(() => ask(s.db, { ...s.base, to: "builder", from: "you", text: "x" })).toThrow(/ask whom\? overwatch, babysitter, maintainer, learner/);
  expect(() => ask(s.db, { ...s.base, to: "learner", from: "you", text: "  " })).toThrow(/say what you need/);
  expect(() => ask(s.db, { ...s.base, to: "learner", from: "learner", text: "x" })).toThrow(/can't ask itself/);
  expect(askerOf(null, { FACTORY_AGENT: "reviewer" })).toBe("reviewer");
  expect(askerOf("learner", { FACTORY_AGENT: "reviewer" })).toBe("learner");
  expect(askerOf(null, {})).toBe("you");
});

test("every agent session knows who it is: FACTORY_AGENT and FACTORY_TICKET", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "home-")), "acme-api");
  const argv = withFactory(["claude", "hi"], dir, { agent: "builder", ticket: 412 });
  expect(argv).toEqual(expect.arrayContaining(["FACTORY_NAME=acme-api", "FACTORY_AGENT=builder", "FACTORY_TICKET=412"]));
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
    expect(out.at(-1)).toMatch(/a config request for the maintainer from you, in acme\/api/);
    cli("ask", "maintainer", "Make the reviewer stricter", "--from", "learner", "--why", "3 reverts");
    expect(out.at(-1)).toMatch(/request for the maintainer from learner/);
  } finally { delete process.env.FACTORY_AGENT; delete process.env.FACTORY_TICKET; }
  const status = JSON.parse(readFileSync(paths("acme-api").status, "utf8"));
  expect(validateStatus(status)).toEqual([]);
  expect(status.asks).toMatchObject([{ id: 1, from: "reviewer", to: "overwatch", ticket: 412, why: "INTENT says 5, the issue says 10" }]);
  expect(status.tickets.filter((t: any) => t.blueprint === "factory").map((t: any) => t.requested_by)).toEqual(["you", "learner"]);
  out.length = 0;
  cli("asks", "--json");
  expect(JSON.parse(out[0]).map((a: any) => a.id)).toEqual([1]);
  cli("asks", "done", "1");
  expect(JSON.parse(readFileSync(paths("acme-api").status, "utf8")).asks).toEqual([]);
  out.length = 0;
  cli("asks", "overwatch");
  expect(out).toEqual(["no open notes for overwatch", expect.stringMatching(/^Note #1 .* \[done\]$/)]);
  expect(() => cli("ask", "pr-writer", "x")).toThrow(/Repo agents work one stage/);
});
