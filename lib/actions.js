// What an action key asks before it changes anything. Pure, so it's tested: each
// returns { error } (shown as a toast) or the factory-ask dialog's props, whose
// `args` are the `factory` CLI command to run when you confirm. With `input`, the
// dialog has a text box and what you type is the command's last argument.
import { compact } from "./model.js";

// `n` needs no ticket. The new one starts at once, as tickets do after grooming.
export function newAsk() {
  return {
    title: "New ticket",
    detail: "Its first stage's agent starts right away, in its own worktree.",
    input: { label: "Issue link, #number, or a one-line goal", value: "", hint: "An issue keeps its number; a goal gets one from 10000." },
    confirm: "Create and start",
    args: ["new", "--start"],
    done: "Ticket added and started",
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

// The CLI runs against the very folder the window shows: <home>/<name>/status.json.
// `env` sets FACTORY_HOME, since exec takes no environment.
export function cliCommand(cli, root, args) {
  const parts = root.split("/").filter(Boolean);
  const name = parts.pop();
  return { command: "env", args: [`FACTORY_HOME=/${parts.join("/")}`, ...cli, ...args, "--name", name] };
}
