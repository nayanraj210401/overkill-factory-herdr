import { test } from "node:test";
import assert from "node:assert/strict";
import { newAsk, pauseAsk, mergeAsk, budgetAsk, sendBackAsk, answerAsk, cloudAllAsk, cliCommand } from "../lib/actions.js";

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

test("x asks for a note on a ready PR; u asks a parked ticket's question", () => {
  const x = sendBackAsk(ticket());
  assert.deepEqual([x.title, x.input.value, x.args], ["Send PR #511 back", "", ["send-back", "409"]]);
  assert.deepEqual(sendBackAsk(ticket({ state: "running" })), { error: "#409 has no PR ready to send back" });
  const parked = ticket({ state: "parked", pr: null, needs: { kind: "parked", text: "Verify failed 3 times" } });
  const u = answerAsk(parked);
  assert.deepEqual([u.title, u.detail, u.args], ["Answer #409", "Verify failed 3 times", ["answer", "409"]]);
  assert.deepEqual(answerAsk(ticket()), { error: "#409 isn't waiting for an answer" });
  const g = answerAsk(ticket({ state: "grooming", needs: { kind: "question", text: "2 questions · Q1: Which plan?" } }));
  assert.deepEqual([g.title, g.detail, g.args, g.confirm], ["Answer #409's questions", "2 questions · Q1: Which plan?", ["answer", "409"], "Answer"]);
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
