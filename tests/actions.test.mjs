import { test } from "node:test";
import assert from "node:assert/strict";
import { newAsk, pauseAsk, mergeAsk, budgetAsk, sendBackAsk, answerAsk, talkable, terminalOf, cloudAllAsk, cliCommand } from "../lib/actions.js";

const ticket = (o) => ({ id: 409, title: "Bump dependencies", state: "ready", pr: { number: 511, watched: true },
  tokens: { input: 1_200_000, output: 64_000 }, budget: { input: 3_000_000, output: 200_000 }, ...o });

test("m asks before merging a ready ticket's PR, and runs factory merge", () => {
  const a = mergeAsk(ticket());
  assert.equal(a.title, "Merge PR #511?");
  assert.deepEqual(a.args, ["merge", "409"]);
});

test("m refuses a ticket with nothing to merge, without a dialog", () => {
  assert.deepEqual(mergeAsk(ticket({ state: "running", pr: null })), { error: "#409 has no PR ready to merge" });
  assert.deepEqual(mergeAsk(ticket({ pr: null })), { error: "#409 has no PR ready to merge" });
  assert.deepEqual(mergeAsk(undefined), { error: "No ticket selected" });
});

test("the CLI runs against the folder the window shows", () => {
  assert.deepEqual(cliCommand(["/bin/bun", "/x/cli.ts"], "/Users/me/.factory/acme-api", ["merge", "409"]),
    { command: "env", args: ["FACTORY_HOME=/Users/me/.factory", "/bin/bun", "/x/cli.ts", "merge", "409", "--name", "acme-api"] });
});

test("b asks for the new budget, starting from the current one", () => {
  const a = budgetAsk(ticket());
  assert.equal(a.input.value, "3M/200k");
  assert.equal(a.detail, "Bump dependencies has used 1.2M in, 64k out.");
  assert.deepEqual(a.args, ["budget", "409"]);
  assert.deepEqual(budgetAsk(ticket({ state: "merged" })), { error: "#409 is merged; its budget is final" });
});

test("x asks for a note on a ready PR; u on a park that isn't a question asks for a note", () => {
  const x = sendBackAsk(ticket());
  assert.deepEqual([x.title, x.input.value, x.args], ["Send PR #511 back", "", ["send-back", "409"]]);
  assert.deepEqual(sendBackAsk(ticket({ state: "running" })), { error: "#409 has no PR ready to send back" });
  const parked = ticket({ state: "parked", pr: null, needs: { kind: "parked", text: "Verify failed 3 times" } });
  const u = answerAsk(parked);
  assert.deepEqual([u.title, u.detail, u.args], ["Answer #409", "Verify failed 3 times", ["answer", "409"]]);
  assert.deepEqual(answerAsk(ticket()), { error: "#409 isn't waiting for an answer" });
});

test("u never shows an answer box for a question: a waiting agent's terminal, else talk it through", () => {
  // A stage agent asking in its live terminal (Herdr status blocked): u is e.
  const asking = ticket({ state: "running", stage: "implement", pr: null, terminal: "t5n", needs: { kind: "attention", text: "implement asks you in its terminal (t5n): press e to answer" } });
  assert.deepEqual(answerAsk(asking), { terminal: "t5n" });
  assert.equal(talkable(asking), false);
  // Parked on a question by older code, its session gone: a fresh session of its stage asks first, then opens.
  const parked = ticket({ id: 10000, state: "parked", stage: "implement", pr: null, terminal: null,
    needs: { kind: "parked", text: "Q1 from the implement stage (product, for the product owner): Which stations?" },
    questions: [{ n: 1, kind: "product", text: "Which stations?" }] });
  const talk = answerAsk(parked);
  assert.equal(talkable(parked), true);
  assert.deepEqual([talk.title, talk.confirm, talk.args, talk.peek, talk.input], ["Talk #10000 through", "Talk it through", ["talk", "10000", "--json"], true, undefined]);
  assert.match(talk.detail, /fresh implement session starts and asks you in its terminal/);
  // Grooming questions nobody's terminal asks (a scope change, older code): talk it through too.
  const g = answerAsk(ticket({ state: "grooming", pr: null, terminal: null, needs: { kind: "question", text: "2 questions · Q1: Which plan?" } }));
  assert.deepEqual([g.title, g.args, g.input], ["Talk #409 through", ["talk", "409", "--json"], undefined]);
  assert.deepEqual(answerAsk(ticket({ state: "grooming", pr: null, terminal: "t1", needs: { kind: "question", text: "Q1" } })), { terminal: "t1" });
  // Whatever asks, no question gets an input box.
  for (const t of [asking, parked, ticket({ state: "grooming", pr: null, needs: { kind: "question", text: "Q1" } })]) assert.equal(answerAsk(t).input, undefined);
});

test("the talk dialog opens the terminal factory talk started", () => {
  assert.equal(terminalOf('{"stage":"implement","terminal":"t9"}'), "t9");
  assert.equal(terminalOf('a warning first\n{"stage":"groom","terminal":"t3"}\n'), "t3");
  assert.equal(terminalOf("not json"), null);
});

test("n asks for an issue or goal and grooms it first", () => {
  const a = newAsk();
  assert.deepEqual([a.args, a.input.value, a.confirm], [["new"], "", "Create"]);
});

test("Home's button moves every locally running ticket to the cloud", () => {
  const tickets = [ticket({ id: 1, state: "running", where: "local" }), ticket({ id: 2, state: "running", where: "cloud" }),
    ticket({ id: 3, state: "ready" }), ticket({ id: 4, state: "running", where: "local" })];
  const a = cloudAllAsk(tickets);
  assert.deepEqual([a.title, a.args, a.done], ["Move all 2 running tickets to the cloud?", ["cloud", "--all"], "2 tickets are in the cloud"]);
  assert.match(a.detail, /^#1, #4:/);
  assert.deepEqual(cloudAllAsk([tickets[1], tickets[2]]), { error: "No ticket is running here" });
});

test("p pauses a running ticket and resumes a paused one", () => {
  const run = pauseAsk(ticket({ state: "running", stage: "implement", terminal: "t7" }));
  assert.deepEqual([run.title, run.args], ["Pause #409?", ["pause", "409"]]);
  assert.match(run.detail, /agent in t7 is ended/);
  assert.deepEqual(pauseAsk(ticket({ state: "paused", stage: "implement" })).args, ["resume", "409"]);
  assert.deepEqual(pauseAsk(ticket()), { error: "#409 is ready; only a running ticket pauses" });
});

test("z undoes the selected override through factory learn undo, and names the file's value", async () => {
  const { undoOverrideAsk } = await import("../lib/actions.js");
  const a = undoOverrideAsk({ key: "agents.reviewer.model", value: "sonnet", file: "opus" });
  assert.deepEqual(a.args, ["learn", "undo", "agents.reviewer.model"]);
  assert.match(a.detail, /use opus again, not sonnet/);
  assert.deepEqual(undoOverrideAsk(undefined), { error: "No override selected" });
});

test("g grooms a ticket again until it starts, never while its triager runs", async () => {
  const { regroomAsk } = await import("../lib/actions.js");
  const a = regroomAsk(ticket({ state: "grooming", needs: { kind: "question", text: "3 questions" }, terminal: null }));
  assert.equal(a.title, "Groom #409 again?");
  assert.deepEqual(a.args, ["groom", "409"]);
  assert.match(regroomAsk(ticket({ state: "grooming", terminal: "t4" })).error, /being groomed now/);
  assert.match(regroomAsk(ticket({ state: "running", terminal: "t4" })).error, /has started/);
  assert.deepEqual(regroomAsk(null), { error: "No ticket selected" });
});
