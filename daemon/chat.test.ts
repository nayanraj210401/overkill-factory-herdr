import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { buildStatus } from "./status.ts";
import { resume, sh, startTicket, type Run } from "./runner.ts";
import { closeChat, liveChat, startChat } from "./chat.ts";
import { validateStatus } from "../lib/status.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", dir, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: echo\n---\nWrite INTENT.md.\n");
  sh(["git", "-C", dir, "add", "."]);
  sh(["git", "-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

// Real git; hc is faked: each `hc run` gets the next address, `hc kill` and exit() end one.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const runs: string[][] = [];
  const killed: string[] = [];
  const gone = new Set<string>();
  let n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] !== "hc") return sh(argv, cwd);
    if (argv[1] === "run") return (runs.push(argv), { code: 0, out: JSON.stringify({ address: `t${++n}` }) });
    if (argv[1] === "kill") return (killed.push(argv[2]), gone.add(argv[2]), { code: 0, out: "" });
    if (argv[1] === "get") return { code: 0, out: JSON.stringify(gone.has(argv[2]) ? { exit_code: null, state: "finished" } : { exit_code: null, state: "live" }) };
    return { code: 0, out: "" };
  };
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (412, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  const r = repo();
  setRepo(db, { slug: "acme/api", path: r, lead: true });
  return { dir, db, run, runs, killed, exit: (t: string) => gone.add(t), repo: r };
}

const at = (m: number) => `2026-11-21T10:${String(m).padStart(2, "0")}:00Z`;
const ticket = (db: any) => db.query("SELECT state, stage, worktree FROM ticket_lead WHERE id = 412").get() as { state: string; stage: string; worktree: string };
const open_ = (db: any) => db.query("SELECT stage, terminal, paused_ticket FROM sessions WHERE ended_at IS NULL ORDER BY id").all();

test("a chat session pauses a running ticket, works in its worktree, and closing it resumes the blueprint", () => {
  const h = setup();
  startTicket(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(0) }); // spec agent in t1
  const r = startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(1) });
  expect(r).toEqual({ terminal: "t2", started: true, paused: true });
  expect(h.killed).toEqual(["t1"]); // the stage agent stopped: never two agents on the worktree
  expect(ticket(h.db)).toMatchObject({ state: "paused", stage: "spec" });
  expect(open_(h.db)).toEqual([{ stage: "chat", terminal: "t2", paused_ticket: 1 }]);
  const argv = h.runs[1];
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(ticket(h.db).worktree);
  expect(argv).toContain("factory.stage=chat");
  expect(argv).toContain("auto");
  expect(argv.at(-1)).toContain("You are the person's own session on ticket #412: Rate-limit login");
  expect(argv.at(-1)).toContain("blueprint is paused while you're open");
  // The ticket's terminal is the chat's, so the Chat view types into it.
  const s = buildStatus(h.db);
  expect(validateStatus(s)).toEqual([]);
  expect(s.tickets[0].terminal).toBe("t2");
  // Asked again: the same session.
  expect(startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(2) })).toEqual({ terminal: "t2", started: false, paused: false });
  const c = closeChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(3) });
  expect(c).toMatchObject({ closed: "t2", resumed: { stage: "spec", terminal: "t3" } });
  expect(h.killed).toEqual(["t1", "t2"]);
  expect(ticket(h.db)).toMatchObject({ state: "running", stage: "spec" });
  expect(open_(h.db)).toEqual([{ stage: "spec", terminal: "t3", paused_ticket: 0 }]);
  const said = (h.db.query("SELECT text FROM ticket_events WHERE ticket = 412 ORDER BY id").all() as { text: string }[]).map((e) => e.text);
  expect(said).toContain("your chat session: paused at spec");
  expect(said).toContain("your chat session closed: the blueprint carries on");
});

test("its terminal exiting ends it, and the ticket it paused resumes", () => {
  const h = setup();
  startTicket(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(0) });
  startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(1) });
  h.exit("t2"); // the person typed /exit, or Herdr stopped it
  expect(liveChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(2) })).toBeNull();
  expect(ticket(h.db).state).toBe("running");
  expect(open_(h.db)).toEqual([{ stage: "spec", terminal: "t3", paused_ticket: 0 }]);
});

test("resume with the chat open closes it first and resumes once", () => {
  const h = setup();
  startTicket(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(0) });
  startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(1) });
  expect(resume(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(2) })).toEqual({ stage: "spec", terminal: "t3" });
  expect(h.killed).toEqual(["t1", "t2"]);
  expect(open_(h.db)).toEqual([{ stage: "spec", terminal: "t3", paused_ticket: 0 }]);
});

test("a ticket that isn't running isn't paused, nor resumed when the chat closes", () => {
  const h = setup();
  startTicket(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(0) });
  h.db.query("UPDATE tickets SET state = 'parked' WHERE id = 412").run();
  h.db.query("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL").run(at(0));
  expect(startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(1) })).toMatchObject({ started: true, paused: false });
  expect(h.runs.at(-1)!.at(-1)).not.toContain("blueprint is paused");
  expect(closeChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(2) })).toEqual({ closed: "t2", resumed: null });
  expect(ticket(h.db).state).toBe("parked");
});

test("a ticket with no worktree yet has nowhere to chat", () => {
  const h = setup();
  expect(() => startChat(h.db, { dir: h.dir, repo: h.repo, id: 412, run: h.run, now: at(0) })).toThrow("hasn't started");
});
