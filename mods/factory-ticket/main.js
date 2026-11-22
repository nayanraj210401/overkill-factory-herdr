import { View, div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, shared, readTextFile, nextCommand, checking, props, exec, notify } from "herdr";
import { parseStatusMd, TICKET_TABS, compact, currentTicket, crossRepoCards, repoBadge, stageDetail, stageRounds, questionCards, ANSWER_HOW } from "./lib/model.js";
import { root, status, state, peekAgent, act } from "./lib/store.js";
import { keyAction } from "./lib/keys.js";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

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

  // Refresh: the daemon's tick now (usage, agents, the PR on GitHub), then re-read the files.
  refresh(ticket, cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), ["refresh", String(ticket.id)]);
      const r = await exec(c.command, c.args, { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.refreshing = false;
      if (r.code) notify({ title: "Refresh failed", body: String(r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      this.at = null; // re-read STATUS.md and the tabs on the next render
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const s = status();
    const ticket = s && currentTicket(s.tickets, props()?.ticket ?? shared("factory.ticket")) // ticket: a prop only smoke.sh passes;
    if (!ticket) return div().size_full().bg(t.background);
    // The daemon rewrites these files with each status.json, so re-read on every reload.
    if (ticket.id !== this.id || state().at !== this.at) this.load(ticket.id, cx);
    const { summary, stages } = parseStatusMd(this.files["STATUS.md"]);
    const dot = (state) => div().size(12).flex_none().mt(3).rounded_full()
      .bg(state === "done" ? t.done : state === "now" ? t.working : t.raised).border(1).border_color(state === "next" ? t.border : t.background);
    const tab = TICKET_TABS.find((x) => x.key === this.tab);
    const button = (id, label, primary, onClick) => div().id(id).px(10).py(6).rounded(6).cursor_pointer().on_click(onClick)
      .bg(primary ? t.done : t.background).text_color(primary ? t.background : t.foreground).border(1).border_color(primary ? t.done : t.border)
      .hover((s) => s.opacity(0.88)).child(label);
    const body = this.files[tab.file];
    const cards = crossRepoCards(ticket);
    const badge = repoBadge(s, ticket);
    // A cross-repo ticket: a card per repo, in its repos' order, and the check across them.
    const repoCard = (c) => v_flex().id(`repo-${c.slug}`).flex_1().min_w_0().p(12).gap(4).rounded(8).bg(t.surface).border(1)
      .border_color(c.role === "lead" ? t.accent : t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(c.slug))
        .child(div().px(8).py(1).rounded(10).text_size(11.5).border(1).border_color(c.role === "lead" ? t.accent : t.border)
          .text_color(c.role === "lead" ? t.accent : t.muted).child(c.role)))
      .child(div().text_color(t.muted).truncate().child(c.branch))
      .child(div().pt(4).font_semibold().text_color(t.foreground).child(c.pr))
      .child(div().text_color(c.merged ? t.done : t.muted).child(c.order));
    const cross = cards && v_flex().gap(8)
      .child(h_flex().gap(8).items_center().children(cards.flatMap((c, i) => [...(i ? [div().text_color(t.dim).child("→")] : []), repoCard(c)])))
      .child(v_flex().id("cross-check").p(12).gap(2).rounded(8).border(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child("Cross-repo check"))
        .child(div().text_color(t.muted).child("factory.yaml's cross_check runs with every branch checked out together."))
        .child(div().text_color(t.muted).child(`Ready only when all ${cards.length} PRs and this check pass; m merges them in order.`)));
    const live = Boolean(ticket.terminal);
    const questions = questionCards(ticket);
    const asking = ticket.state === "grooming" && ticket.needs?.kind === "question";
    const actions = [
      ...(ticket.state === "ready" && ticket.pr ? [
        button("merge", cards ? `Merge ${cards.length} PRs in order  m` : `Merge PR #${ticket.pr.number}  m`, true, () => act({ kind: "merge" }, ticket)),
        button("send-back", "Send back  x", false, () => act({ kind: "send-back" }, ticket))] : []),
      ...(asking ? [button("answer", "Answer  u", true, () => act({ kind: "answer" }, ticket))] : []),
      ...(ticket.state === "parked" ? [button("answer", "Answer and restart  u", true, () => act({ kind: "answer" }, ticket))] : []),
      ...(!["grooming", "queued"].includes(ticket.state) ? [button("diff", "Diff  d", false, () => act({ kind: "diff" }, ticket))] : []),
      button("refresh", this.refreshing ? "Refreshing…" : "Refresh", false, () => this.refresh(ticket, cx)),
      ...(ticket.state === "running" || ticket.state === "paused" ? [button("pause", ticket.state === "paused" ? "Resume  p" : "Pause  p", false, () => act({ kind: "pause" }, ticket))] : []),
    ];
    // Several questions: numbered as the A1: answers are, each with its kind and who answers.
    const questionBox = questions.length > 0 && v_flex().id("questions").p(12).gap(8).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
      .child(div().font_semibold().text_color(t.foreground).child(`${questions.length} question${questions.length > 1 ? "s" : ""} waiting`))
      .children(questions.map((q) => h_flex().gap(10).items_start()
        .child(div().w(28).flex_none().font_semibold().text_color(t.blocked).child(q.label))
        .child(v_flex().flex_1().min_w_0().gap(1)
          .child(div().text_color(t.foreground).child(q.text))
          .child(div().text_size(12).text_color(q.kind === "product" ? t.muted : t.accent).child(`${q.who} · reply ${q.reply}`)))))
      .child(div().text_size(12).text_color(t.dim).child(ANSWER_HOW));
    return h_flex().size_full().gap(8).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        // Bare 1-4 switch tabs here, as in the mockup; action keys act on this ticket.
        if (/^[1-4]$/.test(e.key) && !e.modifiers.platform && !e.modifiers.control) { this.tab = e.key; cx.stop_propagation(); cx.notify(); return; }
        const a = keyAction(e);
        if (a && a.kind !== "move" && a.kind !== "open") { act(a, ticket); cx.stop_propagation(); }
      })
      .child(v_flex().id("ticket").flex_1().min_w_0().h_full().p(16).gap(10).rounded(10).bg(t.background).border(1).border_color(t.border).overflow_y_scroll()
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(17).font_semibold().text_color(t.foreground).child(`#${ticket.id} ${ticket.title}`))
          .when(!!badge, (el) => el.child(div().px(8).py(1).rounded(10).border(1).border_color(t.accent).text_size(12).text_color(t.accent).child(badge))))
        .child(div().text_color(t.muted).child(summary || `${ticket.state} · no STATUS.md yet`))
        .when(Boolean(ticket.warning), (el) => el.child(div().id("budget-warning").px(10).py(6).rounded(6).border(1).border_color(t.blocked).text_color(t.blocked).child(`Budget: ${ticket.warning}`)))
        .when(!live && actions.length > 0, (el) => el.child(h_flex().gap(8).flex_wrap().children(actions)))
        .when(!!questionBox, (el) => el.child(questionBox))
        .when(!!cross, (el) => el.child(cross))
        .child(v_flex().gap(10).pt(4)
          .children(stages.map((st) => h_flex().gap(12)
            .child(dot(st.state))
            .child(v_flex().flex_1().min_w_0()
              .child(h_flex().gap(8).items_center()
                .child(div().font_semibold().text_color(st.state === "next" ? t.dim : t.foreground).child(st.name))
                .when(Boolean(stageRounds(st)), (el) => el.child(div().text_size(12).text_color(t.muted).child(stageRounds(st)))))
              .when(Boolean(stageDetail(st, ticket).text), (el) => el.child(div().text_color(stageDetail(st, ticket).warn ? t.blocked : t.muted).child(stageDetail(st, ticket).text))))
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
      // The live column exists only while an agent runs; otherwise the page gets the width.
      .when(live, (el) => el.child(v_flex().w(380).flex_none().h_full().p(14).gap(8).rounded(10).bg(t.surface).border(1).border_color(t.border).text_color(t.muted)
        .child(div().text_color(t.foreground).child(`${ticket.stage ?? ticket.state} · ${compact(ticket.tokens.input)} in · ${compact(ticket.tokens.output)} out`))
        .child(div().text_color(t.dim).child(`Agent running in ${ticket.terminal}.`))
        .child(div().flex_1())
        .child(div().id("peek").px(10).py(6).rounded(6).border(1).border_color(t.accent).text_color(t.accent)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => peekAgent(ticket)).child("Open live terminal  e"))
        .children(actions)));
  }
}
