import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAsk, cliCommand } from "../lib/actions.js";

const ticket = (o) => ({ id: 409, title: "Bump dependencies", state: "ready", pr: { number: 511, watched: true }, ...o });

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
