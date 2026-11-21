import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared } from "herdr";
import { needsYou, ago, compact } from "./lib/model.js";
import { STACK } from "./lib/pages.js";
import { keyAction, clamp } from "./lib/keys.js";
import { status, act } from "./lib/store.js";

const open = (id) => {
  setShared("factory.ticket", id);
  run("layout.select", { stack: STACK, child: "ticket" });
};

// Home: what needs you, then what runs, then today's four numbers (docs/layouts/01-home.png).
export default class FactoryHome extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.at = 0;
  }

  // j/k walk Needs you then Running; enter opens; action keys act on the selected ticket.
  key(e, items, cx) {
    const a = keyAction(e);
    if (!a) return;
    if (a.kind === "move") this.at = clamp(this.at + a.delta, items.length);
    else if (a.kind === "open" && items[this.at]) open(items[this.at].id);
    else act(a, items[this.at]);
    cx.stop_propagation();
    cx.notify();
  }

  card(t, { ticket, kind }, now, on) {
    const color = kind === "merge" ? t.done : t.blocked;
    const tag = kind === "question" ? "grooming · waiting on you" : kind === "parked" ? "parked"
      : ticket.pr?.watched && ticket.pr.checked_at ? `watching · checked ${ago(ticket.pr.checked_at, now)}` : "ready to merge";
    return h_flex().id(`n-${ticket.id}`).rounded(8).bg(t.surface).border(1).border_color(on ? t.accent : t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => open(ticket.id))
      .child(div().w(3).h_full().rounded_l(8).bg(color))
      .child(v_flex().flex_1().px(14).py(10).gap(3)
        .child(h_flex().gap(8)
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(`#${ticket.id} ${ticket.title}`))
          .child(div().text_size(12).text_color(color).child(tag)))
        .child(div().text_color(t.muted).child(ticket.needs?.text ?? ticket.detail ?? "")));
  }

  render() {
    const t = theme();
    const s = status();
    if (!s) return div().size_full().bg(t.background);
    const now = Date.now();
    const section = (title) => div().pt(12).pb(4).text_size(15).font_semibold().text_color(t.foreground).child(title);
    const running = s.tickets.filter((x) => x.state === "running");
    const needs = needsYou(s.tickets);
    const items = [...needs.map((n) => n.ticket), ...running];
    const focused = this.handle.is_focused();
    const d = s.today;
    const tile = (label, value) => v_flex().flex_1().p(14).gap(6).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(div().text_size(26).font_semibold().text_color(t.foreground).child(value));
    return v_flex().id("home").size_full().px(18).pb(16).gap(8).bg(t.background).rounded(10).text_size(13).overflow_y_scroll()
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, items, cx))
      .child(section("Needs you"))
      .children(needs.map((n, i) => this.card(t, n, now, focused && i === this.at)))
      .child(section("Running"))
      .children(running.map((x, i) => h_flex().id(`r-${x.id}`).h(30).px(4).gap(10).items_center().rounded(6).cursor_pointer()
        .when(focused && needs.length + i === this.at, (el) => el.bg(t.selected))
        .hover((st) => st.bg(t.hover)).on_click(() => open(x.id))
        .child(div().size(7).rounded_full().bg(t.working))
        .child(div().flex_1().text_color(t.foreground).truncate().child(`#${x.id} ${x.title}`))
        .child(div().w(200).text_color(x.where === "cloud" ? t.accent : t.muted).truncate()
          .child(x.where === "cloud" ? `${x.stage} · in cloud` : [x.stage, x.detail].filter(Boolean).join(" · ")))
        .child(div().w(70).text_color(t.muted).child(`${compact(x.tokens.input)} in`))
        .child(div().w(50).text_color(t.foreground).child(`$${x.usd.toFixed(2)}`))))
      .when(!running.length, (el) => el.child(div().text_color(t.dim).child("Nothing running.")))
      .child(section("Today"))
      .child(h_flex().gap(10)
        .child(tile("Time to PR", `${d.time_to_pr_min}m`))
        .child(tile("Cost per PR", `$${d.cost_per_pr_usd.toFixed(2)}`))
        .child(tile("Interactions / PR", String(d.interactions_per_pr)))
        .child(tile("Revert rate", `${Math.round(d.revert_rate * 100)}%`)));
  }
}
