import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, agents } from "herdr";
import { status } from "./lib/store.js";

// The status bar: agents, cloud, watched PRs, plan windows, failing rules.
export default class FactoryStatus extends View {
  render() {
    const t = theme();
    const s = status();
    const bar = h_flex().size_full().px(14).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted);
    if (!s) return bar.child("no factory status");
    const running = s.tickets.filter((x) => x.state === "running");
    const parts = [
      `${agents().length} ${agents().length === 1 ? "agent" : "agents"}`,
      `${running.filter((x) => x.where === "cloud").length} in cloud`,
      `${s.tickets.filter((x) => x.pr?.watched).length} PR watched`,
      `5h window ${Math.round(s.plan.window_5h * 100)}%`,
      `week ${Math.round(s.plan.week * 100)}%`,
      `${s.rules_failing} rules failing`,
    ];
    return bar.child(div().size(6).rounded_full().bg(s.rules_failing ? t.blocked : t.done)).child(parts.join(" · "));
  }
}
