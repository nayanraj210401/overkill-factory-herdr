import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateStatus } from "../lib/status.js";
import { prLinks, watchNote, groupTickets, needsYou, subtitle, compact, parseTokens, sharedLinks, healthLine, v2UI } from "../lib/model.js";

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

test("a ticket's journal events are optional, and each needs kind, text and at", () => {
  const t412 = status.tickets.find((t) => t.id === 412);
  assert.ok(t412.events.length > 0 && t412.events.length <= 8, "the fixture shows #412's newest events");
  const bad = structuredClone(status);
  const t = bad.tickets.find((x) => x.id === 412);
  t.events = [{ kind: "stage", text: "", at: "2026-11-21T09:06:00Z" }, { kind: "check", text: "tests PASS", at: "yesterday" }];
  const errors = validateStatus(bad);
  assert.ok(errors.some((e) => /tickets\[\d+\]\.events\[0\]: needs \{kind, text, at\}/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /tickets\[\d+\]\.events\[1\]: needs \{kind, text, at\}/.test(e)), errors.join("\n"));
  t.events = "lots";
  assert.ok(validateStatus(bad).some((e) => e.endsWith(".events: needs an array")));
  delete t.events;
  assert.deepEqual(validateStatus(bad), []);
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
    ["acme/api", "lead", "PR #520", "merges 2nd, after #131"],
    ["acme/web", "linked", "PR #131", "merges 1st"],
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

test("with the machine's factories, any repo of a factory, or a folder in one, shows that factory", async () => {
  const { factoryOf } = await import("../lib/model.js");
  const h = "/Users/me";
  const factories = [
    { name: "acme-api", repos: [{ slug: "acme/api", path: `${h}/src/api`, lead: true }, { slug: "acme/web", path: `${h}/src/web`, lead: false }] },
    { name: "shop", repos: [{ slug: "other/api", path: `${h}/work/api`, lead: true }] },
  ];
  assert.equal(factoryOf(`${h}/src/web`, h, factories), "acme-api", "a second repo shows its factory, not a factory named web");
  assert.equal(factoryOf(`${h}/src/api/packages/core`, h, factories), "acme-api", "a folder inside a repo");
  assert.equal(factoryOf(`${h}/work/api`, h, factories), "shop", "same folder name, other factory");
  assert.equal(factoryOf(`${h}/.herdr/worktrees/web/factory-7-fix`, h, factories), "acme-api", "a worktree of the second repo");
  assert.equal(factoryOf(`${h}/.factory/shop/tickets/3`, h, factories), "shop");
  assert.equal(factoryOf(`${h}/elsewhere/tool`, h, factories), "tool", "an unknown folder still falls back to its name");
});

test("planPct shows a dash when nothing reports the plan's usage", async () => {
  const { planPct } = await import("../lib/model.js");
  const assert = (await import("node:assert/strict")).default;
  assert.equal(planPct({ window_5h: 0.62, source: "claude" }, "window_5h"), "62%");
  assert.equal(planPct({ window_5h: 0, source: "none" }, "window_5h"), "–");
  assert.equal(planPct({ week: 0.42 }, "week"), "42%"); // the sample has no source
});

test("an agent waiting on you in its terminal is in Needs you, first, whatever its stage", async () => {
  const { groupOf, needsYou } = await import("../lib/model.js");
  const waiting = { id: 9, state: "running", stage: "spec", needs: { kind: "attention", text: "spec asks you in its terminal (t1): press e to answer" } };
  assert.equal(groupOf(waiting), "needs");
  assert.equal(groupOf({ id: 8, state: "running", stage: "spec", needs: null }), "running");
  const order = needsYou([{ id: 1, state: "ready", needs: null }, { id: 2, state: "parked", needs: { kind: "parked", text: "" } }, waiting]);
  assert.deepEqual(order.map((n) => [n.ticket.id, n.kind]), [[9, "attention"], [1, "merge"], [2, "parked"]]);
});

test("notes between agents: Needs you shows the ones for Overwatch; Pending changes says from whom to whom", async () => {
  const { agentLabel, overwatchNotes, pendingNotes } = await import("../lib/model.js");
  assert.equal(agentLabel("overwatch"), "Overwatch");
  assert.equal(agentLabel("babysitter"), "the babysitter");
  assert.equal(agentLabel("maintainer"), "the maintainer");
  assert.equal(agentLabel("you"), "you");
  assert.deepEqual(status.asks.map((a) => a.id), [3, 4]); // the sample has one of each
  assert.deepEqual(overwatchNotes(status.asks).map((a) => [a.id, a.route]), [[3, "from the spec-writer to Overwatch"]]);
  assert.deepEqual(pendingNotes(status.asks).map((a) => a.route), ["from the spec-writer to Overwatch", "from Overwatch to the learner"]);
  assert.deepEqual(overwatchNotes(undefined), []);
  const bad = { ...status, asks: [{ id: 1, from: "x", to: "overwatch", text: "t", at: "2026-11-21T09:00:00Z" }] };
  assert.deepEqual(validateStatus(bad), ["asks[0]: needs {id, from, to, text, why, ticket, at, delivered}"]);
});

test("the Ticket page's shared links: spec first, then the plan, each opening its claude.ai page", () => {
  const t = status.tickets.find((x) => x.id === 412);
  assert.deepEqual(sharedLinks(t).map((l) => [l.label, l.url]), [
    ["INTENT.md ↗", "https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000411"],
    ["SLICES.md ↗", "https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000412"],
  ]);
  assert.deepEqual(sharedLinks({ id: 1 }), []); // nothing shared: no row on the page
});

test("prLinks: one link per repo with a PR, its state and url; the repo shows only across repos", () => {
  const one = prLinks(status.tickets.find((t) => t.id === 409), "acme/api");
  assert.deepEqual(one, [{ slug: "acme/api", number: 511, state: "open", word: "open", text: "#511", url: "https://github.com/acme/api/pull/511" }]);
  assert.equal(prLinks(status.tickets.find((t) => t.id === 401), "acme/api")[0].state, "merged"); // a merged ticket keeps its PR
  const cross = prLinks(status.tickets.find((t) => t.id === 412), "acme/api");
  assert.deepEqual(cross.map((l) => [l.text, l.state, l.url]), [
    ["api#520", "draft", "https://github.com/acme/api/pull/520"], ["web#131", "open", "https://github.com/acme/web/pull/131"]]);
  assert.deepEqual(prLinks(status.tickets.find((t) => t.id === 430), "acme/api"), []);
});

test("prLinks reads an older status.json with no url or state", () => {
  const old = { state: "merged", pr: { number: 7, watched: false, checked_at: null } };
  assert.deepEqual(prLinks(old, "acme/api"), [{ slug: "acme/api", number: 7, state: "merged", word: "merged", text: "#7", url: "https://github.com/acme/api/pull/7" }]);
  assert.equal(prLinks({ state: "ready", pr: old.pr }, "acme/api")[0].state, "open");
});

test("the contract checks a PR's url and state; watchNote is the watched badge", () => {
  const bad = structuredClone(status);
  bad.tickets.find((t) => t.id === 409).pr.state = "done";
  bad.tickets.find((t) => t.id === 409).pr.url = "nope";
  const errors = validateStatus(bad);
  assert.ok(errors.some((e) => e.startsWith('tickets[4].pr.state: "done"')), errors.join("\n"));
  assert.ok(errors.some((e) => e.startsWith("tickets[4].pr.url")), errors.join("\n"));
  assert.equal(watchNote({ pr: { number: 1, watched: true, checked_at: "2026-11-21T09:58:00Z" } }, now), "watching · checked 2m ago");
  assert.equal(watchNote({ pr: { number: 1, watched: false, checked_at: null } }, now), null);
});

test("Home's repo health line: passed, failed with its ticket and first failure, couldn't run", () => {
  const at = "2026-11-21T07:00:00Z";
  assert.deepEqual(healthLine({ repo: "acme/api", ok: true, at, branch: "main" }, now), { tone: "pass", text: "acme/api · main · full suite passed 3h ago", detail: null });
  assert.deepEqual(healthLine({ repo: "acme/api", ok: false, at, branch: "main", command: "npm test", failure: "\nFAIL a.test.ts\n  boom", ticket: 10004 }, now),
    { tone: "fail", text: "acme/api · main · `npm test` failed 3h ago · #10004", detail: "FAIL a.test.ts" });
  assert.deepEqual(healthLine({ repo: "acme/web", ok: null, at, branch: null, error: "no quality_floor commands in its factory.yaml" }, now),
    { tone: "none", text: "acme/web · couldn't run 3h ago", detail: "no quality_floor commands in its factory.yaml" });
});

test("the contract checks health entries: a failure names its command and failure, a skipped run its error", () => {
  const h = { repo: "acme/api", ok: false, at: "2026-11-21T07:00:00Z", branch: "main", commit: "abc", command: "npm test", failure: "FAIL", error: null, ticket: 10004 };
  assert.deepEqual(validateStatus({ ...status, health: [h] }), []);
  assert.equal(validateStatus({ ...status, health: [{ ...h, failure: null }] }).length, 1);
  assert.equal(validateStatus({ ...status, health: [{ ...h, ok: null }] }).length, 1);
  assert.equal(validateStatus({ ...status, health: [{ ...h, ok: "yes" }] }).length, 1);
  assert.equal(validateStatus({ ...status, health: {} }).length, 1);
});

test("v2UI is on only when status.json says ui.v2: true; ui is optional but checked", () => {
  assert.equal(v2UI(status), false); // the fixture has no ui
  assert.equal(v2UI(null), false);
  assert.equal(v2UI({ ...status, ui: { v2: false } }), false);
  assert.equal(v2UI({ ...status, ui: { v2: "true" } }), false);
  assert.equal(v2UI({ ...status, ui: { v2: true } }), true);
  assert.deepEqual(validateStatus({ ...status, ui: { v2: true } }), []);
  assert.deepEqual(validateStatus({ ...status, ui: { v2: true, sidebar: true } }), []);
  assert.deepEqual(validateStatus({ ...status, ui: { v2: "yes" } }), ["ui: needs {v2: boolean, sidebar?: boolean}"]);
});

test("planAge says how old Claude Code's plan reading is, once it's over an hour", async () => {
  const { planAge } = await import("../lib/model.js");
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(planAge({ source: "claude", as_of: "2026-11-25T11:30:00Z" }, now), null);
  assert.equal(planAge({ source: "claude", as_of: "2026-11-25T09:00:00Z" }, now), "as of 3h ago");
  assert.equal(planAge({ source: "claude", as_of: "2026-11-24T08:57:00Z" }, now), "as of 1d ago");
  assert.equal(planAge({ source: "estimate", as_of: null }, now), null);
});
