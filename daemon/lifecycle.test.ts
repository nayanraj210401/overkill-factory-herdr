import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, ticketRepos } from "./db.ts";
import { sh, startTicket, type Run } from "./runner.ts";
import { acceptance, blockedBy, cosmetic, dropTicket, followIssues, reportBlocked, scopeQuestions } from "./lifecycle.ts";

const T0 = "2026-11-21T10:00:00Z";
const T1 = "2026-11-21T10:06:00Z";
const T2 = "2026-11-21T10:12:00Z";

const BODY = "Add rate limiting.\n\n## Acceptance criteria\n\n- [ ] 6th login attempt in a minute gets a 429\n- [ ] Limits reset after 60 seconds\n";

// gh is stubbed: `issues` maps a number to the JSON `gh issue view` prints; `items` is the Project's list.
function setup(queue = "") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${queue}`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const issues: Record<number, { state?: string; body?: string; assignees?: string[] }> = {};
  let items: object[] = [];
  const gh: string[][] = [];
  const hc: string[][] = [];
  const run: Run = (argv, cwd) => {
    if (argv[0] === "hc") return hc.push(argv), { code: 0, out: '{"address":"t1"}' };
    if (argv[0] !== "gh") return sh(argv, cwd);
    gh.push(argv);
    if (argv[1] === "issue" && argv[2] === "view") {
      const i = issues[Number(argv[3])];
      return i ? { code: 0, out: JSON.stringify({ number: Number(argv[3]), state: i.state ?? "OPEN", body: i.body ?? "", assignees: (i.assignees ?? ["me"]).map((login) => ({ login })) }) } : { code: 1, out: "not found" };
    }
    if (argv[1] === "project") return { code: 0, out: JSON.stringify({ items }) };
    return { code: 0, out: "" };
  };
  const add = (id: number, state = "queued", from?: string) => {
    db.query("INSERT INTO tickets (id, title, state, blueprint, groomed_at, updated_at) VALUES (?, 'Rate-limit login', ?, 'feature', ?, ?)").run(id, state, T0, T0);
    if (from) db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(id, `joined from ${from}'s Ready column`, T0);
  };
  const start = (id: number) => startTicket(db, { dir, repo, id, run, now: T0 });
  const follow = (now: string, force = false) => { const logs: string[] = []; followIssues(db, { dir, repo, run, now, log: (s) => logs.push(s), force }); return logs; };
  const row = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  const decisions = (id: number) => (db.query("SELECT who, what, why FROM decisions WHERE ticket = ? ORDER BY id").all(id) as any[]).map((d) => `${d.who}: ${d.what}`);
  const intent = (id: number, text: string) => { mkdirSync(join(dir, "tickets", String(id)), { recursive: true }); writeFileSync(join(dir, "tickets", String(id), "INTENT.md"), text); };
  return { db, dir, repo, run, issues, setItems: (i: object[]) => { items = i; }, gh, hc, add, start, follow, row, decisions, intent };
}

test("a blocked-by link finds the blocker in the issue body", () => {
  expect(blockedBy("Needs the new API.\n\nBlocked by #430")).toBe(430);
  expect(blockedBy("blocked by acme/web#12")).toBe(12);
  expect(blockedBy("this is not blocked, by design #5")).toBeNull();
});

test("blocked late: the issue gains a link, the ticket pauses (worktree kept), and it resumes when the blocker closes", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  s.issues[412] = { body: BODY };
  s.issues[430] = { state: "OPEN" };
  s.follow(T0); // the baseline read
  expect(s.row(412).state).toBe("running");
  const worktree = s.row(412).worktree;
  s.issues[412] = { body: `${BODY}\nBlocked by #430` };
  s.follow(T1);
  expect(s.row(412)).toMatchObject({ state: "blocked", blocked_by: 430 });
  expect(existsSync(worktree)).toBe(true);
  expect(s.hc.some((c) => c[1] === "kill")).toBe(true); // the session stopped
  expect(s.db.query("SELECT COUNT(*) AS n FROM sessions WHERE ticket = 412 AND ended_at IS NULL").get()).toEqual({ n: 0 });
  // Still open: stays blocked.
  s.follow(T2);
  expect(s.row(412).state).toBe("blocked");
  // Merged or closed: picks up where it paused.
  s.issues[430] = { state: "MERGED" };
  const logs = s.follow("2026-11-21T10:20:00Z");
  expect(s.row(412)).toMatchObject({ state: "running", blocked_by: null, worktree });
  expect(logs.join("\n")).toContain("unblocked");
  expect(s.decisions(412)).toContain("daemon: #430 is done; unblocked");
});

test("a blocker that is already closed doesn't block", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  s.issues[412] = { body: "Blocked by #430" };
  s.issues[430] = { state: "CLOSED" };
  s.follow(T0);
  expect(s.row(412).state).toBe("running");
});

test("blocked late: an agent's `factory block` stops the ticket on the next tick", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  reportBlocked(s.db, { id: 412, by: 430, run: s.run, now: T0 });
  expect(s.row(412).state).toBe("running"); // the agent's own call doesn't kill it
  s.issues[412] = { body: BODY };
  s.issues[430] = { state: "OPEN" };
  s.follow(T1);
  expect(s.row(412)).toMatchObject({ state: "blocked", blocked_by: 430 });
  expect(s.decisions(412)).toContain("agent: reported blocked by #430");
});

test("a queued ticket blocks without a worktree, and goes back to the queue", () => {
  const s = setup();
  s.add(412);
  reportBlocked(s.db, { id: 412, by: 430, run: s.run, now: T0 });
  expect(s.row(412)).toMatchObject({ state: "blocked", blocked_by: 430 });
  s.issues[412] = { body: BODY };
  s.issues[430] = { state: "CLOSED" };
  s.follow(T1);
  expect(s.row(412)).toMatchObject({ state: "queued", blocked_by: null });
});

test("the issues are read at most every five minutes", () => {
  const s = setup();
  s.add(412);
  s.issues[412] = { body: BODY };
  s.follow(T0);
  const n = s.gh.length;
  s.follow("2026-11-21T10:03:00Z");
  expect(s.gh.length).toBe(n);
  s.follow(T1);
  expect(s.gh.length).toBeGreaterThan(n);
});

test("cosmetic edits: whitespace, case and a typo are the same criteria; a changed number is not", () => {
  const a = acceptance(BODY);
  expect(cosmetic(a, a.replace(/\n/g, "\n\n  ").toUpperCase())).toBe(true);
  expect(cosmetic(a, a.replace("attempt", "atempt"))).toBe(true);
  expect(cosmetic(a, a.replace("60 seconds", "90 seconds"))).toBe(false);
  expect(cosmetic(a, a.replace("Limits reset after 60 seconds", "Limits reset when the user logs in"))).toBe(false);
});

test("acceptance takes the Acceptance section, or the whole text without one", () => {
  expect(acceptance(BODY)).toBe("- [ ] 6th login attempt in a minute gets a 429\n- [ ] Limits reset after 60 seconds");
  expect(acceptance("just a sentence")).toBe("just a sentence");
});

test("scope questions name the lines the issue gained and the ones INTENT.md has that it lost", () => {
  const q = scopeQuestions("- 6th attempt gets a 429\n- Limits reset after 60 seconds", "- 6th attempt gets a 429\n- Admins are exempt");
  expect(q.length).toBe(2);
  expect(q[0]).toContain("Admins are exempt");
  expect(q[1]).toContain("Limits reset after 60 seconds");
});

const INTENT = "# Intent\n\nRate-limit login.\n\n## Acceptance checks\n\n- 6th login attempt in a minute gets a 429\n- Limits reset after 60 seconds\n";

test("scope changed: a real change sends the ticket back to grooming with the difference as questions", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  s.intent(412, INTENT);
  s.issues[412] = { body: BODY };
  s.follow(T0);
  s.issues[412] = { body: BODY.replace("- [ ] Limits reset after 60 seconds", "- [ ] Admins are exempt from the limit") };
  s.follow(T1);
  const t = s.row(412);
  expect(t).toMatchObject({ state: "grooming", needs_kind: "question" });
  const qs = s.db.query("SELECT kind, text FROM questions WHERE ticket = 412 ORDER BY n").all() as any[];
  expect(qs.length).toBe(2);
  expect(qs.map((q) => q.text).join("\n")).toContain("Admins are exempt");
  expect(t.needs_text).toContain("Q1:");
  // The questions are posted on the issue like grooming's own.
  expect(s.gh.some((c) => c[1] === "issue" && c[2] === "comment" && c.at(-1)!.includes("Admins are exempt"))).toBe(true);
  // No repeat on the next read.
  s.follow(T2);
  expect(s.db.query("SELECT COUNT(*) AS n FROM questions WHERE ticket = 412").get()).toEqual({ n: 2 });
});

test("scope changed: a cosmetic edit is noted as a decision and ignored", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  s.intent(412, INTENT);
  s.issues[412] = { body: BODY };
  s.follow(T0);
  s.issues[412] = { body: BODY.replace("attempt", "atempt").replace("Add rate limiting.", "Add  rate limiting. ") };
  s.follow(T1);
  expect(s.row(412).state).toBe("running");
  expect(s.decisions(412).filter((d) => d.includes("edited") && d.startsWith("daemon")).length).toBe(1);
  s.follow(T2); // unchanged since: nothing more is noted
  expect(s.decisions(412).filter((d) => d.includes("edited")).length).toBe(1);
  expect(s.db.query("SELECT COUNT(*) AS n FROM questions").get()).toEqual({ n: 0 });
});

test("pulled back: a closed issue pauses the ticket and asks keep or drop", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  s.issues[412] = { body: BODY };
  s.follow(T0);
  s.issues[412] = { state: "CLOSED", body: BODY };
  s.follow(T1);
  const t = s.row(412);
  expect(t).toMatchObject({ state: "paused", needs_kind: "question" });
  expect(t.needs_text).toContain("Keep or drop the branch?");
  expect(t.needs_text).toContain("closed");
  expect(existsSync(t.worktree)).toBe(true);
});

test("pulled back: unassigned from you, only for a ticket from the queue", () => {
  const q = "queue: { github_project: acme/7, column: Ready, assignee: me }\n";
  const s = setup(q);
  s.db.query("INSERT INTO meta (key, value) VALUES ('gh_login', 'me')").run();
  s.add(412, "queued", "acme/7");
  s.add(413); // added by hand: the queue's rules don't apply
  s.setItems([{ status: "Ready", content: { type: "Issue", number: 412 } }, { status: "Ready", content: { type: "Issue", number: 413 } }]);
  s.issues[412] = { body: BODY, assignees: ["someone-else"] };
  s.issues[413] = { body: BODY, assignees: ["someone-else"] };
  s.follow(T0);
  expect(s.row(412)).toMatchObject({ state: "paused", needs_kind: "question" });
  expect(s.row(412).needs_text).toContain("no longer assigned to you");
  expect(s.row(413).state).toBe("queued");
});

test("pulled back: leaving the Ready column, for a ticket from the queue; one still there stays", () => {
  const q = "queue: { github_project: acme/7, column: Ready, assignee: me }\n";
  const s = setup(q);
  s.db.query("INSERT INTO meta (key, value) VALUES ('gh_login', 'me')").run();
  s.add(412, "queued", "acme/7");
  s.add(413, "queued", "acme/7");
  s.issues[412] = { body: BODY };
  s.issues[413] = { body: BODY };
  s.setItems([{ status: "In progress", content: { type: "Issue", number: 412 } }, { status: "Ready", content: { type: "Issue", number: 413 } }]);
  s.follow(T0);
  expect(s.row(412)).toMatchObject({ state: "paused" });
  expect(s.row(412).needs_text).toContain("left the Ready column");
  expect(s.row(413).state).toBe("queued");
});

test("drop removes the worktrees and closes the ticket; the branch and the .md files stay", () => {
  const s = setup();
  s.add(412);
  s.start(412);
  const { worktree, branch, path } = ticketRepos(s.db, 412)[0] as any;
  mkdirSync(join(s.dir, "tickets/412"), { recursive: true });
  writeFileSync(join(s.dir, "tickets/412/INTENT.md"), "x");
  expect(existsSync(worktree)).toBe(true);
  dropTicket(s.db, { id: 412, run: s.run, now: T1 });
  expect(s.row(412)).toMatchObject({ state: "closed", worktree: null });
  expect(existsSync(worktree)).toBe(false);
  expect(sh(["git", "-C", path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code).toBe(0);
  expect(existsSync(join(s.dir, "tickets/412/INTENT.md"))).toBe(true);
  expect(() => dropTicket(s.db, { id: 412, run: s.run, now: T1 })).toThrow("closed already");
});

test("keeping a paused-while-queued ticket puts it back in the queue", async () => {
  const { resume } = await import("./runner.ts");
  const s = setup();
  s.add(412);
  s.db.query("UPDATE tickets SET state = 'paused', needs_kind = 'question', needs_text = 'keep?' WHERE id = 412").run();
  resume(s.db, { dir: s.dir, repo: s.repo, id: 412, run: s.run, now: T1 });
  expect(s.row(412)).toMatchObject({ state: "queued", needs_kind: null });
});
