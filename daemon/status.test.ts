import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { buildStatus } from "./status.ts";
import { stageDetail } from "../lib/model.js";

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
