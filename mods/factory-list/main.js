import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, run, setShared, notify } from "herdr";
import { FILTERS, filterTickets, countBy, groupOf, subtitle } from "./lib/model.js";
import { STACK } from "./lib/pages.js";
import { keyAction, clamp } from "./lib/keys.js";
import { status, peekAgent } from "./lib/store.js";

const open = (id) => { setShared("factory.ticket", id); run("layout.select", { stack: STACK, child: "ticket" }); };
const DOT = { needs: "blocked", running: "working", ready: "done", queue: "dim" };
const COLS = [["Stage", 230], ["Blueprint", 100], ["Tokens in", 90], ["Cost", 70]];

// The Tickets page: every ticket, chips by state, search (docs/layouts/03-tickets.png).
export default class FactoryList extends View {
  init(_props, cx) {
    this.filter = "all";
    this.query = "";
    this.input = InputState.new({ placeholder: "Search tickets…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });
    this.handle = cx.focus_handle();
    this.at = 0;
  }

  // Keys bubble up from the search box too: leave them to it while it has focus.
  key(e, rows, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.handle.focus(); cx.stop_propagation(); }
      return;
    }
    if (e.key === "/") { this.input.focus(); cx.stop_propagation(); return; }
    const a = keyAction(e);
    if (!a) return;
    if (a.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
    else if (a.kind === "open" && rows[this.at]) open(rows[this.at].id);
    else if (a.kind === "terminal") peekAgent(rows[this.at]);
    else if (a.kind === "soon") notify({ title: `${a.label}: coming in ${a.milestone}`, level: "info", timeout: 2500 });
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const s = status();
    if (!s) return div().size_full().bg(t.background);
    const counts = countBy(s.tickets);
    const rows = filterTickets(s.tickets, this.filter, this.query);
    const now = Date.now();
    const chip = (f) => {
      const on = f.id === this.filter;
      return div().id(`f-${f.id}`).px(10).py(3).rounded(12).border(1).cursor_pointer().text_size(12)
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.filter = f.id; this.at = 0; cx.notify(); })
        .child(`${f.title} · ${counts[f.id]}`);
    };
    const cell = (w, text, color) => div().w(w).flex_none().truncate().text_color(color).child(text);
    const focused = this.handle.is_focused();
    return v_flex().size_full().p(16).gap(10).bg(t.background).rounded(10).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, rows, cx))
      .child(h_flex().gap(6).items_center()
        .children(FILTERS.map(chip))
        .child(div().flex_1())
        .child(h_flex().id("search").w(220).h(28).px(8).rounded(6).border(1).border_color(t.input).bg(t.surface)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
        .child(div().text_size(11.5).text_color(t.dim).child("/ search · j k enter")))
      .child(h_flex().px(8).pb(4).gap(8).border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child("Ticket"))
        .children(COLS.map(([name, w]) => div().w(w).flex_none().child(name))))
      .child(v_flex().id("rows").flex_1().overflow_y_scroll()
        .children(rows.map((x, i) => {
          const g = groupOf(x);
          const done = x.state === "merged" || x.state === "closed";
          return h_flex().id(`row-${x.id}`).h(34).px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(focused && i === this.at, (el) => el.bg(t.selected))
            .hover((st) => st.bg(t.hover))
            .on_click(() => open(x.id))
            .child(h_flex().flex_1().gap(8).items_center()
              .child(div().size(7).flex_none().rounded_full().bg(done ? t.done : t[DOT[g]]).opacity(done ? 0.5 : 1))
              .child(div().truncate().text_color(done ? t.muted : t.foreground).child(`#${x.id} ${x.title}`)))
            .child(cell(230, subtitle(x, now), g === "needs" ? t.blocked : x.where === "cloud" ? t.accent : t.muted))
            .child(cell(100, x.blueprint, t.muted))
            .child(cell(90, x.tokens.input ? `${(x.tokens.input / 1e6).toFixed(1)}M` : "–", t.muted))
            .child(cell(70, x.usd ? `$${x.usd.toFixed(2)}` : "–", t.foreground));
        }))
        .when(!rows.length, (el) => el.child(div().p(12).text_color(t.dim).child("No tickets match."))));
  }
}
