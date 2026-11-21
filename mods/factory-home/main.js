import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, props } from "herdr";
import { needsYou, ago, compact, repoBadge, warnMark, holdText, localRunning } from "./lib/model.js";
import { STACK } from "./lib/pages.js";
import { keyAction, clamp } from "./lib/keys.js";
import { status, act } from "./lib/store.js";
import { SETUP_SAMPLE, setupProgress } from "./lib/setup.js";

// HH:MM, local; the mod runtime ignores toLocaleTimeString's options.
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const open = (id) => {
  setShared("factory.ticket", id);
  run("layout.select", { stack: STACK, child: "ticket" });
};

// Home: what needs you, then what runs, then today's four numbers (docs/layouts/01-home.png).
export default class FactoryHome extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.at = 0;
    this.hold = props()?.hold ?? null; // a prop only smoke.sh passes: the sample data has no hold
  }

  // j/k walk Needs you then Running; enter opens; action keys act on the selected ticket.
  key(e, items, cx) {
    const a = keyAction(e);
    if (!a) return;
    if (a.kind === "move") this.at = clamp(this.at + a.delta, items.length);
    else if (a.kind === "open" && items[this.at]) open(items[this.at].id);
    else act(a, items[this.at]);
    cx.stop_propagation();
    cx.notify();
  }

  card(t, s, { ticket, kind }, now, on) {
    const badge = repoBadge(s, ticket);
    const color = kind === "merge" ? t.done : t.blocked;
    const tag = kind === "question" ? "grooming · waiting on you" : kind === "parked" ? "parked"
      : ticket.pr?.watched && ticket.pr.checked_at ? `watching · checked ${ago(ticket.pr.checked_at, now)}` : "ready to merge";
    return h_flex().id(`n-${ticket.id}`).rounded(8).bg(t.surface).border(1).border_color(on ? t.accent : t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => open(ticket.id))
      .child(div().w(3).h_full().rounded_l(8).bg(color))
      .child(v_flex().flex_1().px(14).py(10).gap(3)
        .child(h_flex().gap(8)
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(`#${ticket.id} ${ticket.title}`))
          .when(!!badge, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(badge)))
          .child(div().text_size(12).text_color(color).child(tag)))
        .child(div().text_color(t.muted).child(ticket.needs?.text ?? ticket.detail ?? "")));
  }

  setupPage(t, setup) {
    const p = setupProgress(setup);
    const dot = { ok: t.done, missing: t.blocked, skipped: t.dim };
    const word = { ok: "done", missing: "to do", skipped: "skipped" };
    return v_flex().id("home").size_full().px(18).pb(16).gap(8).bg(t.background).rounded(10).text_size(13).overflow_y_scroll()
      .child(div().pt(12).text_size(18).font_semibold().text_color(t.foreground).child("Set up the factory"))
      .child(div().text_color(t.muted).child(`This repo has no .factory/ folder yet. ${p.text}. Run each fix in a terminal; rerun any time with factory setup.`))
      .children(setup.steps.map((st) => v_flex().id(`su-${st.id}`).gap(4).p(12).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .child(h_flex().gap(10).items_center()
          .child(div().size(8).rounded_full().bg(dot[st.status]))
          .child(div().flex_1().min_w_0().font_semibold().text_color(st.status === "ok" ? t.muted : t.foreground).child(st.label))
          .child(div().text_size(12).text_color(dot[st.status]).child(word[st.status])))
        .when(st.status !== "ok" && !!st.fix, (el) => el.child(h_flex().gap(8).pl(18)
          .child(div().text_size(12).text_color(t.dim).child("fix"))
          .child(div().flex_1().min_w_0().text_size(12).text_color(t.accent).child(st.fix))))
        .when(st.status === "missing", (el) => el.child(div().pl(18).text_size(12).text_color(t.dim).child(`not now: factory setup skip ${st.id}`)))));
  }

  render() {
    const t = theme();
    const live = status();
    if (!live) return div().size_full().bg(t.background);
    const s = this.hold ? { ...live, plan: { ...live.plan, hold: this.hold } } : live;
    const now = Date.now();
    // No .factory/ yet: the setup checklist, in place of everything else.
    const setup = props()?.setup ? SETUP_SAMPLE : s.setup; // the prop is only smoke.sh's
    if (setup) return this.setupPage(t, setup);
    const section = (title) => div().pt(12).pb(4).text_size(15).font_semibold().text_color(t.foreground).child(title);
    const running = s.tickets.filter((x) => x.state === "running");
    const needs = needsYou(s.tickets);
    const items = [...needs.map((n) => n.ticket), ...running];
    const focused = this.handle.is_focused();
    const d = s.today;
    // The digest shows while you're away and for a day after you're back.
    const away = s.away && (s.away.on || now - Date.parse(s.away.until) < 86_400_000 || s.source === "fixture") ? s.away : null;
    const tile = (label, value) => v_flex().flex_1().p(14).gap(6).rounded(8).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(div().text_size(26).font_semibold().text_color(t.foreground).child(value));
    return v_flex().id("home").size_full().px(18).pb(16).gap(8).bg(t.background).rounded(10).text_size(13).overflow_y_scroll()
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, items, cx))
      .when(Boolean(away), (el) => el.child(section(s.away.on ? `Away since ${clock(s.away.since)}` : `While you were away · ${clock(s.away.since)} – ${clock(s.away.until)}`))
        .child(v_flex().gap(2).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .children(s.away.events.map((e, i) => h_flex().id(`aw-${i}`).h(24).gap(10).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
            .on_click(() => e.ticket != null && open(e.ticket))
            .child(div().w(44).text_color(t.dim).child(clock(e.at)))
            .child(div().w(52).text_color(t.muted).child(e.ticket != null ? `#${e.ticket}` : ""))
            .child(div().w(70).text_color(t.dim).truncate().child(e.who))
            .child(div().flex_1().text_color(t.foreground).truncate().child(e.what))))
          .when(!s.away.events.length, (el) => el.child(div().text_color(t.dim).child("Nothing happened.")))))
      .when(Boolean(holdText(s)), (el) => el.child(v_flex().id("hold").mt(8).p(10).gap(2).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child(holdText(s)))
        .child(div().text_color(t.muted).child("Tickets already running carry on; queued ones wait."))))
      .child(section("Needs you"))
      .children(needs.map((n, i) => this.card(t, s, n, now, focused && i === this.at)))
      .child(section("Running"))
      .children(running.map((x, i) => h_flex().id(`r-${x.id}`).h(30).px(4).gap(10).items_center().rounded(6).cursor_pointer()
        .when(focused && needs.length + i === this.at, (el) => el.bg(t.selected))
        .hover((st) => st.bg(t.hover)).on_click(() => open(x.id))
        .child(div().size(7).rounded_full().bg(t.working))
        .child(div().flex_1().min_w_0().text_color(t.foreground).truncate().child(`#${x.id} ${x.title}`))
        .when(!!warnMark(x), (el) => el.child(div().flex_none().px(6).rounded(8).text_size(11).border(1).border_color(t.blocked).text_color(t.blocked).child(warnMark(x))))
        .when(!!repoBadge(s, x), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(repoBadge(s, x))))
        .child(div().w(200).text_color(x.where === "cloud" ? t.accent : t.muted).truncate()
          .child(x.where === "cloud" ? `${x.stage} · in cloud` : [x.stage, x.detail].filter(Boolean).join(" · ")))
        .child(div().w(70).text_color(t.muted).child(`${compact(x.tokens.input)} in`))
        .child(div().w(50).text_color(t.foreground).child(`$${x.usd.toFixed(2)}`))))
      .when(!running.length, (el) => el.child(div().text_color(t.dim).child("Nothing running.")))
      .when(localRunning(s.tickets).length > 0, (el) => el.child(h_flex().pt(6)
        .child(div().id("cloud-all").px(10).py(6).rounded(6).border(1).border_color(t.accent).text_color(t.accent).cursor_pointer()
          .hover((st) => st.bg(t.hover)).on_click(() => act({ kind: "cloud-all" })).child("Move running tickets to cloud"))))
      .child(section("Today"))
      .child(h_flex().gap(10)
        .child(tile("Time to PR", `${d.time_to_pr_min}m`))
        .child(tile("Cost per PR", `$${d.cost_per_pr_usd.toFixed(2)}`))
        .child(tile("Interactions / PR", String(d.interactions_per_pr)))
        .child(tile("Revert rate", `${Math.round(d.revert_rate * 100)}%`)));
  }
}
