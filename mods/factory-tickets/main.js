import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, shared } from "herdr";
import { GROUPS, groupTickets, repoBadge, subtitle, warnMark } from "./lib/model.js";
import { STACK } from "./lib/pages.js";
import { status } from "./lib/store.js";

const COLOR = { needs: "blocked", running: "working", ready: "done", queue: "muted" };

// The sidebar's live tickets, grouped as on Home. A click opens the Ticket page.
export default class FactoryTickets extends View {
  row(t, s, ticket, group, now) {
    const badge = repoBadge(s, ticket);
    const on = shared("factory.ticket") === ticket.id;
    return v_flex().id(`t-${ticket.id}`).px(8).py(4).rounded(7).cursor_pointer().bg(on ? t.selected : t.chrome)
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        setShared("factory.ticket", ticket.id);
        run("layout.select", { stack: STACK, child: "ticket" });
      })
      .child(h_flex().gap(8).items_center().text_size(13).text_color(t.foreground)
        .child(div().size(7).rounded_full().bg(t[COLOR[group]]))
        .child(div().flex_1().truncate().child(`#${ticket.id} ${ticket.title}`))
        .when(!!warnMark(ticket), (el) => el.child(div().flex_none().px(5).rounded(7).text_size(10.5).border(1).border_color(t.blocked).text_color(t.blocked).child(warnMark(ticket))))
        .when(!!badge, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(badge))))
      .child(div().pl(15).text_size(11.5).text_color(t.muted).truncate().child(subtitle(ticket, now)));
  }

  render() {
    const t = theme();
    const s = status();
    if (!s) return div().size_full().bg(t.chrome);
    const groups = groupTickets(s.tickets);
    const now = Date.now();
    const head = (text, color) => div().px(8).pt(10).pb(2).text_size(11).text_color(color).child(text);
    const blocked = groups.queue.filter((x) => x.state === "blocked").length;
    return v_flex().id("tickets").size_full().px(8).bg(t.chrome).overflow_y_scroll()
      .children(GROUPS.filter((g) => g.id !== "queue" && groups[g.id].length).flatMap((g) => [
        head(`${g.title.toUpperCase()} · ${groups[g.id].length}`, g.id === "running" ? t.muted : t[COLOR[g.id]]),
        ...groups[g.id].map((x) => this.row(t, s, x, g.id, now)),
      ]))
      .child(head(`QUEUE · ${groups.queue.length}${blocked ? ` · BLOCKED ${blocked}` : ""}`, t.muted))
      .child(head(`TO REVIEW · ${s.to_review}`, t.accent).id("to-review").cursor_pointer()
        .on_click(() => run("layout.select", { stack: STACK, child: "reviews" })));
  }
}
