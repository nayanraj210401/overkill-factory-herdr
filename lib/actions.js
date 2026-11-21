// What an action key asks before it changes anything. Pure, so it's tested: each
// returns { error } (shown as a toast) or the factory-ask dialog's props, whose
// `args` are the `factory` CLI command to run when you confirm.

export function mergeAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state !== "ready" || !ticket.pr) return { error: `#${ticket.id} has no PR ready to merge` };
  return {
    title: `Merge PR #${ticket.pr.number}?`,
    detail: `Squash-merges #${ticket.id} ${ticket.title} on GitHub and marks the ticket merged. A draft PR is marked ready first.`,
    confirm: "Merge",
    args: ["merge", String(ticket.id)],
    done: `#${ticket.id} merged`,
  };
}

// The CLI runs against the very folder the window shows: <home>/<name>/status.json.
// `env` sets FACTORY_HOME, since exec takes no environment.
export function cliCommand(cli, root, args) {
  const parts = root.split("/").filter(Boolean);
  const name = parts.pop();
  return { command: "env", args: [`FACTORY_HOME=/${parts.join("/")}`, ...cli, ...args, "--name", name] };
}
