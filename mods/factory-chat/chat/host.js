// The factory side of the chat: a ticket's sessions (`factory sessions <id> --json`) and the
// retained ChatView that shows them. The V2 Ticket page's Chat view and factory-chat's own
// main.js both draw it. sync.sh copies this folder into factory-ticket/chat/, so ../lib/ is
// the copy of lib/ in whichever mod runs it.
import { div } from "gpui-kit";
import { exec, theme, checking } from "herdr";
import { root } from "../lib/store.js";
import { cliCommand } from "../lib/actions.js";
import CLI from "../lib/cli.js"; // written by scripts/sync.sh
import { chatSessions } from "../lib/ticketchat.js";
import { ChatView } from "./chat.js";

export class TicketChat {
  constructor() {
    this.entity = null;
    this.rows = null; // the ticket's sessions rows, or null before the CLI answers
    this.key = null;
    this.sent = null;
    this.first = null; // a session id to open on instead of the live one (a smoke run's prop)
  }

  // Again when the ticket's live session may have changed: another ticket, terminal, stage or session count.
  load(ticket, daemon, cx) {
    const key = `${ticket.id}:${ticket.terminal ?? ""}:${ticket.stage ?? ""}:${ticket.session ?? ""}:${ticket.state}`;
    if (key === this.key) return;
    if (this.key?.split(":")[0] !== String(ticket.id)) this.rows = null;
    this.key = key;
    if (!daemon || checking()) { this.rows = []; return; }
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), ["sessions", String(ticket.id), "--json"]);
      const r = await exec(c.command, c.args, { timeout: 30000 }).catch(() => ({ code: 1, stdout: "" }));
      if (this.key !== key) return;
      let rows = [];
      try { rows = r.code === 0 ? JSON.parse(r.stdout.trim().split("\n").at(-1)) : []; } catch { rows = []; }
      this.rows = Array.isArray(rows) ? rows : [];
      cx.notify();
    });
  }

  // `active`: the chat shows now (it follows its terminal only then). `panel`: the page's Changes
  // panel ({ open, folded }), for the toggle in the chat's head; none on factory-chat's own page.
  render(ticket, s, cx, active = true, panel = null) {
    const daemon = s.source === "daemon";
    this.load(ticket, daemon, cx);
    const props = {
      ticket: { id: ticket.id, terminal: ticket.terminal ?? null, state: ticket.state },
      who: ticket.agent ?? ticket.stage ?? "agent",
      sessions: chatSessions(this.rows ?? [], ticket),
      daemon, active, first: this.first,
      ...(panel ? { panel } : {}),
    };
    const text = JSON.stringify(props);
    // A retained view is made and given props outside render: in a task, after a tick (a task's
    // body runs at once up to its first await, which is still inside render).
    const later = (cx) => new Promise((done) => cx.timer.after(0, done));
    if (!this.entity) {
      if (!this.making) { this.making = true; this.sent = text; cx.spawn(async (cx) => { await later(cx); this.entity = cx.new(ChatView, props); cx.notify(); }); }
      return div().id("chat-loading").size_full().bg(theme().background);
    }
    if (text !== this.sent) { this.sent = text; const e = this.entity; cx.spawn(async (cx) => { await later(cx); e.set_props(props); cx.notify(); }); }
    return this.entity;
  }
}
