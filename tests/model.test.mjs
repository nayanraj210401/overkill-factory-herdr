import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { groupTickets, needsYou, subtitle, compact } from "../lib/model.js";

const status = JSON.parse(readFileSync(new URL("../fixtures/acme-api/status.json", import.meta.url)));
const now = Date.parse("2026-11-21T10:00:00Z");

test("the fixture meets the status.json contract", () => {
  assert.deepEqual(validateStatus(status), []);
});

test("the validator names each broken field in one line", () => {
  const bad = structuredClone(status);
  bad.tickets[0].state = "doing";
  bad.tickets[1].needs = null; // parked without a reason
  bad.tickets.push({ ...bad.tickets[2] }); // duplicate id
  delete bad.today.usd;
  const errors = validateStatus(bad);
  assert.ok(errors.some((e) => e.startsWith('tickets[0].state: "doing"')), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("tickets[1]: state parked")), errors.join("\n"));
  assert.ok(errors.some((e) => e === "tickets: id 412 appears twice"), errors.join("\n"));
  assert.ok(errors.some((e) => e === "today.usd: needs a number"), errors.join("\n"));
  assert.ok(errors.every((e) => !e.includes("\n")));
  assert.deepEqual(validateStatus(null), ["status.json: not a JSON object"]);
});

test("sidebar groups match the Home mockup", () => {
  const g = groupTickets(status.tickets);
  const ids = (k) => g[k].map((t) => t.id);
  assert.deepEqual(ids("needs"), [421, 425]);
  assert.deepEqual(ids("running"), [412, 418]);
  assert.deepEqual(ids("ready"), [409]);
  assert.deepEqual(ids("queue"), [430, 431, 432, 433]);
  assert.equal(g.queue.filter((t) => t.state === "blocked").length, 1);
});

test("Home's Needs you: questions, then merges, then parked", () => {
  assert.deepEqual(needsYou(status.tickets).map((n) => [n.ticket.id, n.kind]), [[421, "question"], [409, "merge"], [425, "parked"]]);
});

test("row subtitles read like the mockup", () => {
  const by = Object.fromEntries(status.tickets.map((t) => [t.id, subtitle(t, now)]));
  assert.equal(by[421], "grooming · 2 questions");
  assert.equal(by[425], "parked · retries used up");
  assert.equal(by[412], "implement · 1.2M/3M in");
  assert.equal(by[418], "verify · in cloud");
  assert.equal(by[409], "watching · checked 2m ago");
  assert.equal(subtitle(status.tickets[4], Date.parse("2026-11-21T09:58:20Z")), "watching · checked just now");
  assert.equal(by[430], "blocked by #425");
  assert.equal(compact(64000), "64k");
});

test("Tickets filters: chips cover every ticket, search narrows", async () => {
  const { FILTERS, filterTickets, countBy } = await import("../lib/model.js");
  const counts = countBy(status.tickets);
  assert.equal(counts.all, status.tickets.length);
  assert.equal(FILTERS.slice(1).reduce((n, f) => n + counts[f.id], 0), counts.all, "each ticket is in exactly one chip");
  assert.deepEqual(filterTickets(status.tickets, "merged").map((t) => t.id), [401, 405]);
  assert.deepEqual(filterTickets(status.tickets, "all", "#412").map((t) => t.id), [412]);
  assert.deepEqual(filterTickets(status.tickets, "queue", "feature").map((t) => t.id).sort(), [430, 431, 433]);
  assert.deepEqual(filterTickets(status.tickets, "all", "no such thing"), []);
});

test("Config lists .factory files in plan order", async () => {
  const { configFiles } = await import("../lib/model.js");
  const got = configFiles(["agents/reviewer.md", "notes.txt", "blueprints/feature.yaml", "factory.yaml", "blueprints/chore.yaml", "triggers/x.yaml"]);
  assert.deepEqual(got.map((f) => f.path), ["factory.yaml", "blueprints/chore.yaml", "blueprints/feature.yaml", "agents/reviewer.md", "triggers/x.yaml"]);
  assert.equal(got[3].language, "markdown");
});

test("STATUS.md parses into a stage timeline", async () => {
  const { parseStatusMd } = await import("../lib/model.js");
  const text = readFileSync(new URL("../fixtures/acme-api/tickets/412/STATUS.md", import.meta.url), "utf8");
  const { summary, stages } = parseStatusMd(text);
  assert.match(summary, /^Rate-limit login is in implement/);
  assert.deepEqual(stages.map((s) => s.state), ["done", "done", "done", "now", "next", "next", "next"]);
  assert.deepEqual(stages[3], { state: "now", name: "Implement", time: "12m", detail: "slice 2 of 3 · builder" });
  assert.deepEqual(stages[4], { state: "next", name: "Verify", time: null, detail: "" });
  assert.deepEqual(parseStatusMd(null), { summary: "", stages: [] });
});
