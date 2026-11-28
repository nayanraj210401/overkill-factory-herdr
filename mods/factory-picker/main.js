// The factory picker: every factory on this machine, its repos and live counts, with Herdr's
// agent-status dot. Opened as a popup (mod.json) by the brand row or ⌘K. j/k or arrows and
// enter, or a click, show that factory's space (lib/store.js switchFactory); Esc closes.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { countsText } from "./lib/factories.js";
import { factoryRows, switchFactory } from "./lib/store.js";
import { keyAction, clamp } from "./lib/keys.js";

export default class FactoryPicker extends View {
  init(_props, cx) {
    this.at = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus()); // the overlay takes focus once it's shown
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  pick(r) {
    if (!r) return;
    this.close();
    switchFactory(r.name);
  }

  dot(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    return div().w(12).flex_none().text_color(t[st] ?? t.dim).child(st === "idle" ? "○" : "●");
  }

  render() {
    const t = theme();
    const rows = factoryRows();
    if (this.at === null) this.at = Math.max(0, rows.findIndex((r) => r.current));
    this.at = clamp(this.at, rows.length);
    const row = (r, i) => h_flex().id(`fp-${i}`).mx(4).px(10).py(7).gap(10).items_start().rounded(7).cursor_pointer()
      .when(i === this.at, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.pick(r))
      .child(div().pt(3).child(this.dot(t, r.dot)))
      .child(v_flex().flex_1().min_w_0().gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().truncate().text_color(t.foreground).when(r.current, (d) => d.font_semibold()).child(r.name))
          .when(r.current, (el) => el.child(div().text_size(11).text_color(t.dim).child("shown"))))
        .child(div().truncate().text_size(11.5).text_color(t.muted).child(r.repos.join(" · ") || "no repos"))
        .child(div().text_size(11.5).text_color(r.counts?.needs ? t.blocked : t.dim).child(countsText(r.counts))));
    return v_flex().id("factory-picker").track_focus(this.handle)
      .on_key_down((e, cx) => {
        const a = keyAction(e);
        if (e.key === "escape") this.close();
        else if (a?.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
        else if (a?.kind === "open") this.pick(rows[this.at]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .w_full().p(14).gap(8).bg(t.popover).text_size(13)
      .child(h_flex().items_center().px(4)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Factories"))
        .child(div().id("fp-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(rows.length
        ? v_flex().id("fp-list").max_h(300).gap(2).overflow_y_scrollbar().children(rows.map(row)) // natural height: a flex_1 list collapses to nothing when the popup sizes to its content
        : div().px(4).text_color(t.muted).child("No factories yet: run `factory init` in a repo."));
  }
}
