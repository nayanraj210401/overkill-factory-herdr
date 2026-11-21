import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, leadRepo, listRepos, open, repoOf, setRepo, setWork } from "./db.ts";
import { main, paths } from "./cli.ts";
import { buildStatus } from "./status.ts";
import { writeTicketFiles } from "./ticket.ts";

test("migration 11 moves a one-repo factory's repo and each ticket's work to the new tables", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mig-")), "factory.db");
  const old = new Database(path, { create: true, strict: true });
  for (const m of MIGRATIONS.slice(0, 10)) old.exec(m);
  old.exec("PRAGMA user_version = 10");
  old.exec(`INSERT INTO meta VALUES ('name', 'acme-api'), ('repo', 'acme/api'), ('repo_path', '/src/api');
    INSERT INTO tickets (id, title, state, worktree, branch, pr_number, pr_watched, pr_checked_at, updated_at) VALUES
      (1, 'merged one', 'merged', NULL, 'factory/1-a', 41, 0, '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z'),
      (2, 'ready one', 'ready', '/wt/2', 'factory/2-b', 42, 1, '2026-11-21T09:00:00Z', '2026-11-21T09:00:00Z'),
      (3, 'not started', 'queued', NULL, NULL, NULL, 0, NULL, '2026-11-21T09:00:00Z');`);
  old.close();

  const db = open(path);
  expect(listRepos(db)).toEqual([{ slug: "acme/api", path: "/src/api", lead: true }]);
  expect(db.query("SELECT * FROM ticket_repos ORDER BY ticket").all()).toEqual([
    { ticket: 1, repo: "acme/api", lead: 1, worktree: null, branch: "factory/1-a", pr_number: 41, pr_watched: 0, pr_checked_at: "2026-11-20T09:00:00Z", merged_at: "2026-11-20T10:00:00Z" },
    { ticket: 2, repo: "acme/api", lead: 1, worktree: "/wt/2", branch: "factory/2-b", pr_number: 42, pr_watched: 1, pr_checked_at: "2026-11-21T09:00:00Z", merged_at: null },
  ]);
  // The one-repo columns and meta keys are gone; the view reads as the old row did.
  const cols = (db.query("PRAGMA table_info(tickets)").all() as { name: string }[]).map((c) => c.name);
  expect(cols.filter((c) => ["worktree", "branch", "pr_number", "pr_watched", "pr_checked_at"].includes(c))).toEqual([]);
  expect(db.query("SELECT key FROM meta WHERE key IN ('repo', 'repo_path')").all()).toEqual([]);
  expect(db.query("SELECT id, worktree, pr_number, pr_watched FROM ticket_lead ORDER BY id").all()).toEqual([
    { id: 1, worktree: null, pr_number: 41, pr_watched: 0 }, { id: 2, worktree: "/wt/2", pr_number: 42, pr_watched: 1 }, { id: 3, worktree: null, pr_number: null, pr_watched: 0 },
  ]);
  expect(buildStatus(db).factory.repo).toBe("acme/api");
  expect(buildStatus(db).tickets.find((t: any) => t.id === 2)!.pr).toEqual({ number: 42, watched: true, checked_at: "2026-11-21T09:00:00Z" });
});

test("a ticket's first work row is made in the lead repo; the lead can't move once tickets worked in it", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "lead-")), "factory.db"));
  db.query("INSERT INTO tickets (id, title, updated_at) VALUES (7, 'x', '2026-11-21T09:00:00Z')").run();
  expect(() => setWork(db, 7, { branch: "b" })).toThrow("this factory has no repo");
  setRepo(db, { slug: "acme/old", path: "/src/old", lead: true });
  setRepo(db, { slug: "acme/api", path: "/src/api", lead: true }); // nothing worked in acme/old yet
  expect(listRepos(db)).toEqual([{ slug: "acme/api", path: "/src/api", lead: true }]);
  setWork(db, 7, { branch: "b" });
  setWork(db, 7, { pr_number: 9 });
  expect(db.query("SELECT ticket, repo, lead, branch, pr_number FROM ticket_repos").all()).toEqual([{ ticket: 7, repo: "acme/api", lead: 1, branch: "b", pr_number: 9 }]);
  setRepo(db, { slug: "acme/api", path: "/elsewhere/api", lead: true }); // a moved checkout is fine
  expect(leadRepo(db)!.path).toBe("/elsewhere/api");
  expect(() => setRepo(db, { slug: "acme/web", path: "/src/web", lead: true })).toThrow("tickets already worked in acme/api");
});

test("factory repo add records a checkout of a repo factory.yaml lists, and repoOf refuses one it stops listing", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const lead = mkdtempSync(join(tmpdir(), "api-"));
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(lead, ".factory"), { recursive: true });
  const web = mkdtempSync(join(tmpdir(), "web-"));
  mkdirSync(join(web, ".git"));
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], (s) => out.push(s));
  run("init", "--repo", "acme/api", "--path", lead);
  // The fixture lists only acme/api.
  expect(() => run("repo", "add", "acme/web", "--path", web)).toThrow("acme/web isn't in factory.yaml's repos: (acme/api); add it there first");
  const yaml = join(lead, ".factory/factory.yaml");
  writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^repos: .*$/m, "repos: [acme/api, acme/web, acme/docs]"));
  expect(() => run("repo", "add", "acme/docs", "--path", lead + "-missing")).toThrow("isn't a git checkout");
  expect(() => run("repo", "add", "acme/api", "--path", web)).toThrow("acme/api is the lead repo");
  run("repo", "add", "acme/web", "--path", web);
  expect(out.at(-1)).toBe(`  acme/web  ${web}`);
  const db = open(paths("acme-api").db);
  expect(listRepos(db).map((r) => [r.slug, r.lead])).toEqual([["acme/api", true], ["acme/web", false]]);
  expect(repoOf(db, "acme/web", ["acme/api", "acme/web"]).path).toBe(web);
  expect(repoOf(db, "acme/api", []).lead).toBe(true); // the lead is always the factory's
  expect(() => repoOf(db, "acme/web", ["acme/api"])).toThrow("acme/web isn't in factory.yaml's repos:");
  expect(() => repoOf(db, "acme/docs", ["acme/docs"])).toThrow("acme/docs has no checkout here; run factory repo add acme/docs --path <dir>");
});

test("a ticket's files read its PR from the lead repo's row", () => {
  const dir = mkdtempSync(join(tmpdir(), "files-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: "/src/api", lead: true });
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (9, 'Ship it', 'ready', '2026-11-21T09:00:00Z')").run();
  setWork(db, 9, { pr_number: 77, pr_watched: 1 });
  writeTicketFiles(db, dir, 9);
  expect(readFileSync(join(dir, "tickets/9/STATUS.md"), "utf8")).toContain("Ship it is ready: PR #77");
});
