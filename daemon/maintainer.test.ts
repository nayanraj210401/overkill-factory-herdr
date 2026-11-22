import { test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, loadAgent, loadBlueprint, sh, startTicket, type Run } from "./runner.ts";
import { request } from "./maintainer.ts";

const now = "2026-11-22T10:00:00Z";

// A factory whose .factory/ has no maintainer files of its own: the shipped ones apply.
function setup(factoryYaml = "name: t\nquality_floor: [\"true\"]\n") {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  rmSync(join(repo, ".factory/blueprints/factory.yaml"));
  rmSync(join(repo, ".factory/agents/maintainer.md"));
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
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? { code: 0, out: `{"address":"t${++term}"}` } : argv[0] === "gh" ? (argv[1] === "pr" && argv[2] === "create" ? { code: 0, out: "https://github.com/acme/api/pull/9" } : { code: 1, out: "gh is stubbed" }) : sh(argv, cwd));
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
  return { db, dir, repo, run, ticket, commit, finish };
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
