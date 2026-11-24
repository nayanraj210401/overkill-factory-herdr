// The chat for one ticket's agent on its own (the V2 Ticket page embeds the same view under
// its Chat switch). Adapted from herdr-chat (MIT): see UPSTREAM.md. Only the V2_UI gate makes
// it reachable; with the gate off it says so and draws no chat.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props, shared, checking } from "herdr";
import { status } from "./lib/store.js";
import { currentTicket } from "./lib/model.js";
import { ticketViews } from "./lib/ticketchat.js";
import { TicketChat } from "./chat/host.js";

export default class FactoryChat extends View {
  init() {
    this.chat = new TicketChat();
  }

  render(cx) {
    const t = theme();
    const s = status();
    const note = (text) => v_flex().id("factory-chat").size_full().items_center().justify_center().bg(t.background).text_color(t.dim).child(text);
    // `herdr-app check` draws the chat on the sample data; elsewhere the gate decides.
    if (!checking() && !ticketViews(s)) return note("The ticket chat is part of the V2 UI (V2_UI in Config).");
    const ticket = s && currentTicket(s.tickets, props()?.ticket ?? shared("factory.ticket"));
    if (!ticket) return note("No ticket selected.");
    return div().size_full().child(this.chat.render(ticket, s, cx));
  }
}
