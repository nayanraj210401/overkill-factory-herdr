import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, window } from "herdr";
import { compact } from "./lib/model.js";
import { startLoader, state } from "./lib/store.js";

// Top of the sidebar: factory name, daemon, plan window. With props.footer: the day's budget bar.
// The brand copy is always shown, so it runs the one status.json loader for every mod.
export default class FactoryChrome extends View {
  init(_props, cx) {
    if (!props()?.footer) startLoader(cx);
  }

  footer(t, s) {
    const used = s.today.tokens.input / s.today.budget.input;
    return v_flex().size_full().px(16).py(8).gap(5).bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(h_flex().child(div().flex_1().child(`Today ${compact(s.today.tokens.input)} / ${compact(s.today.budget.input)} in`)).child(`$${s.today.usd.toFixed(2)}`))
      .child(div().h(4).w_full().rounded(2).bg(t.raised)
        .child(div().h(4).w(`${Math.min(100, used * 100).toFixed(1)}%`).rounded(2).bg(used > 0.8 ? t.blocked : t.accent)));
  }

  render() {
    const t = theme();
    const { status: s, errors } = state();
    if (props()?.footer) return s ? this.footer(t, s) : div().size_full().bg(t.chrome);
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const line = s
      ? h_flex().gap(6).items_center()
          .child(div().size(7).rounded_full().bg(s.factory.daemon ? t.done : t.dim))
          .child(`${s.source === "fixture" ? "sample data" : s.factory.daemon ? "daemon on" : "daemon off"} · 5h ${Math.round(s.plan.window_5h * 100)}%`)
      : div().text_color(t.blocked).truncate().child(errors[0] ?? "no status");
    return v_flex().size_full().justify_end().px(16).pb(8).bg(t.chrome).when(mac, (el) => el.pt(30))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(s?.factory.name ?? "factory"))
      .child(div().text_size(12).text_color(t.muted).child(line));
  }
}
