import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { buildBlueprints } from "./blueprints.ts";

const fixtures = join(import.meta.dir, "../fixtures/acme-api");

test("the sample blueprints.json matches the fixture YAML, apart from its made-up counts", () => {
  const strip = (d: any) => d.blueprints.map((b: any) => ({ ...b, grooming_runs: 0, stages: b.stages.map((s: any) => ({ ...s, runs: 0 })) }));
  const sample = JSON.parse(readFileSync(join(fixtures, "blueprints.json"), "utf8"));
  expect(strip(sample)).toEqual(strip(buildBlueprints(null, fixtures)));
});

test("runs count each stage entered in the last 7 days, per blueprint, retries again", () => {
  const db = open(join(mkdtempSync(join(tmpdir(), "bp-")), "factory.db"));
  const now = new Date("2026-11-21T12:00:00Z");
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (1, 'a', 'feature', ?), (2, 'b', 'chore', ?)").run(now.toISOString(), now.toISOString());
  const stage = (t: number, name: string, at: string) => db.query("INSERT INTO stages (ticket, name, started_at) VALUES (?, ?, ?)").run(t, name, at);
  stage(1, "Groom", "2026-11-21T09:00:00Z"); stage(1, "Implement", "2026-11-21T10:00:00Z"); stage(1, "Implement", "2026-11-21T11:00:00Z");
  stage(1, "PR", "2026-11-21T11:30:00Z"); stage(1, "Spec", "2026-11-01T00:00:00Z"); stage(2, "Implement", "2026-11-21T10:00:00Z");
  const feature = buildBlueprints(db, fixtures, now).blueprints.find((b) => b.name === "feature")!;
  const runs = Object.fromEntries(feature.stages.map((s) => [s.id, s.runs]));
  expect(runs).toMatchObject({ implement: 2, pr: 1, spec: 0 });
  expect(feature.grooming_runs).toBe(1);
});
