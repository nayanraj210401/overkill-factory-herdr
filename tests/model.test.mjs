import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { groupTickets, needsYou, subtitle, compact, parseTokens } from "../lib/model.js";

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
  assert.equal(by[421], "grooming · 3 questions");
  assert.equal(by[425], "parked · retries used up");
  assert.equal(by[412], "implement · 2.5M/3M in");
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
  const got = configFiles(["agents/reviewer.md", "notes.txt", "blueprints/feature.yaml", "factory.yaml", "blueprints/chore.yaml", "triggers/x.yaml", "prompts/stage.md"]);
  assert.deepEqual(got.map((f) => f.path), ["factory.yaml", "blueprints/chore.yaml", "blueprints/feature.yaml", "agents/reviewer.md", "prompts/stage.md", "triggers/x.yaml"]);
  assert.equal(got[3].language, "markdown");
  assert.equal(got[4].language, "markdown"); // prompt templates render as Markdown
});

test("STATUS.md parses into a stage timeline", async () => {
  const { parseStatusMd } = await import("../lib/model.js");
  const text = readFileSync(new URL("../fixtures/acme-api/tickets/412/STATUS.md", import.meta.url), "utf8");
  const { summary, stages } = parseStatusMd(text);
  assert.match(summary, /^Rate-limit login is in implement/);
  assert.deepEqual(stages.map((s) => s.state), ["done", "done", "done", "now", "next", "next", "next"]);
  assert.deepEqual(stages[3], { state: "now", name: "Implement", time: "12m", detail: "slice 2 of 3 · handoff at 60%" });
  assert.deepEqual(stages[4], { state: "next", name: "Verify", time: null, detail: "" });
  assert.deepEqual(parseStatusMd(null), { summary: "", stages: [] });
});

test("budget warning, session and handoff show on the surfaces", async () => {
  const { warnMark, stageDetail, holdText, localRunning, parseStatusMd } = await import("../lib/model.js");
  const by = Object.fromEntries(status.tickets.map((t) => [t.id, t]));
  assert.equal(warnMark(by[412]), "83%");
  assert.equal(warnMark(by[418]), null);
  assert.equal(warnMark({ warning: "close to its budget" }), "!");
  const text = readFileSync(new URL("../fixtures/acme-api/tickets/412/STATUS.md", import.meta.url), "utf8");
  const now = parseStatusMd(text).stages.find((s) => s.state === "now");
  assert.deepEqual(stageDetail(now, by[412]), { text: "slice 2 of 3 · handoff at 60% · session 2", warn: true });
  assert.deepEqual(stageDetail({ state: "now", detail: "" }, { session: 1 }), { text: "", warn: false });
  assert.deepEqual(stageDetail({ state: "done", detail: "3 slices" }, { session: 2 }), { text: "3 slices", warn: false });
  assert.equal(holdText(status), null);
  assert.equal(holdText({ plan: { hold: "daily budget reached (3M/3M in)" } }), "Nothing new starts: daily budget reached (3M/3M in)");
  assert.deepEqual(localRunning(status.tickets).map((t) => t.id), [412]); // 418 runs in the cloud
});

test("grouped rounds and numbered questions read from what the daemon writes", async () => {
  const { stageRounds, stageDetail, questionCards, ANSWER_HOW, parseStatusMd } = await import("../lib/model.js");
  const md = readFileSync(new URL("../fixtures/acme-api/tickets/409/STATUS.md", import.meta.url), "utf8");
  const [impl, verify] = parseStatusMd(md).stages;
  assert.equal(stageRounds(impl), "2 rounds");
  assert.equal(stageRounds(verify), "failed 1×, then passed");
  assert.deepEqual(stageDetail(verify, {}), { text: "tests 212 of 212", warn: false });
  assert.equal(stageRounds({ detail: "3 slices" }), null);
  const by = Object.fromEntries(status.tickets.map((t) => [t.id, t]));
  const cards = questionCards(by[421]);
  assert.deepEqual(cards.map((c) => [c.label, c.kind, c.reply]), [["Q1", "product", "A1: …"], ["Q2", "engineering", "A2: …"], ["Q3", "product", "A3: …"]]);
  assert.match(cards[0].who, /waits on the product owner/);
  assert.match(cards[1].who, /yours to answer/);
  assert.deepEqual(questionCards(by[412]), []);
  assert.match(ANSWER_HOW, /u in this window.*A1:/);
});

test("the Daemon bar offers what each state allows", async () => {
  const { daemonView } = await import("../lib/model.js");
  assert.deepEqual(daemonView(null).actions, []);
  assert.equal(daemonView(null, "bun: command not found\nmore").text, "factory CLI failed: bun: command not found");
  assert.deepEqual(daemonView({ installed: false, state: "absent", pid: null }).actions, ["install"]);
  const up = daemonView({ installed: true, state: "running", pid: 42 });
  assert.equal(up.text, "Running · pid 42 · starts at login");
  assert.deepEqual(up.actions, ["restart", "uninstall", "logs"]);
  assert.equal(daemonView({ installed: true, state: "spawn scheduled", pid: null }).tone, "blocked");
  // Start at login: the checkbox's state, and what an off service shows
  assert.equal(up.atLogin, true); // an older CLI with no at_login always started at login
  assert.equal(daemonView({ installed: false, state: "absent", pid: null }).atLogin, null);
  const off = daemonView({ installed: true, state: "running", pid: 42, at_login: false });
  assert.equal(off.text, "Running · pid 42");
  assert.equal(off.atLogin, false);
  const stopped = daemonView({ installed: true, state: "not running", pid: null, at_login: false });
  assert.equal(stopped.text, "Stopped · it doesn't start at login");
  assert.deepEqual(stopped.actions, ["start", "uninstall", "logs"]);
});

test("parseTokens reads what compact writes, and what people type", () => {
  for (const n of [3_000_000, 1_200_000, 64_000, 512]) assert.equal(parseTokens(compact(n)), n);
  assert.equal(parseTokens(" 1.5m "), 1_500_000);
  assert.equal(parseTokens("250000"), 250_000);
  assert.equal(parseTokens("3 M"), 3_000_000);
  for (const bad of ["", "lots", "-3M", "3G", "1e6"]) assert.equal(parseTokens(bad), null);
});

test("a paused ticket waits in the queue, labelled with where it stopped", () => {
  const t = { id: 1, title: "x", state: "paused", stage: "implement", tokens: { input: 0, output: 0 }, budget: { input: 1, output: 1 } };
  assert.deepEqual(groupTickets([t]).queue, [t]);
  assert.equal(subtitle(t), "paused at implement");
});

test("repos: the contract takes the factory's repos (lead first) and each ticket's, with one lead", () => {
  const s = structuredClone(status);
  s.factory.repos = ["acme/web", "acme/api"];
  s.tickets[0].repos = [{ slug: "acme/api", lead: false, pr: { number: 3 } }, { slug: "", lead: false }];
  assert.deepEqual(validateStatus(s), [
    "factory.repos: needs the repo slugs, the lead (factory.repo) first",
    "tickets[0].repos[0].pr: needs {number, watched}",
    "tickets[0].repos[1]: needs {slug, lead: boolean, pr, worktree}",
    "tickets[0].repos: needs exactly one lead repo",
  ]);
  delete s.factory.repos;
  delete s.tickets[0].repos;
  assert.deepEqual(validateStatus(s), []); // both are optional
});

test("repos: a badge only when the factory has more than one; the filter finds a cross-repo ticket in each repo", async () => {
  const { repoBadge, filterTickets, countBy } = await import("../lib/model.js");
  const one = { ...status, factory: { ...status.factory, repos: ["acme/api"] } };
  const tx = status.tickets.find((t) => t.id === 412);
  const t1 = status.tickets.find((t) => t.id === 418);
  assert.equal(repoBadge(one, tx), null);
  assert.equal(repoBadge(status, tx), "api + web");
  assert.equal(repoBadge(status, t1), "api"); // no repos: the factory's lead repo
  const lead = status.factory.repo;
  assert.deepEqual(filterTickets(status.tickets, "all", "", "acme/web", lead).map((t) => t.id), [412]);
  assert.equal(filterTickets(status.tickets, "all", "", "acme/api", lead).length, status.tickets.length);
  assert.deepEqual(filterTickets(status.tickets, "all", "acme/web", null, lead).map((t) => t.id), [412]); // search matches repos too
  assert.equal(countBy(status.tickets, "acme/web", lead).running, 1);
});

test("a cross-repo ticket's cards: lead first, each with its branch, PR and place in the merge order", async () => {
  const { crossRepoCards } = await import("../lib/model.js");
  const tx = status.tickets.find((t) => t.id === 412);
  assert.deepEqual(crossRepoCards(tx).map((c) => [c.slug, c.role, c.pr, c.order]), [
    ["acme/api", "lead", "no PR yet", "merges 2nd, after acme/web"],
    ["acme/web", "linked", "no PR yet", "merges 1st"],
  ]);
  const opened = { ...tx, repos: [{ ...tx.repos[0], pr: { number: 212, watched: true } }, { ...tx.repos[1], pr: { number: 88, watched: true }, merged_at: "2026-11-21T10:00:00Z" }] };
  assert.deepEqual(crossRepoCards(opened).map((c) => c.order), ["merges 2nd, after #88", "merged"]);
  assert.equal(crossRepoCards(status.tickets.find((t) => t.id === 418)), null);
});

test("a ticket's space and its worktree's space show their factory, not a factory named after the folder", async () => {
  const { factoryOf } = await import("../lib/model.js");
  const h = "/Users/me";
  assert.equal(factoryOf(`${h}/.factory/factory-sandbox/tickets/1`, h), "factory-sandbox");
  assert.equal(factoryOf(`${h}/.herdr/worktrees/factory-sandbox/factory-1-add-slugify`, h), "factory-sandbox");
  assert.equal(factoryOf(`${h}/Project/factory-sandbox`, h), "factory-sandbox");
  assert.equal(factoryOf(`${h}/Project/factory-sandbox/`, h), "factory-sandbox");
  assert.equal(factoryOf(undefined, h), null);
});

test("planPct shows a dash when nothing reports the plan's usage", async () => {
  const { planPct } = await import("../lib/model.js");
  const assert = (await import("node:assert/strict")).default;
  assert.equal(planPct({ window_5h: 0.62, source: "claude" }, "window_5h"), "62%");
  assert.equal(planPct({ window_5h: 0, source: "none" }, "window_5h"), "–");
  assert.equal(planPct({ week: 0.42 }, "week"), "42%"); // the sample has no source
});

test("Config's Pending changes lists the maintainer's open requests only", async () => {
  const { pendingRequests } = await import("../lib/model.js");
  const tickets = [
    { id: 1, blueprint: "factory", state: "running" }, { id: 2, blueprint: "factory", state: "merged" },
    { id: 3, blueprint: "feature", state: "running" }, { id: 4, blueprint: "factory", state: "queued" }, { id: 5, blueprint: "factory", state: "closed" },
  ];
  assert.deepEqual(pendingRequests(tickets).map((t) => t.id), [1, 4]);
  assert.deepEqual(pendingRequests(undefined), []);
});

test("Pending changes say who asked: you, or the learner", async () => {
  const { askedBy } = await import("../lib/model.js");
  assert.equal(askedBy({ requested_by: "learner" }), "the learner");
  assert.equal(askedBy({ requested_by: "you" }), "you");
  assert.equal(askedBy({}), "you"); // a status.json from before the field
});

test("an agent waiting on you in its terminal is in Needs you, first, whatever its stage", async () => {
  const { groupOf, needsYou } = await import("../lib/model.js");
  const waiting = { id: 9, state: "running", stage: "spec", needs: { kind: "attention", text: "Waiting on you in its terminal (t1): open it to answer" } };
  assert.equal(groupOf(waiting), "needs");
  assert.equal(groupOf({ id: 8, state: "running", stage: "spec", needs: null }), "running");
  const order = needsYou([{ id: 1, state: "ready", needs: null }, { id: 2, state: "parked", needs: { kind: "parked", text: "" } }, waiting]);
  assert.deepEqual(order.map((n) => [n.ticket.id, n.kind]), [[9, "attention"], [1, "merge"], [2, "parked"]]);
});
