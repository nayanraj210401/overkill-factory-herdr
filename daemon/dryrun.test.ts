import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { main, paths } from "./cli.ts";
import { dryRun, dryRunMarkdown, loadDraft, plan, recordedTickets, replay, type Graph } from "./dryrun.ts";

const g = (stages: Graph["stages"], start = "spec"): Graph => ({ name: "feature", orchestrator: "foreman", start, stages });
const full = g({
  spec: { next: ["plan", "implement"] }, plan: { next: ["implement"] }, implement: { next: ["verify"] },
  verify: { next: ["review"], on_fail: "implement", max_retries: 2 }, review: { next: ["merge"], on_fail: "implement" }, merge: { next: ["end"] },
});
const ticket = (path: string[], choices: { at: string; to: string }[] = []) => ({ id: 1, title: "t", path, choices: choices.map((c) => ({ ...c, by: "foreman" })) });

test("a ticket the draft still allows walks to the end", () => {
  const r = replay(full, ticket(["spec", "implement", "verify", "review", "merge"]));
  expect(r).toMatchObject({ visited: ["spec", "implement", "verify", "review", "merge"], ending: "ends", removed: [], added: [] });
});

test("a removed stage: the walk stops where the old run went through it and names the draft's route", () => {
  const { verify: _gone, ...rest } = full.stages;
  const draft = g({ ...rest, implement: { next: ["review"] } });
  const r = replay(draft, ticket(["spec", "implement", "verify", "review", "merge"]));
  expect(r.removed).toEqual(["verify"]);
  expect(r).toMatchObject({ ending: "diverges", visited: ["spec", "implement"] });
  expect(r.notes[0]).toContain("implement → verify no longer holds: the draft has no verify stage; it goes to review");
});

test("an added stage shows up after the last recorded one, and between two when the old edge is gone", () => {
  const tail = g({ ...full.stages, merge: { next: ["announce"] }, announce: { next: ["end"] } });
  expect(replay(tail, ticket(["spec", "implement", "verify", "review", "merge"]))).toMatchObject({ ending: "diverges", added: ["announce"] });
  const mid = g({ ...full.stages, verify: { next: ["security"], on_fail: "implement" }, security: { next: ["review"] } });
  const r = replay(mid, ticket(["spec", "implement", "verify", "review", "merge"]));
  expect(r.added).toEqual(["security"]);
  expect(r.notes.join("\n")).toContain("from there the draft would run security → review → merge");
});

test("an orchestrator choice still valid is reused; one that is gone would ask the orchestrator", () => {
  const path = ["spec", "plan", "implement", "verify", "review", "merge"];
  const kept = replay(full, ticket(path, [{ at: "spec", to: "plan" }]));
  expect(kept.ending).toBe("ends");
  expect(kept.notes).toContain("spec → plan: the old orchestrator choice still exists, reused");
  const gone = g({ ...full.stages, spec: { next: ["implement", "research"] }, research: { next: ["implement"] } });
  const r = replay(gone, ticket(path, [{ at: "spec", to: "plan" }]));
  expect(r.ending).toBe("diverges");
  expect(r.notes[0]).toContain("the old orchestrator choice is gone: would ask the foreman agent: spec can go to implement or research");
});

test("a failure loop is followed, and parks once it passes max_retries", () => {
  const loop = ["spec", "implement", "verify", "implement", "verify", "review", "merge"];
  expect(replay(full, ticket(loop)).notes).toContain("verify fails back to implement (loop 1)");
  const three = ["spec", "implement", ...Array(3).fill(["verify", "implement"]).flat(), "verify", "review", "merge"];
  const r = replay(full, ticket(three));
  expect(r).toMatchObject({ ending: "parks" });
  expect(r.notes.at(-1)).toBe("verify failed 3 times, past max_retries 2: the ticket would park");
});

test("an invalid draft fails clearly, before any replay", () => {
  expect(() => loadDraft("name: x\nstart: a\nstages:\n  a: { agent: b, nxt: [c] }\n")).toThrow(/invalid.*nxt: unknown key/s);
  expect(() => loadDraft("name: x\nstart: a\nstages:\n  a: { agent: b, next: [ghost] }\n")).toThrow(/stages\.a\.next: no stage "ghost"/);
  expect(() => loadDraft("name: x\nstart: nope\nstages:\n  a: { agent: b, next: [end] }\n")).toThrow(/start: no stage "nope"/);
  expect(loadDraft("name: x\nstart: a\nstages:\n  a: { agent: b, next: [end] }\n").start).toBe("a");
});

test("tickets come from SQLite: the last N merged on the blueprint, their stage rows and orchestrator choices", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "dry-")), "factory.db"));
  const t = (id: number, state: string, bp = "feature") => db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, `ticket ${id}`, state, bp, `2026-11-2${id}T10:00:00Z`);
  t(1, "merged"); t(2, "merged"); t(3, "running"); t(4, "merged", "chore");
  const stage = (id: number, ...names: string[]) => names.forEach((n, i) => db.query("INSERT INTO stages (ticket, name, started_at) VALUES (?, ?, ?)").run(id, n, `2026-11-20T0${i}:00:00Z`));
  stage(1, "Groom", "Spec", "Implement"); stage(2, "Groom", "Spec", "Plan", "Plan", "Implement", "PR", "Merge");
  const dec = (id: number, who: string, what: string) => db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, 'x')").run(id, who, what);
  dec(2, "foreman", "chose plan after spec"); dec(1, "daemon", "chose plan after spec");
  const rec = recordedTickets(db, "feature", 5);
  expect(rec.map((r) => r.id)).toEqual([2, 1]);
  expect(rec[0].path).toEqual(["spec", "plan", "implement", "pr", "merge"]);
  expect(rec[0].choices).toEqual([{ at: "spec", to: "plan", by: "foreman" }]);
  expect(rec[1].choices).toEqual([]); // the daemon's default isn't the orchestrator's choice
  expect(recordedTickets(db, "feature", 1).map((r) => r.id)).toEqual([2]);
  const d = dryRun(db, loadDraft("name: feature\nstart: spec\nstages:\n  spec: { agent: a, next: [plan, implement] }\n  plan: { agent: a, next: [implement] }\n  implement: { agent: a, next: [merge] }\n  merge: { gate: human, next: [end] }\n"), 5);
  expect(d.removed).toEqual(["pr"]);
  expect(dryRunMarkdown(d)).toContain("Stages the old runs had that the draft lacks: `pr`");
  expect(dryRun(db, { ...full, name: "none" }).skipped).toContain("nothing to replay");
  expect(plan(full, "spec")).toEqual(["spec", "plan", "implement", "verify", "review", "merge"]);
});

test("factory dry-run reads a draft file, replays, prints JSON and writes DRYRUN.md; a bad draft fails with its errors", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "dry"], (s: string) => out.push(s));
  run("init", "--repo", "acme/api", "--path", join(import.meta.dir, "../fixtures/acme-api"));
  const db = open(paths("dry").db);
  db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (1, 'Bump', 'merged', 'chore', 'x')").run();
  ["Groom", "Implement", "Verify", "PR", "Merge"].forEach((n, i) => db.query("INSERT INTO stages (ticket, name, started_at) VALUES (1, ?, ?)").run(n, `2026-11-20T0${i}:00:00Z`));
  db.close();
  const here = process.cwd();
  const work = mkdtempSync(join(tmpdir(), "dry-cwd-"));
  const draft = join(work, "chore.yaml");
  writeFileSync(draft, "name: chore\nstart: implement\nstages:\n  implement: { agent: builder, next: [pr] }\n  pr: { agent: pr-writer, next: [merge] }\n  merge: { gate: human, next: [end] }\n");
  process.chdir(work);
  try {
    run("dry-run", draft, "--tickets", "2", "--json");
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ blueprint: "chore", removed: ["verify"], replayed: [{ ticket: 1, ending: "diverges" }] });
    expect(readFileSync(join(work, "DRYRUN.md"), "utf8")).toContain("#1 Bump");
    writeFileSync(draft, "name: chore\nstart: implement\nstages:\n  implement: { agent: builder, next: [ghost] }\n");
    expect(() => run("dry-run", draft)).toThrow(/invalid.*no stage "ghost"/s);
    expect(() => run("dry-run", draft, "--tickets", "0")).toThrow(/whole number/);
  } finally { process.chdir(here); }
});
