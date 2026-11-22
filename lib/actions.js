// What an action key asks before it changes anything. Pure, so it's tested: each
// returns { error } (shown as a toast) or the factory-ask dialog's props, whose
// `args` are the `factory` CLI command to run when you confirm. With `input`, the
// dialog has a text box and what you type is the command's last argument.
import { compact } from "./model.js";

// `n` needs no ticket. The new one starts at once, as tickets do after grooming.
export function newAsk() {
  return {
    title: "New ticket",
    detail: "The triage agent grooms it first; it starts on its own once nothing is left to ask.",
    input: { label: "Issue link, #number, or a one-line goal", value: "", hint: "An issue keeps its number; a goal gets one from 10000." },
    confirm: "Create",
    args: ["new"],
    done: "Ticket added; grooming it",
  };
}

export function mergeAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state !== "ready" || !ticket.pr) return { error: `#${ticket.id} has no PR ready to merge` };
  return {
    title: `Merge PR #${ticket.pr.number}?`,
    detail: `Merges #${ticket.id} ${ticket.title} on GitHub (factory.yaml's merge_method, squash by default) and marks the ticket merged. A draft PR is marked ready first.`,
    confirm: "Merge",
    args: ["merge", String(ticket.id)],
    done: `#${ticket.id} merged`,
  };
}

export function sendBackAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state !== "ready" || !ticket.pr) return { error: `#${ticket.id} has no PR ready to send back` };
  return {
    title: `Send PR #${ticket.pr.number} back`,
    detail: `#${ticket.id} ${ticket.title} goes back to its fix stage. The PR stays open and gets the new commits.`,
    input: { label: "What to change", value: "", hint: "Saved in the ticket's REVIEW.md for the agent." },
    confirm: "Send back",
    args: ["send-back", String(ticket.id)],
    done: `#${ticket.id} sent back`,
  };
}

export function answerAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state === "grooming" && ticket.needs?.kind === "question") return {
    title: `Answer #${ticket.id}'s questions`,
    detail: ticket.needs.text,
    input: { label: "Your answer", value: "", hint: "Answers the first open question; start lines with A2: to answer others. Saved in GATES.md and posted on the issue." },
    confirm: "Answer",
    args: ["answer", String(ticket.id)],
    done: `#${ticket.id} answered`,
  };
  if (ticket.state !== "parked") return { error: `#${ticket.id} isn't waiting for an answer` };
  return {
    title: `Answer #${ticket.id}`,
    detail: ticket.needs?.text ?? "It stopped.",
    input: { label: "Your answer", value: "", hint: "Saved in the ticket's GATES.md; the stage it stopped at runs again." },
    confirm: "Answer and restart",
    args: ["answer", String(ticket.id)],
    done: `#${ticket.id} restarted`,
  };
}

// ⇧C: the ticket's work goes to a Claude Code cloud session; the factory loses sight of it.
export function cloudAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.where === "cloud") return { error: `#${ticket.id} is in the cloud already; ⇧L brings it back` };
  if (ticket.state !== "running") return { error: `#${ticket.id} is ${ticket.state}; only a running ticket moves to the cloud` };
  return {
    title: `Move #${ticket.id} to the cloud?`,
    detail: `${ticket.title}: its agent stops, the work so far is committed with a handoff and pushed, and claude --cloud carries on from ${ticket.stage ?? "its stage"}. The factory can't watch it there; ⇧L brings it back.`,
    confirm: "Move to cloud", args: ["cloud", String(ticket.id)], done: `#${ticket.id} is in the cloud`,
  };
}

// Home's button: every running ticket that works here goes to the cloud at once.
export function cloudAllAsk(tickets) {
  const ids = tickets.filter((t) => t.state === "running" && t.where === "local").map((t) => t.id);
  if (!ids.length) return { error: "No ticket is running here" };
  return {
    title: `Move ${ids.length === 1 ? "the running ticket" : `all ${ids.length} running tickets`} to the cloud?`,
    detail: `${ids.map((id) => `#${id}`).join(", ")}: each agent stops, its work so far is committed with a handoff and pushed, and claude --cloud carries on. The factory can't watch them there; ⇧L brings one back.`,
    confirm: "Move to cloud", args: ["cloud", "--all"], done: `${ids.length === 1 ? `#${ids[0]} is` : `${ids.length} tickets are`} in the cloud`,
  };
}

// ⇧L: fetch what the cloud session pushed and resume here.
export function localAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.where !== "cloud") return { error: `#${ticket.id} isn't in the cloud` };
  return {
    title: `Bring #${ticket.id} back?`,
    detail: `Stop the cloud session at a step first. The branch is fetched, its RESULT.md becomes the ticket's handoff and evidence, and a fresh local session carries on.`,
    confirm: "Bring back", args: ["local", String(ticket.id)], done: `#${ticket.id} is back`,
  };
}

// `p` toggles: a running ticket pauses (its agent stops), a paused one resumes.
export function pauseAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state === "paused") return {
    title: `Resume #${ticket.id}?`,
    detail: `${ticket.title} reruns ${ticket.stage ?? "its stage"} in a fresh session.`,
    confirm: "Resume", args: ["resume", String(ticket.id)], done: `#${ticket.id} resumed`,
  };
  if (ticket.state !== "running") return { error: `#${ticket.id} is ${ticket.state}; only a running ticket pauses` };
  return {
    title: `Pause #${ticket.id}?`,
    detail: `${ticket.title} stops at ${ticket.stage ?? "its stage"}${ticket.terminal ? `, and its agent in ${ticket.terminal} is ended` : ""}. Resume (p) reruns that stage in a fresh session.`,
    confirm: "Pause", args: ["pause", String(ticket.id)], done: `#${ticket.id} paused`,
  };
}

export function budgetAsk(ticket) {
  if (!ticket) return { error: "No ticket selected" };
  if (ticket.state === "merged" || ticket.state === "closed") return { error: `#${ticket.id} is ${ticket.state}; its budget is final` };
  const { budget: b, tokens: u } = ticket;
  return {
    title: `Budget for #${ticket.id}`,
    detail: `${ticket.title} has used ${compact(u.input)} in, ${compact(u.output)} out.`,
    input: { label: "Tokens in / out", value: `${compact(b.input)}/${compact(b.output)}`, hint: "Input tokens, or in/out: 3M, 3M/200k" },
    confirm: "Save",
    args: ["budget", String(ticket.id)],
    done: `#${ticket.id}'s budget changed`,
  };
}

// `z` on Config: drop the selected override, so new tickets use the file's value again.
export function undoOverrideAsk(override) {
  if (!override) return { error: "No override selected" };
  return {
    title: `Undo ${override.key}?`,
    detail: `Tickets that start from now on use ${override.file ?? "the file's value"} again, not ${override.value}. Tickets already running keep the settings they started with.`,
    confirm: "Undo", args: ["learn", "undo", override.key], done: `${override.key} is back to the file's value`,
  };
}

// The CLI runs against the very folder the window shows: <home>/<name>/status.json.
// `env` sets FACTORY_HOME, since exec takes no environment.
export function cliCommand(cli, root, args) {
  const parts = root.split("/").filter(Boolean);
  const name = parts.pop();
  return { command: "env", args: [`FACTORY_HOME=/${parts.join("/")}`, ...cli, ...args, "--name", name] };
}
