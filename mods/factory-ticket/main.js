import { View, div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, shared, readTextFile, nextCommand, checking, notify } from "herdr";
import { parseStatusMd, TICKET_TABS, compact, currentTicket } from "./lib/model.js";
import { root, status, state } from "./lib/store.js";
import { keyAction } from "./lib/keys.js";

// One ticket: its stage timeline (STATUS.md) and its Markdown as numbered tabs,
// beside the live agent terminal once M2 starts agents (docs/layouts/02-ticket.png).
export default class FactoryTicket extends View {
  init(_props, cx) {
    this.id = null;
    this.files = {};
    this.tab = "1";
    this.handle = cx.focus_handle();
    if (!checking()) cx.spawn(async (cx) => {
      for (;;) {
        const m = (await nextCommand()).match(/tab-(\d)$/);
        if (m) this.tab = m[1];
        cx.notify();
      }
    });
  }

  load(id, cx) {
    if (this.id !== id) this.files = {};
    this.id = id;
    this.at = state().at;
    cx.spawn(async (cx) => {
      const dir = `${root()}/tickets/${id}`;
      for (const name of ["STATUS.md", ...TICKET_TABS.map((t) => t.file)]) this.files[name] = await readTextFile(`${dir}/${name}`);
      if (this.id === id) cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const s = status();
    const ticket = s && currentTicket(s.tickets, shared("factory.ticket"));
    if (!ticket) return div().size_full().bg(t.background);
    // The daemon rewrites these files with each status.json, so re-read on every reload.
    if (ticket.id !== this.id || state().at !== this.at) this.load(ticket.id, cx);
    const { summary, stages } = parseStatusMd(this.files["STATUS.md"]);
    const dot = (state) => div().size(12).flex_none().mt(3).rounded_full()
      .bg(state === "done" ? t.done : state === "now" ? t.working : t.raised).border(1).border_color(state === "next" ? t.border : t.background);
    const tab = TICKET_TABS.find((x) => x.key === this.tab);
    const body = this.files[tab.file];
    return h_flex().size_full().gap(8).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        // Bare 1-4 switch tabs here, as in the mockup; actions toast until their milestone.
        if (/^[1-4]$/.test(e.key) && !e.modifiers.platform && !e.modifiers.control) { this.tab = e.key; cx.stop_propagation(); cx.notify(); return; }
        const a = keyAction(e);
        if (a?.kind === "soon") { notify({ title: `${a.label}: coming in ${a.milestone}`, level: "info", timeout: 2500 }); cx.stop_propagation(); }
      })
      .child(v_flex().id("ticket").flex_1().h_full().p(16).gap(10).rounded(10).bg(t.background).border(1).border_color(t.border).overflow_y_scroll()
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child(`#${ticket.id} ${ticket.title}`))
        .child(div().text_color(t.muted).child(summary || `${ticket.state} · no STATUS.md yet`))
        .child(v_flex().gap(10).pt(4)
          .children(stages.map((st) => h_flex().gap(12)
            .child(dot(st.state))
            .child(v_flex().flex_1()
              .child(div().font_semibold().text_color(st.state === "next" ? t.dim : t.foreground).child(st.name))
              .when(Boolean(st.detail), (el) => el.child(div().text_color(t.muted).child(st.detail))))
            .when(Boolean(st.time), (el) => el.child(div().text_color(st.state === "now" ? t.accent : t.muted).child(st.state === "now" ? `${st.time} so far` : st.time))))))
        .child(div().h(1).bg(t.border).my(4))
        .child(h_flex().gap(4)
          .children(TICKET_TABS.map((x) => div().id(`tab-${x.key}`).px(10).py(4).rounded(6).cursor_pointer()
            .bg(x.key === this.tab ? t.selected : t.background).text_color(x.key === this.tab ? t.foreground : t.muted)
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { this.tab = x.key; cx.notify(); })
            .child(`${x.key} ${x.title}`)))
          .child(div().flex_1())
          .child(div().text_size(11.5).text_color(t.dim).child("⌘⌥1–4")))
        .child(body ? TextView.markdown(`md-${ticket.id}-${tab.file}`, body) : div().text_color(t.dim).child(`No ${tab.file} yet.`)))
      .child(v_flex().w(380).flex_none().h_full().p(14).gap(8).rounded(10).bg(t.surface).border(1).border_color(t.border).text_color(t.muted)
        .child(div().text_color(t.foreground).child(`${ticket.stage ?? ticket.state} · ${compact(ticket.tokens.input)} in · ${compact(ticket.tokens.output)} out`))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child("The live agent terminal opens here with e once the daemon starts agents (M2).")));
  }
}
