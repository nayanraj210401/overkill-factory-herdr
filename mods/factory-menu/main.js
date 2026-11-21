import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, layout } from "herdr";
import { PAGES, STACK, activePage } from "./lib/pages.js";

// The factory menu at the foot of the sidebar. The highlight comes from the
// live layout, so ⌘1–⌘7 and clicks agree.
export default class FactoryMenu extends View {
  render() {
    const t = theme();
    const active = activePage(layout()).id;
    return v_flex().size_full().px(8).pt(10).pb(6).gap(2).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("FACTORY"))
      .children(PAGES.filter((p) => p.key).map((p) => {
        const on = p.id === active;
        return h_flex().id(`page-${p.id}`).h(28).px(8).gap(9).items_center().rounded(7).cursor_pointer()
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.select", { stack: STACK, child: p.id }))
          .child(svg(`mods/workspace-chrome/${p.icon}.svg`).size(14))
          .child(div().flex_1().child(p.title))
          .child(div().text_size(11).text_color(t.dim).child(`⌘${p.key}`));
      }));
  }
}
