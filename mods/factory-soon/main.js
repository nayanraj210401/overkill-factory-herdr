import { View, div, image } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props } from "herdr";
import { page } from "./lib/pages.js";

const ASPECT = 1340 / 1020; // the docs/layouts mockups

// The card every unbuilt page shows: what it will be, when, and its mockup.
export default class FactorySoon extends View {
  init() {
    this.size = { width: 800, height: 600 };
  }
  render() {
    const t = theme();
    const p = page(props()?.page);
    const w = Math.max(0, Math.min(this.size.width - 48, (this.size.height - 150) * ASPECT, 900));
    return v_flex().id("root").size_full().items_center().justify_center().gap(10).p(24).bg(t.background).rounded(10)
      .border(1).border_color(t.border).text_color(t.muted).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(div().px(8).py(2).rounded(6).bg(t.raised).text_size(11).text_color(t.accent).child(`Coming in ${p.milestone}`))
      .child(div().text_size(20).font_semibold().text_color(t.foreground).child(p.title))
      .child(div().max_w(560).child(p.what))
      .when(w > 160, (el) => el.child(image(`mods/factory-soon/previews/${p.preview}`).w(w).h(w / ASPECT).mt(6).rounded(8).opacity(0.85)));
  }
}
