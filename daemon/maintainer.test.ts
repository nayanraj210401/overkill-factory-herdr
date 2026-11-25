import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, open, setRepo } from "./db.ts";
import { loadBlueprint, sh, type Run } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { backup, backupsByFile, closeRetiredRequests, maintainer, maintainerBrief, restore } from "./maintainer.ts";
import { ask, openAsks } from "./ask.ts";
import { learnerSuggest, promoteOverrides } from "./learner.ts";
import { addLesson, setOverride } from "./learn.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { stateFile } from "./globals.ts";
import { main } from "./cli.ts";

const now = "2026-11-23T10:00:00.000Z";

// A factory with its lead repo, under a FACTORY_HOME of its own, and an hc that records calls.
function setup(factoryYaml = "name: t\nquality_floor: [\"true\"]\n") {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  process.env.FACTORY_HOME = home; // the account config and backups live here, never in ~/.factory
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  const dir = join(home, "acme");
  mkdirSync(dir, { recursive: true });
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  let exited = false, n = 0;
  const run: Run = (argv, cwd) => {
    if (argv[0] !== "hc") return sh(argv, cwd);
    calls.push(argv);
    if (argv[1] === "get") return { code: 0, out: JSON.stringify({ exit_code: exited ? 0 : null }) };
    return { code: 0, out: JSON.stringify({ address: `t${++n}` }) };
  };
  return { home, dir, db, repo, run, calls, exit: () => { exited = true; } };
}

test("a request is a note for the maintainer, never a ticket: no blueprint, no worktree, no PR", () => {
  const s = setup();
  const r = ask(s.db, { to: "maintainer", text: "  Raise the day's budget\n to 60M input ", from: "you", slug: "acme/api", run: s.run, now });
  expect(r.ask).toMatchObject({ to: "maintainer", from: "you", text: "Raise the day's budget to 60M input", request: null, delivered_at: null });
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  expect(() => loadBlueprint(s.repo, "factory")).toThrow(/no blueprint "factory"/); // nothing ships for requests any more
  expect(loadAgent(s.repo, "maintainer")?.role).toBe("maintain");
  // Config's Pending changes shows it as a note from you to the maintainer.
  const status = buildStatus(s.db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.asks).toMatchObject([{ id: r.ask.id, from: "you", to: "maintainer", delivered: false }]);
});

test("--repo names the repo the change is in; one the factory doesn't have is refused", () => {
  const s = setup();
  const r = ask(s.db, { to: "maintainer", text: "Make the reviewer stricter", from: "you", slug: "acme/api", run: s.run, now, target: "ACME/api" });
  expect(r.ask.text).toBe(`In acme/api (${s.repo}): Make the reviewer stricter`);
  expect(() => ask(s.db, { to: "maintainer", text: "x", from: "you", slug: "acme/api", run: s.run, now, target: "acme/web" })).toThrow("acme/web isn't one of this factory's repos");
  expect(() => ask(s.db, { to: "learner", text: "x", from: "you", slug: "acme/api", run: s.run, now, target: "acme/api" })).toThrow("--repo names the repo of a change for the maintainer");
});

test("the maintainer is a live global session: started with the waiting requests in its brief, then typed into", () => {
  const s = setup();
  const first = ask(s.db, { to: "maintainer", text: "Clean up merged tickets", from: "overwatch", slug: "acme/api", run: s.run, now });
  const m = maintainer({ db: s.db, run: s.run, now, name: "acme", home: s.home });
  expect(m).toEqual({ terminal: "t1", started: true });
  const argv = s.calls.find((c) => c[1] === "run")!;
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(s.home);
  expect(argv).toContain("FACTORY_AGENT=maintainer");
  expect(argv[argv.indexOf("--add-dir") + 1]).toBe(s.repo);
  // Its settings carry the guard that refuses commits, pushes and PRs (guard.ts).
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings.skipAutoPermissionPrompt).toBe(true);
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("--local");
  // And the status line that saves the plan reading, so the meters stay fresh while it runs (planline.ts).
  expect(settings.statusLine.command).toContain("planline.ts");
  expect(settings.statusLine.command).toContain("plan.json");
  const brief = argv.at(-1)!;
  expect(brief).toContain("You maintain this factory");
  expect(brief).toContain(`Note #${first.ask.id} from overwatch: Clean up merged tickets.`);
  expect(brief).toContain("factory asks done");
  expect(openAsks(s.db, "maintainer")[0].delivered_at).toBe(now); // given in the brief: never typed in again
  expect(JSON.parse(readFileSync(stateFile(s.home, "maintainer"), "utf8"))).toEqual({ terminal: "t1", started_at: now });
  // Live: a new request is typed into its terminal at once.
  const live = (agent: string) => (agent === "maintainer" ? "t1" : null);
  const next = ask(s.db, { to: "maintainer", text: "Raise max_running to 3", from: "you", slug: "acme/api", run: s.run, now, live });
  expect(next.delivered).toBe(true);
  expect(s.calls.find((c) => c[1] === "send")).toEqual(["hc", "send", "t1", expect.stringContaining("Raise max_running to 3")]);
  // Asked again: the same live one.
  expect(maintainer({ db: s.db, run: s.run, now, home: s.home })).toEqual({ terminal: "t1", started: false });
});

test("the maintainer's brief says the factory is local, edited in place with backups, and never committed", () => {
  const brief = maintainerBrief({ home: "/h", factories: [{ name: "a", dir: "/h/a", repos: [{ slug: "a/b", path: "/r", lead: true }] }], neighbours: "MAP" });
  expect(brief.startsWith("MAP\n\n")).toBe(true);
  expect(brief).toContain("- a: a/b (/r, lead); data /h/a");
  expect(brief).toContain("edit them in\nplace: there is no ticket, no worktree, no PR and nothing to merge");
  expect(brief).toContain("factory backup <file>");
  expect(brief).toContain("Never `git commit`, `git push` or `gh pr`");
  expect(brief).not.toContain("Requests waiting for you"); // none waiting: the heading goes too
});

test("a backup goes under FACTORY_HOME/backups/<when>/, and restore puts it back, backing up what was there", () => {
  const s = setup();
  const file = join(s.repo, ".factory/factory.yaml");
  const b = backup(file, now)!;
  expect(b).toBe(join(s.home, "backups", "20261123100000000", file.slice(1)));
  expect(readFileSync(b, "utf8")).toBe("name: t\nquality_floor: [\"true\"]\n");
  expect(backup(join(s.repo, "nope.yaml"), now)).toBeNull();
  writeFileSync(file, "name: t\nmax_running: 9\n");
  const r = restore(b, "2026-11-23T11:00:00Z");
  expect(r.file).toBe(file);
  expect(readFileSync(file, "utf8")).toBe("name: t\nquality_floor: [\"true\"]\n");
  expect(readFileSync(r.was!, "utf8")).toBe("name: t\nmax_running: 9\n");
  expect([...backupsByFile().get(file)!].map((x) => x.at)).toEqual(["20261123110000000", "20261123100000000"]);
  expect(() => restore(join(s.repo, "x"), now)).toThrow("isn't a backup");
  // No stray copy lands in the repo's .factory/, so validate still passes.
  expect(existsSync(`${file}.bak`)).toBe(false);
});

test("factory backup and factory restore from the CLI", () => {
  const s = setup();
  const file = join(s.repo, ".factory/factory.yaml");
  const out: string[] = [];
  main(["backup", file], (l) => out.push(l));
  expect(out[0]).toContain(`${file} → ${join(s.home, "backups")}`);
  const b = out[0].split(" → ")[1].split(" ")[0];
  writeFileSync(file, "broken");
  main(["restore", b], (l) => out.push(l));
  expect(readFileSync(file, "utf8")).toBe("name: t\nquality_floor: [\"true\"]\n");
});

test("an old request still a ticket on the retired blueprint is closed with a note; its data stays", () => {
  const s = setup();
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (7, 'Raise the budget', 'running', 'factory', ?)").run(now);
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (8, 'Old one', 'merged', 'factory', ?)").run(now);
  s.db.query("INSERT INTO asks (from_agent, to_agent, text, request, at) VALUES ('you', 'maintainer', 'Raise the budget', 7, ?)").run(now);
  expect(closeRetiredRequests(s.db, { run: s.run, now })).toEqual([7]);
  expect(s.db.query("SELECT state FROM tickets WHERE id = 7").get()).toEqual({ state: "closed" });
  expect((s.db.query("SELECT why FROM decisions WHERE ticket = 7 ORDER BY id DESC").get() as any).why).toContain("requests no longer run as tickets");
  expect(s.db.query("SELECT COUNT(*) AS n FROM asks WHERE request = 7").get()).toEqual({ n: 1 });
  expect(openAsks(s.db, "maintainer")).toEqual([]); // the old row is no note
  expect(closeRetiredRequests(s.db, { run: s.run, now })).toEqual([]); // once
});

// ---- the learner's requests, as notes

test("an override that held for learn.promote_after merged tickets becomes one request from the learner, with its evidence", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\nlearn:\n  target: cost_per_pr\n  tunable: [agents.reviewer.model]\n  promote_after: 3\n");
  setOverride(s.db, { key: "agents.reviewer.model", value: "claude-haiku-5", reason: "cheaper, same verdicts", tunable: ["agents.reviewer.model"], now });
  const ticketWith = (id: number, settings: object, usd: number) => {
    s.db.query("INSERT INTO tickets (id, title, state, blueprint, settings, updated_at) VALUES (?, 'x', 'merged', 'feature', ?, ?)").run(id, JSON.stringify(settings), now);
    s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, ?, ?, 'm', 1, 0, 0, 0, 1, ?)").run(`m${id}`, id, now, usd);
  };
  ticketWith(1, {}, 3); ticketWith(2, {}, 5);
  ticketWith(3, { "agents.reviewer.model": "claude-haiku-5" }, 1);
  ticketWith(4, { "agents.reviewer.model": "claude-haiku-5" }, 2);
  const o = { repo: s.repo, slug: "acme/api", run: s.run, now };
  expect(promoteOverrides(s.db, o)).toEqual([]); // two tickets: not yet
  ticketWith(5, { "agents.reviewer.model": "claude-haiku-5" }, 3);
  const [r] = promoteOverrides(s.db, o);
  expect(r.title).toBe('Make agents.reviewer.model = "claude-haiku-5" permanent (override #1, held for 3 tickets)');
  const [note] = openAsks(s.db, "maintainer");
  expect(note).toMatchObject({ id: r.id, from: "learner" });
  expect(note.why).toContain("Metric (learn.target): cost_per_pr. Before: $4.00 over 2 tickets. After: $2.00 over 3 tickets.");
  expect(note.why).toContain("Held for 3 merged tickets");
  expect(s.db.query("SELECT COUNT(*) AS n FROM tickets WHERE blueprint = 'factory'").get()).toEqual({ n: 0 });
  // No second request for it, while it's open or after it's handled.
  ticketWith(6, { "agents.reviewer.model": "claude-haiku-5" }, 1);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  s.db.query("UPDATE asks SET done_at = ? WHERE id = ?").run(now, r.id);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  // A new override for the same setting may be promoted on its own evidence, but not while one is open.
  setOverride(s.db, { key: "agents.reviewer.model", value: "claude-sonnet-5-5", tunable: ["agents.reviewer.model"], now });
  for (const id of [7, 8, 9]) ticketWith(id, { "agents.reviewer.model": "claude-sonnet-5-5" }, 2);
  s.db.query("UPDATE asks SET done_at = NULL WHERE id = ?").run(r.id);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  s.db.query("UPDATE asks SET done_at = ? WHERE id = ?").run(now, r.id);
  expect(promoteOverrides(s.db, o).map((x) => x.title)).toEqual(['Make agents.reviewer.model = "claude-sonnet-5-5" permanent (override #2, held for 3 tickets)']);
});

test("a lesson loaded into many briefs, and a suggestion outside the tunables, become learner requests once each", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\nlearn:\n  promote_after: 2\n");
  const { id: lesson } = addLesson(s.db, { area: "src/auth/**", text: "rotate the session id after login", now });
  s.db.query("UPDATE lessons SET hits = 2 WHERE id = ?").run(lesson);
  const o = { repo: s.repo, slug: "acme/api", run: s.run, now };
  const [r] = promoteOverrides(s.db, o);
  expect(r.title).toBe(`Turn lesson #${lesson} (src/auth/**) into a lint rule or test`);
  expect(openAsks(s.db, "maintainer")[0].why).toContain("Loaded into 2 ticket briefs");
  expect(promoteOverrides(s.db, o)).toEqual([]);

  expect(() => learnerSuggest(s.db, { ...o, text: "Add a lint step", evidence: " " })).toThrow(/--why/);
  const a = learnerSuggest(s.db, { ...o, text: "Give the reviewer the diff stat first", evidence: "review_rounds_per_pr 2.1 → 1.4 on 12 tickets in a benchmark" })!;
  expect(openAsks(s.db, "maintainer").find((n) => n.id === a.id)).toMatchObject({ from: "learner" });
  expect(learnerSuggest(s.db, { ...o, text: "give the reviewer the diff-stat first!", evidence: "again" })).toBeNull();
  expect(getMeta(s.db, `learner:lesson:${lesson}`)).toBe(`note:${r.id}`);
});

test("a learner key filed as a ticket before stays filed while that ticket is open", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\nlearn:\n  promote_after: 2\n");
  const { id: lesson } = addLesson(s.db, { area: "src/**", text: "x", now });
  s.db.query("UPDATE lessons SET hits = 2 WHERE id = ?").run(lesson);
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (40, 'old', 'closed', 'factory', ?)").run(now);
  s.db.query("INSERT INTO meta (key, value) VALUES (?, '40')").run(`learner:lesson:${lesson}`);
  expect(promoteOverrides(s.db, { repo: s.repo, slug: "acme/api", run: s.run, now })).toEqual([]); // `ever`: a finished one counts
});
