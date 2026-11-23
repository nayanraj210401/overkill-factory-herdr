import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo, setWork } from "./db.ts";
import { buildStatus } from "./status.ts";
import { stageDetail } from "../lib/model.js";
import { validateStatus } from "../lib/status.js";

test("session N counts the live agent's sessions in its own stage, and is null with no live agent", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "status-")), "factory.db"));
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (1, 'Slugify', 'running', '2026-11-21T00:00:00Z')").run();
  const add = (stage: string, agent: string, ended: boolean) =>
    db.query("INSERT INTO sessions (ticket, stage, agent, argv, started_at, ended_at) VALUES (1, ?, ?, '[]', '2026-11-21T00:00:00Z', ?)")
      .run(stage, agent, ended ? "2026-11-21T00:01:00Z" : null);
  const session = () => buildStatus(db).tickets[0]!.session;
  for (const s of ["groom", "groom", "spec", "plan"]) add(s, "x", true);
  add("implement", "builder", true); // handed off
  add("implement", "builder", false); // its second session, live
  expect(session()).toBe(2); // not 6, the count over every stage
  expect(stageDetail({ state: "now", detail: "" }, { session: session() }).text).toBe("session 2");
  db.query("UPDATE sessions SET ended_at = '2026-11-21T00:02:00Z'").run(); // at the merge gate: no agent
  expect(session()).toBe(null);
  expect(stageDetail({ state: "now", detail: "" }, { session: session() }).text).toBe("");
  add("review", "reviewer", false); // a first session says nothing
  expect(stageDetail({ state: "now", detail: "" }, { session: session() }).text).toBe("");
});

test("a running ticket carries its stage's start, its live agent and the slice in hand, for the sidebar", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "status-")), "factory.db"));
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (1, 'Slugify', 'running', '2026-11-21T00:00:00Z'), (2, 'Queued', 'queued', '2026-11-21T00:00:00Z')").run();
  db.query("INSERT INTO stages (ticket, name, detail, started_at, ended_at) VALUES (1, 'Plan', 'planner agent', '2026-11-21T00:00:00Z', '2026-11-21T00:05:00Z')").run();
  db.query("INSERT INTO stages (ticket, name, detail, started_at) VALUES (1, 'Implement', 'builder agent · slice 2 of 3', '2026-11-21T00:05:00Z')").run();
  db.query("INSERT INTO sessions (ticket, stage, agent, argv, started_at) VALUES (1, 'implement', 'builder', '[]', '2026-11-21T00:06:00Z')").run();
  const s = buildStatus(db);
  expect(validateStatus(s)).toEqual([]);
  const [t, q] = s.tickets as any[];
  expect([t.stage_started_at, t.agent, t.slice]).toEqual(["2026-11-21T00:05:00Z", "builder", { n: 2, of: 3 }]);
  expect(["stage_started_at", "agent", "slice"].filter((k) => k in q)).toEqual([]); // nothing when there's none
});

test("status.json carries each PR's url and state, one per repo for a cross-repo ticket", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "st-")), "factory.db"));
  setRepo(db, { slug: "acme/api", path: "/src/api", lead: true });
  setRepo(db, { slug: "acme/web", path: "/src/web", lead: false });
  db.exec(`INSERT INTO tickets (id, title, state, updated_at) VALUES (1, 'single', 'ready', '2026-11-21T09:00:00Z'), (2, 'cross', 'ready', '2026-11-21T09:00:00Z'),
    (3, 'done', 'merged', '2026-11-21T09:00:00Z'), (4, 'no pr', 'queued', '2026-11-21T09:00:00Z')`);
  setWork(db, 1, { pr_number: 5, pr_watched: 1 });
  setWork(db, 2, { pr_number: 6, pr_watched: 1, pr_state: "draft" });
  db.query("INSERT INTO ticket_repos (ticket, repo, pr_number, pr_state) VALUES (2, 'acme/web', 7, 'open')").run();
  setWork(db, 3, { pr_number: 8, pr_state: "open" }); // merged ticket: the ticket settles it
  const s = buildStatus(db);
  expect(validateStatus(s)).toEqual([]);
  const t = (id: number) => s.tickets.find((x: any) => x.id === id) as any;
  expect(t(1).pr).toEqual({ number: 5, watched: true, checked_at: null, url: "https://github.com/acme/api/pull/5", state: "open" });
  expect(t(2).pr).toMatchObject({ number: 6, url: "https://github.com/acme/api/pull/6", state: "draft" });
  expect(t(2).repos.map((r: any) => [r.slug, r.pr.url, r.pr.state])).toEqual([
    ["acme/api", "https://github.com/acme/api/pull/6", "draft"], ["acme/web", "https://github.com/acme/web/pull/7", "open"]]);
  expect(t(3).pr.state).toBe("merged");
  expect(t(4).pr).toBe(null);
});
