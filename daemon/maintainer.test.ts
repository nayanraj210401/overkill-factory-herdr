import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, loadBlueprint, mergeTicket, sh, startTicket, type Run } from "./runner.ts";
import { loadAgent } from "./agents.ts";
import { ACCOUNT_PROPOSAL, applyMerged, proposeAccount, proposeExample, request } from "./maintainer.ts";
import { examplesDir, installExamples } from "./agents.ts";
import { learnerSuggest, promoteOverrides } from "./learner.ts";
import { addLesson, setOverride } from "./learn.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { getMeta } from "./db.ts";

// After the worktree commits the tests make: the ready rules reject evidence older than the last commit.
const now = new Date(Date.now() + 60_000).toISOString();

// A factory whose .factory/ has no factory blueprint of its own: the shipped one applies (the maintainer agent is a factory agent).
function setup(factoryYaml = "name: t\nquality_floor: [\"true\"]\n") {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "home-")); // the account config lives here, never in ~/.factory
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  rmSync(join(repo, ".factory/blueprints/factory.yaml"));
  writeFileSync(join(repo, ".factory/factory.yaml"), factoryYaml);
  writeFileSync(join(repo, "app.ts"), "export {};\n");
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  sh(["git", "-C", repo, "remote", "add", "origin", origin]);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  let term = 0;
  const bodies: string[] = []; // each PR body the daemon opened
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: `{"address":"t${++term}"}` } : argv[0] === "gh" ? (argv[1] === "pr" && ["ready", "merge"].includes(argv[2]) ? { code: 0, out: "" } : argv[1] === "pr" && argv[2] === "create" ? (bodies.push(readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8")), { code: 0, out: "https://github.com/acme/api/pull/9" }) : { code: 1, out: "gh is stubbed" }) : sh(argv, cwd));
  const ticket = (id: number) => db.query("SELECT * FROM ticket_lead WHERE id = ?").get(id) as any;
  const commit = (wt: string, file: string, text: string) => {
    writeFileSync(join(wt, file), text);
    sh(["git", "-C", wt, "add", "-A"]);
    sh(["git", "-C", wt, "commit", "-q", "-m", "change"]);
  };
  // The maintainer's turn is over: the factory check runs on what it left.
  const finish = (id: number) => {
    writeFileSync(join(dir, "tickets", String(id), "PR.md"), "Raises the day's budget.\n\n## What changed\n- x\n## Why\nx\n## How it was verified\nx\n## Risk\nLow.\n");
    return advance(db, { dir, repo, id, run, now });
  };
  return { db, dir, repo, run, ticket, commit, finish, bodies };
}

const evidence = (db: any, id: number) => db.query("SELECT check_name, result, detail FROM evidence WHERE ticket = ? ORDER BY id").all(id) as { check_name: string; result: string; detail: string }[];

test("a request is a ticket on the factory blueprint that skips grooming and waits for a slot", () => {
  const s = setup();
  const r = request(s.db, { text: "  Raise the day's budget\n to 60M input ", repo: "acme/api", run: s.run, now });
  expect(s.ticket(r.id)).toMatchObject({ title: "Raise the day's budget to 60M input", state: "queued", blueprint: "factory", trigger_name: "maintainer", groomed_at: now });
  expect(() => request(s.db, { text: "   ", repo: "acme/api", run: s.run, now })).toThrow(/say what to change/);
  expect(() => request(s.db, { text: "#412", repo: "acme/api", run: s.run, now })).toThrow(/not an issue link/);
});

test("a factory without its own maintainer files uses the shipped ones; maintainer.gate sets the merge gate", () => {
  const s = setup();
  expect(loadAgent(s.repo, "maintainer")?.role).toBe("maintain");
  expect(loadBlueprint(s.repo, "factory").stages.merge).toMatchObject({ gate: "human" });
  writeFileSync(join(s.repo, ".factory/factory.yaml"), "name: t\nmaintainer: { gate: auto }\n");
  expect(loadBlueprint(s.repo, "factory").stages.merge).toMatchObject({ gate: "auto" });
  // Only the maintainer's files ship: any other missing blueprint is still an error.
  rmSync(join(s.repo, ".factory/blueprints/chore.yaml"));
  expect(() => loadBlueprint(s.repo, "chore")).toThrow(/no blueprint "chore"/);
});

test("the factory check passes a valid .factory/ change, the PR opens and waits for you at merge", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Raise the day's budget", repo: "acme/api", run: s.run, now });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  expect(s.ticket(id).stage).toBe("maintain");
  s.commit(s.ticket(id).worktree, ".factory/factory.yaml", "name: t\nquality_floor: [\"true\"]\nbudget: { per_day: { input: 60M, output: 2M } }\n");
  s.finish(id);
  expect(evidence(s.db, id).slice(0, 2)).toMatchObject([{ check_name: "factory validate", result: "PASS" }, { check_name: "only .factory/", result: "PASS" }]);
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: 9 }); // the PR opened; the merge waits for you
});

test("the factory check sends the change back when it touches code or breaks the schema", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Add a lint step", repo: "acme/api", run: s.run, now });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const wt = s.ticket(id).worktree;
  writeFileSync(join(wt, "app.ts"), "export const x = 1;\n"); // uncommitted, outside .factory/
  s.finish(id);
  expect(evidence(s.db, id).find((e) => e.check_name === "only .factory/")).toMatchObject({ result: "FAIL", detail: "changed outside .factory/: app.ts" });
  expect(s.ticket(id)).toMatchObject({ stage: "maintain", state: "running" });

  sh(["git", "-C", wt, "checkout", "--", "app.ts"]);
  s.commit(wt, ".factory/factory.yaml", "name: t\nquality_floor: [\"true\"]\nmax_runing: 2\n");
  s.finish(id);
  expect(evidence(s.db, id).filter((e) => e.check_name === "factory validate").at(-1)).toMatchObject({ result: "FAIL" });
  expect(evidence(s.db, id).filter((e) => e.check_name === "factory validate").at(-1)!.detail).toContain("max_runing: unknown key");
  expect(s.ticket(id).stage).toBe("maintain");
});

test("a blueprint change gets a dry run: DRYRUN.md, an evidence row, and the PR body carries it", () => {
  const s = setup();
  // A merged ticket on the chore blueprint, with the stages it went through.
  s.db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (50, 'Fix a typo', 'merged', 'chore', ?)").run(now);
  ["Groom", "Implement", "Verify", "PR", "Merge"].forEach((n, i) => s.db.query("INSERT INTO stages (ticket, name, started_at) VALUES (50, ?, ?)").run(n, `2026-11-20T0${i}:00:00Z`));
  const { id } = request(s.db, { text: "Drop the verify stage from chore", repo: "acme/api", run: s.run, now });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const chore = readFileSync(join(s.repo, ".factory/blueprints/chore.yaml"), "utf8");
  expect(chore).toContain("verify");
  s.commit(s.ticket(id).worktree, ".factory/blueprints/chore.yaml", "name: chore\nstart: implement\nstages:\n  implement: { agent: builder, next: [pr] }\n  pr: { requires: ready, output: PR.md, template: pr-readable, next: [merge] }\n  merge: { gate: human, next: [end] }\n");
  s.finish(id);
  const dry = join(s.dir, "tickets", String(id), "DRYRUN.md");
  expect(readFileSync(dry, "utf8")).toContain("Stages the old runs had that the draft lacks: `verify`");
  expect(evidence(s.db, id).find((e) => e.check_name === "blueprint dry run")).toMatchObject({ result: "PASS" });
  expect(s.bodies[0]).toContain("## Dry run: the `chore` blueprint");
  expect(s.bodies[0]).toContain("**Ready rules**");
});

test("a change that touches no blueprint writes no DRYRUN.md", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Raise the day's budget", repo: "acme/api", run: s.run, now });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  s.commit(s.ticket(id).worktree, ".factory/factory.yaml", "name: t\nquality_floor: [\"true\"]\nmax_running: 3\n");
  s.finish(id);
  expect(existsSync(join(s.dir, "tickets", String(id), "DRYRUN.md"))).toBe(false);
  expect(s.bodies[0]).not.toContain("Dry run");
});

// ---- the account config: proposed in the ticket's folder, checked, shown, applied on merge

const accountPath = () => join(process.env.FACTORY_HOME!, "config.yaml");
const BEFORE = "# mine\nplan: { pause_at: 85% }\n";

test("an account config change is checked, its diff rides on the PR, and it applies only when the PR merges, with a backup", () => {
  const s = setup();
  writeFileSync(accountPath(), BEFORE);
  const { id } = request(s.db, { text: "Add 'small diffs' to my taste and raise max_running", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  const copy = proposeAccount(s.dir, id);
  expect(readFileSync(copy, "utf8")).toBe(BEFORE); // the maintainer starts from the file as it is
  writeFileSync(copy, BEFORE + "profile: { taste: [small diffs over clever ones] }\n");
  s.commit(s.ticket(id).worktree, ".factory/factory.yaml", "name: t\nquality_floor: [\"true\"]\nmax_running: 4\n");
  s.finish(id);
  expect(evidence(s.db, id).find((e) => e.check_name === "account config")).toMatchObject({ result: "PASS" });
  expect(evidence(s.db, id).find((e) => e.check_name === "only .factory/")).toMatchObject({ result: "PASS" }); // the proposal isn't a repo file
  expect(s.bodies[0]).toContain("## The account config (~/.factory/config.yaml)");
  expect(s.bodies[0]).toContain("+profile: { taste: [small diffs over clever ones] }");
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: 9 });
  // Waiting at the gate, nothing is applied, however often the daemon looks.
  applyMerged(s.db, { dir: s.dir, run: s.run, now });
  expect(readFileSync(accountPath(), "utf8")).toBe(BEFORE);
  // You merge: the checked copy is written, the old file kept beside it; a second pass does nothing.
  mergeTicket(s.db, { repo: s.repo, id, run: s.run, now, dir: s.dir });
  const log: string[] = [];
  applyMerged(s.db, { dir: s.dir, run: s.run, now, log: (l) => log.push(l) });
  expect(readFileSync(accountPath(), "utf8")).toContain("small diffs over clever ones");
  const backups = readdirSync(process.env.FACTORY_HOME!).filter((f) => f.startsWith("config.yaml.bak-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(process.env.FACTORY_HOME!, backups[0]), "utf8")).toBe(BEFORE);
  expect(log[0]).toContain("applied the account config");
  applyMerged(s.db, { dir: s.dir, run: s.run, now, log: (l) => log.push(l) });
  expect(log).toHaveLength(1);
  expect(readdirSync(process.env.FACTORY_HOME!).filter((f) => f.startsWith("config.yaml.bak-"))).toHaveLength(1);
});

test("the example library changes like the factory agents: a proposed copy, checked, applied only on merge; an emptied one removes the example", () => {
  const s = setup();
  installExamples();
  const lib = examplesDir();
  const { id } = request(s.db, { text: "Add a migrator example and drop the foreman one", kind: "agents", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  expect(() => proposeExample(s.dir, id, "migrator")).toThrow("--from");
  const added = proposeExample(s.dir, id, "migrator", "builder");
  expect(readFileSync(added, "utf8")).toBe(readFileSync(join(lib, "builder.md"), "utf8")); // started from the closest
  writeFileSync(added, readFileSync(added, "utf8").replace(/^territory: .*$/m, 'territory: "Database migrations, one per ticket"'));
  writeFileSync(proposeExample(s.dir, id, "foreman"), "");
  expect(() => proposeExample(s.dir, id, "maintainer")).toThrow("factory agents propose");
  s.finish(id);
  expect(evidence(s.db, id).find((e) => e.check_name === "example library")).toMatchObject({ result: "PASS" });
  expect(readFileSync(join(s.dir, "tickets", String(id), "EXAMPLES.md"), "utf8")).toContain("+territory: \"Database migrations, one per ticket\"");
  // Nothing outside the repo changes until the request merges.
  applyMerged(s.db, { dir: s.dir, run: s.run, now });
  expect(existsSync(join(lib, "migrator.md"))).toBe(false);
  expect(existsSync(join(lib, "foreman.md"))).toBe(true);
  mergeTicket(s.db, { repo: s.repo, id, run: s.run, now, dir: s.dir });
  applyMerged(s.db, { dir: s.dir, run: s.run, now });
  expect(readFileSync(join(lib, "migrator.md"), "utf8")).toContain("Database migrations");
  expect(existsSync(join(lib, "foreman.md"))).toBe(false);
  expect(readdirSync(lib).filter((f) => f.startsWith("foreman.md.bak-"))).toHaveLength(1); // kept beside it
  // A bad copy fails the check.
  const two = request(s.db, { text: "Break an example", kind: "agents", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id: two.id, run: s.run, now });
  writeFileSync(proposeExample(s.dir, two.id, "planner"), "---\nrole: plan\ncolour: blue\n---\nx\n");
  s.finish(two.id);
  expect(evidence(s.db, two.id).find((e) => e.check_name === "example library")).toMatchObject({ result: "FAIL" });
});

test("a bad account config proposal fails the factory check and goes back to the maintainer", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Pause at 90%", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  writeFileSync(proposeAccount(s.dir, id), "plan: { pause_at: 90% }\nprofle: { rules: [x] }\n");
  s.finish(id);
  expect(evidence(s.db, id).find((e) => e.check_name === "account config")).toMatchObject({ result: "FAIL" });
  expect(evidence(s.db, id).find((e) => e.check_name === "account config")!.detail).toContain("profle");
  expect(s.ticket(id)).toMatchObject({ stage: "maintain", state: "running" });
  expect(existsSync(accountPath())).toBe(false);
});

test("an account-only request opens no PR: it waits at the merge gate, and m applies it", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Never push to main, in every factory", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  writeFileSync(proposeAccount(s.dir, id), "profile: { rules: [never push to main] }\n");
  s.finish(id);
  expect(s.bodies).toHaveLength(0);
  expect(s.ticket(id)).toMatchObject({ stage: "merge", state: "ready", pr_number: null });
  expect(existsSync(join(s.dir, "tickets", String(id), "ACCOUNT-CONFIG.md"))).toBe(true);
  expect(existsSync(accountPath())).toBe(false);
  expect(mergeTicket(s.db, { repo: s.repo, id, run: s.run, now, dir: s.dir })).toMatchObject({ pr: null });
  applyMerged(s.db, { dir: s.dir, run: s.run, now });
  expect(readFileSync(accountPath(), "utf8")).toBe("profile: { rules: [never push to main] }\n");
  expect(s.ticket(id).state).toBe("merged");
});

test("an account config someone changed after the check is left alone", () => {
  const s = setup();
  writeFileSync(accountPath(), BEFORE);
  const { id } = request(s.db, { text: "Pause at 90%", repo: "acme/api", run: s.run, now, dir: s.dir });
  startTicket(s.db, { dir: s.dir, repo: s.repo, id, run: s.run, now });
  writeFileSync(proposeAccount(s.dir, id), "plan: { pause_at: 90% }\n");
  s.finish(id);
  writeFileSync(accountPath(), BEFORE + "cloud: { on_sleep: off }\n"); // your own edit, meanwhile
  mergeTicket(s.db, { repo: s.repo, id, run: s.run, now, dir: s.dir });
  const log: string[] = [];
  applyMerged(s.db, { dir: s.dir, run: s.run, now, log: (l) => log.push(l) });
  expect(readFileSync(accountPath(), "utf8")).toBe(BEFORE + "cloud: { on_sleep: off }\n");
  expect(log[0]).toContain("changed after the check; nothing was applied");
  expect(s.db.query("SELECT what FROM decisions WHERE ticket = ? AND who = 'daemon' ORDER BY id DESC LIMIT 1").get(id)).toEqual({ what: "account config not applied" });
});

// ---- the learner files maintainer requests

test("an override that held for learn.promote_after merged tickets becomes one learner request, with its evidence", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\nlearn:\n  target: cost_per_pr\n  tunable: [agents.reviewer.model]\n  promote_after: 3\n");
  setOverride(s.db, { key: "agents.reviewer.model", value: "claude-haiku-5", reason: "cheaper, same verdicts", tunable: ["agents.reviewer.model"], now });
  const ticketWith = (id: number, settings: object, usd: number) => {
    s.db.query("INSERT INTO tickets (id, title, state, blueprint, settings, updated_at) VALUES (?, 'x', 'merged', 'feature', ?, ?)").run(id, JSON.stringify(settings), now);
    s.db.query("INSERT INTO usage (message_id, ticket, at, model, input, cache_write_5m, cache_write_1h, cache_read, output, usd) VALUES (?, ?, ?, 'm', 1, 0, 0, 0, 1, ?)").run(`m${id}`, id, now, usd);
  };
  ticketWith(1, {}, 3); ticketWith(2, {}, 5);
  ticketWith(3, { "agents.reviewer.model": "claude-haiku-5" }, 1);
  ticketWith(4, { "agents.reviewer.model": "claude-haiku-5" }, 2);
  const o = { dir: s.dir, repo: s.repo, slug: "acme/api", run: s.run, now };
  expect(promoteOverrides(s.db, o)).toEqual([]); // two tickets: not yet
  ticketWith(5, { "agents.reviewer.model": "claude-haiku-5" }, 3);
  const [r] = promoteOverrides(s.db, o);
  expect(r.title).toBe('Make agents.reviewer.model = "claude-haiku-5" permanent (override #1, held for 3 tickets)');
  expect(s.ticket(r.id)).toMatchObject({ blueprint: "factory", state: "queued", trigger_name: "learner" });
  const md = readFileSync(join(s.dir, "tickets", String(r.id), "REQUEST.md"), "utf8");
  expect(md).toContain("From: the learner");
  expect(md).toContain("Metric (learn.target): cost_per_pr. Before: $4.00 over 2 tickets. After: $2.00 over 3 tickets.");
  expect(md).toContain("Held for 3 merged tickets");
  expect(s.db.query("SELECT who FROM decisions WHERE ticket = ? ORDER BY id").all(r.id)).toEqual([{ who: "learner" }, { who: "learner" }]);
  // Config's Pending changes says who asked.
  const status = buildStatus(s.db);
  expect(validateStatus(status)).toEqual([]);
  expect(status.tickets.find((t: any) => t.id === r.id)).toMatchObject({ requested_by: "learner" });
  // No second request for it, while it's open or after.
  ticketWith(6, { "agents.reviewer.model": "claude-haiku-5" }, 1);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  s.db.query("UPDATE tickets SET state = 'closed' WHERE id = ?").run(r.id);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  // A new override for the same setting may be promoted on its own evidence, but not while one is open.
  setOverride(s.db, { key: "agents.reviewer.model", value: "claude-sonnet-5-5", tunable: ["agents.reviewer.model"], now });
  for (const id of [7, 8, 9]) ticketWith(id, { "agents.reviewer.model": "claude-sonnet-5-5" }, 2);
  s.db.query("UPDATE tickets SET state = 'queued' WHERE id = ?").run(r.id);
  expect(promoteOverrides(s.db, o)).toEqual([]);
  s.db.query("UPDATE tickets SET state = 'merged' WHERE id = ?").run(r.id);
  expect(promoteOverrides(s.db, o).map((x) => x.title)).toEqual(['Make agents.reviewer.model = "claude-sonnet-5-5" permanent (override #2, held for 3 tickets)']);
});

test("a lesson loaded into many briefs, and a suggestion outside the tunables, become learner requests once each", () => {
  const s = setup("name: t\nquality_floor: [\"true\"]\nlearn:\n  promote_after: 2\n");
  const { id: lesson } = addLesson(s.db, { area: "src/auth/**", text: "rotate the session id after login", now });
  s.db.query("UPDATE lessons SET hits = 2 WHERE id = ?").run(lesson);
  const o = { dir: s.dir, repo: s.repo, slug: "acme/api", run: s.run, now };
  const [r] = promoteOverrides(s.db, o);
  expect(r.title).toBe(`Turn lesson #${lesson} (src/auth/**) into a lint rule or test`);
  expect(readFileSync(join(s.dir, "tickets", String(r.id), "REQUEST.md"), "utf8")).toContain("Loaded into 2 ticket briefs");
  expect(promoteOverrides(s.db, o)).toEqual([]);

  expect(() => learnerSuggest(s.db, { ...o, text: "Add a lint step", evidence: " " })).toThrow(/--why/);
  const a = learnerSuggest(s.db, { ...o, text: "Give the reviewer the diff stat first", evidence: "review_rounds_per_pr 2.1 → 1.4 on 12 tickets in a benchmark" })!;
  expect(s.ticket(a.id)).toMatchObject({ trigger_name: "learner" });
  expect(learnerSuggest(s.db, { ...o, text: "give the reviewer the diff-stat first!", evidence: "again" })).toBeNull();
  expect(getMeta(s.db, `learner:lesson:${lesson}`)).toBe(String(r.id));
});

test("a request from you says so on the ticket and in REQUEST.md", () => {
  const s = setup();
  const { id } = request(s.db, { text: "Raise the day's budget", repo: "acme/api", run: s.run, now, dir: s.dir });
  expect(readFileSync(join(s.dir, "tickets", String(id), "REQUEST.md"), "utf8")).toContain("From: you, in Overwatch");
  expect(buildStatus(s.db).tickets.find((t: any) => t.id === id)).toMatchObject({ requested_by: "you" });
  expect(buildStatus(s.db).tickets.find((t: any) => t.blueprint !== "factory")?.requested_by).toBeUndefined();
  expect(ACCOUNT_PROPOSAL).toBe("ACCOUNT-CONFIG.yaml");
});
