import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, window, run, spaces, nextCommand, checking } from "herdr";
import { compact, planPct } from "./lib/model.js";
import { brandSub, needsLine } from "./lib/factories.js";
import { startLoader, state, wake, factoryRows, switchFactory, stepFactory } from "./lib/store.js";

const openPicker = () => run("mod.open", { name: "factory-picker" });

// Top of the sidebar: the factory switcher (name ▾, lead repo · branch · N repos), a line when
// another factory needs you, then daemon and plan window. With props.footer: the budget bar.
// The brand copy is always shown, so it runs the one status.json loader for every mod, and
// takes `factory-chrome.needs-next` / `needs-prev` (⌘J and ⇧⌘J in keys.json).
export default class FactoryChrome extends View {
  init(_props, cx) {
    if (props()?.footer) return;
    startLoader(cx);
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c.endsWith("needs-next")) stepFactory(1);
        else if (c.endsWith("needs-prev")) stepFactory(-1);
        cx.notify();
      }
    });
  }

  footer(t, s) {
    const used = s.today.tokens.input / s.today.budget.input;
    return v_flex().size_full().px(16).py(8).gap(5).bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(h_flex().child(div().flex_1().child(`Today ${compact(s.today.tokens.input)} / ${compact(s.today.budget.input)} in`)).child(`$${s.today.usd.toFixed(2)}`))
      .child(div().h(4).w_full().rounded(2).bg(t.raised)
        .child(div().h(4).w(`${Math.min(100, used * 100).toFixed(1)}%`).rounded(2).bg(used > 0.8 ? t.blocked : t.accent)));
  }

  // The switcher: a click opens the factory picker.
  name(t, s) {
    const branch = spaces().find((x) => x.active)?.branch ?? null;
    const sub = s ? brandSub(s, branch) : "";
    return v_flex().id("factory-name").gap(1).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // not a window drag
      .on_click(openPicker)
      .child(h_flex().gap(6).items_center().text_size(15).font_semibold().text_color(t.foreground)
        .child(div().truncate().child(s?.factory.name ?? "factory"))
        .child(div().flex_none().text_size(11).text_color(t.muted).hover((st) => st.text_color(t.foreground)).child("▾")))
      .when(Boolean(sub), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(sub)));
  }

  // "⚠ shop: 1 needs you +1", only when another factory has something waiting; a click goes there.
  others(t, s) {
    const line = needsLine(factoryRows(), s?.factory.name ?? null);
    if (!line) return null;
    return div().id("other-needs").truncate().text_size(12).text_color(t.blocked).cursor_pointer()
      .hover((st) => st.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => switchFactory(line.name))
      .child(line.text);
  }

  render() {
    const t = theme();
    const { status: s, errors } = state();
    if (props()?.footer) return s ? this.footer(t, s) : div().size_full().bg(t.chrome);
    wake();
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const line = s
      ? h_flex().id("daemon-line").gap(6).items_center().cursor_pointer().hover((st) => st.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // not a window drag
          .on_click(() => run("layout.select", { stack: "pages", child: "config" }))
          .child(div().size(7).rounded_full().bg(s.factory.daemon ? t.done : t.dim))
          .child(`${s.source === "fixture" ? "sample data" : s.factory.daemon ? "daemon on" : "daemon off"} · 5h ${planPct(s.plan, "window_5h")}`)
      : div().text_color(t.blocked).truncate().child(errors[0] ?? "no status");
    return v_flex().size_full().justify_end().px(16).pb(8).bg(t.chrome).when(mac, (el) => el.pt(30))
      .child(this.name(t, s))
      .children([this.others(t, s)].filter(Boolean))
      .child(div().text_size(12).text_color(t.muted).child(line));
  }
}
