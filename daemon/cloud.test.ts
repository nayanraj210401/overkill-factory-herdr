import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setMeta, setRepo } from "./db.ts";
import { pause, sh, startTicket, type Run } from "./runner.ts";
import { parseResult, toCloud, toLocal } from "./cloud.ts";

function setup(yaml = 'name: t\nquality_floor: ["npm test"]\nready: [evidence, template]\n') {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), yaml);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  let n = 0;
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: `{"address":"t${++n}"}` }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run });
  mkdirSync(join(dir, "tickets/7"), { recursive: true });
  writeFileSync(join(dir, "tickets/7/REVIEW.md"), "# REVIEW\n\n## Sent back by you\n\nUse 429.\n");
  const ticket = () => db.query("SELECT * FROM ticket_lead WHERE id = 7").get() as any;
  return { db, dir, repo, origin, run, calls, ticket };
}

test("⇧C commits the work with a handoff pack, pushes, and starts claude --cloud; the factory stops watching", () => {
  const { db, dir, repo, origin, run, calls, ticket } = setup();
  const wt = ticket().worktree;
  writeFileSync(join(wt, "limit.ts"), "export const MAX = 5;\n"); // work in progress
  const r = toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  expect(r).toMatchObject({ stage: "spec" });
  expect(calls.find((c) => c[1] === "kill")).toEqual(["hc", "kill", "t1"]); // the local agent stopped
  const launched = calls.at(-1)!;
  expect(launched.slice(launched.indexOf("claude"))).toEqual(["claude", "--cloud", "Continue the work described in .factory-run/7/CLOUD.md on branch factory/7-rate-limit-login.", "-n", "factory #7 Rate-limit login"]);
  expect(ticket()).toMatchObject({ state: "running", location: "cloud", detail: "in a cloud session" });
  // On the pushed branch: the work, the pack, the ticket's files.
  const show = (path: string) => sh(["git", "--git-dir", origin, "show", `factory/7-rate-limit-login:${path}`]).out;
  expect(show("limit.ts")).toBe("export const MAX = 5;");
  expect(show(".factory-run/7/REVIEW.md")).toContain("Use 429.");
  const handoff = show(".factory-run/7/CLOUD.md");
  expect(handoff).toContain("Stage now: **spec**, run by the `spec-writer` agent");
  expect(handoff).toContain("Stages left after it: plan → implement → verify → holdout → review → pr → merge");
  expect(handoff).toContain("Quality floor, run before you stop: `npm test`");
  expect(handoff).toContain("Never push to main");
  expect(() => pause(db, { id: 7, run })).toThrow("#7 is in the cloud; bring it back first");
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "x" })).toThrow("in the cloud already");
});

test("⇧L fast-forwards to the cloud's commits, imports RESULT.md, drops the pack, and resumes at the stage it reached", () => {
  const { db, dir, repo, origin, run, ticket } = setup();
  toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  // The cloud session: works on the branch, writes RESULT.md and PR.md, pushes.
  const cloud = mkdtempSync(join(tmpdir(), "cloud-"));
  sh(["git", "clone", "-q", "-b", "factory/7-rate-limit-login", origin, cloud]);
  writeFileSync(join(cloud, "limit.ts"), "export const MAX = 5; // per user id\n");
  writeFileSync(join(cloud, ".factory-run/7/RESULT.md"), "Stage: implement\n\n## Evidence\n- PASS npm test: 14 tests\n- FAIL C2 returns 429: still 403\n\n## Notes\nKeyed on user id.\n\n## Questions\n");
  writeFileSync(join(cloud, ".factory-run/7/PR.md"), "Rate-limits login.\n");
  for (const c of [["add", "-A"], ["-c", "user.email=c@c", "-c", "user.name=c", "commit", "-q", "-m", "cloud work"], ["push", "-q"]]) sh(["git", "-C", cloud, ...c]);

  expect(toLocal(db, { dir, repo, id: 7, run, now: "2026-11-21T12:00:00Z" })).toMatchObject({ stage: "implement" });
  const wt = ticket().worktree;
  expect(ticket()).toMatchObject({ location: "local", state: "running", stage: "implement" });
  expect(readFileSync(join(wt, "limit.ts"), "utf8")).toContain("per user id");
  expect(existsSync(join(wt, ".factory-run"))).toBe(false);
  expect(sh(["git", "-C", wt, "log", "-1", "--format=%s"]).out).toBe("factory: #7 back from the cloud");
  expect(readFileSync(join(dir, "tickets/7/HANDOFF.md"), "utf8")).toContain("Keyed on user id.");
  expect(readFileSync(join(dir, "tickets/7/PR.md"), "utf8")).toBe("Rate-limits login.\n");
  expect(db.query("SELECT check_name, result FROM evidence ORDER BY id").all()).toEqual([
    { check_name: "npm test", result: "PASS" }, { check_name: "C2 returns 429", result: "FAIL" }]);
  expect(() => toLocal(db, { dir, repo, id: 7, run, now: "x" })).toThrow("#7 isn't in the cloud");
});

test("questions from the cloud park the ticket; min_agreement in factory.yaml keeps tickets local", () => {
  expect(parseResult("Stage: pr\n## Evidence\n## Questions\nWhich plans get it?\n").questions).toBe("Which plans get it?");
  const { db, dir, repo, run } = setup('name: t\nready: [evidence]\naway: { min_agreement: 0.85 }\n');
  expect(() => toCloud(db, { dir, repo, id: 7, run, now: "x" })).toThrow("away.min_agreement is set");
});
