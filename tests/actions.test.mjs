import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAsk, budgetAsk, sendBackAsk, answerAsk, cliCommand } from "../lib/actions.js";

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
  assert.deepEqual(answerAsk(ticket({ state: "grooming", needs: { kind: "question", text: "?" } })), { error: "Answer #409's questions on its issue for now" });
});
