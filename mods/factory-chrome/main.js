import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, window, run, notify } from "herdr";
import { compact, factoryRepos } from "./lib/model.js";
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

  // "acme-api · 2 repos" when the factory has more than one; a click lists them, lead first.
  name(t, s) {
    const repos = s ? factoryRepos(s) : [];
    const el = h_flex().id("factory-name").gap(6).items_center().text_size(15).font_semibold().text_color(t.foreground)
      .child(div().truncate().child(s?.factory.name ?? "factory"));
    if (repos.length < 2) return el;
    return el.cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // not a window drag
      .on_click(() => notify({ title: `${s.factory.name}: ${repos.length} repos`, body: repos.map((r, i) => (i ? r : `${r} (lead)`)).join("\n"), level: "info", timeout: 5000 }))
      .child(div().flex_none().text_size(12).font_normal().text_color(t.muted).hover((st) => st.text_color(t.foreground)).child(`· ${repos.length} repos`));
  }

  render() {
    const t = theme();
    const { status: s, errors } = state();
    if (props()?.footer) return s ? this.footer(t, s) : div().size_full().bg(t.chrome);
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    const line = s
      ? h_flex().id("daemon-line").gap(6).items_center().cursor_pointer().hover((st) => st.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // not a window drag
          .on_click(() => run("layout.select", { stack: "pages", child: "config" }))
          .child(div().size(7).rounded_full().bg(s.factory.daemon ? t.done : t.dim))
          .child(`${s.source === "fixture" ? "sample data" : s.factory.daemon ? "daemon on" : "daemon off"} · 5h ${Math.round(s.plan.window_5h * 100)}%`)
      : div().text_color(t.blocked).truncate().child(errors[0] ?? "no status");
    return v_flex().size_full().justify_end().px(16).pb(8).bg(t.chrome).when(mac, (el) => el.pt(30))
      .child(this.name(t, s))
      .child(div().text_size(12).text_color(t.muted).child(line));
  }
}
