import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout } from "herdr";
import { activePage } from "./lib/pages.js";
import { status } from "./lib/store.js";

// Breadcrumb (factory › page) and the keys that work everywhere in factory mode.
export default class FactoryHeader extends View {
  render() {
    const t = theme();
    const p = activePage(layout());
    const name = status()?.factory.name ?? "factory";
    return h_flex().size_full().px(16).gap(6).items_center().bg(t.canvas).border_b(1).border_color(t.border).text_size(14)
      .child(div().text_color(t.muted).child(`${name} ›`))
      .child(div().font_semibold().text_color(t.foreground).child(p.title))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child("⌘1–⌘7 pages · ⌘⇧F back to Herdr"));
  }
}
