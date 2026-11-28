import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, layout, checking, watchFolder } from "herdr";
import { PAGES, STACK, activePage } from "./lib/pages.js";
import { reviewCount } from "./lib/reviews.js";
import { status, readReviews, root } from "./lib/store.js";

// The factory menu at the foot of the sidebar. The highlight comes from the
// live layout, so the ⌘ keys and clicks agree. Reviews carries a count of teammates' PRs waiting.
export default class FactoryMenu extends View {
  init(_props, cx) {
    this.reviews = null; // reviews.json's doc, the Reviews page's data; null falls back to status.json's count
    cx.spawn(async (cx) => {
      for (;;) {
        this.reviews = (await readReviews()).doc;
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(root());
        await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
        watch.cancel();
      }
    });
  }

  render() {
    const t = theme();
    const active = activePage(layout()).id;
    const s = status();
    const waiting = s ? reviewCount(this.reviews, s.to_review) : 0;
    return v_flex().size_full().px(8).pt(10).pb(6).gap(2).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("FACTORY"))
      .children(PAGES.filter((p) => p.key).map((p) => {
        const on = p.id === active;
        const badge = p.id === "reviews" && waiting > 0 ? String(waiting) : null;
        return h_flex().id(`page-${p.id}`).h(28).px(8).gap(9).items_center().rounded(7).cursor_pointer()
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.select", { stack: STACK, child: p.id }))
          .child(svg(`mods/workspace-chrome/${p.icon}.svg`).size(14))
          .child(div().flex_1().child(p.title))
          .when(!!badge, (el) => el.child(div().id("reviews-badge").flex_none().px(6).rounded(8).bg(t.accent).text_size(10.5).font_semibold()
            .text_color(t.accent_foreground).child(badge)))
          .child(div().text_size(11).text_color(t.dim).child(`⌘${p.key}`));
      }));
  }
}
