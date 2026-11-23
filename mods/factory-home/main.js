import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, props, exec, notify, home } from "herdr";
import { needsYou, overwatchNotes, ago, compact, repoBadge, warnMark, holdText, localRunning, healthLine } from "./lib/model.js";
import { STACK } from "./lib/pages.js";
import { keyAction, clamp } from "./lib/keys.js";
import { status, state, act, sampleOn, showSample, peekAgent } from "./lib/store.js";
import { cliCommand, talkable } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { SETUP_SAMPLE, setupProgress } from "./lib/setup.js";

// HH:MM, local; the mod runtime ignores toLocaleTimeString's options.
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const open = (id) => {
  setShared("factory.ticket", id);
  run("layout.select", { stack: STACK, child: "ticket" });
};
// A ticket whose agent waits on you opens straight into that agent's live terminal.
const visit = (t) => (t.needs?.kind === "attention" && t.terminal ? peekAgent(t) : open(t.id));

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
    else if (a.kind === "open" && items[this.at]) visit(items[this.at]);
    else act(a, items[this.at]);
    cx.stop_propagation();
    cx.notify();
  }

  card(t, s, { ticket, kind }, now, on) {
    const badge = repoBadge(s, ticket);
    const color = kind === "merge" ? t.done : t.blocked;
    const tag = kind === "attention" ? "needs your attention · e" : kind === "question" ? "grooming · waiting on you" : kind === "parked" ? (talkable(ticket) ? "asks you · u talks it through" : "parked")
      : ticket.pr?.watched && ticket.pr.checked_at ? `watching · checked ${ago(ticket.pr.checked_at, now)}` : "ready to merge";
    return h_flex().id(`n-${ticket.id}`).rounded(8).bg(t.surface).border(1).border_color(on ? t.accent : t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => visit(ticket))
      .child(div().w(3).h_full().rounded_l(8).bg(color))
      .child(v_flex().flex_1().px(14).py(10).gap(3)
        .child(h_flex().gap(8)
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(`#${ticket.id} ${ticket.title}`))
          .when(!!badge, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(badge)))
          .child(div().text_size(12).text_color(color).child(tag)))
        .child(div().text_color(t.muted).child(ticket.needs?.text ?? ticket.detail ?? "")));
  }

  // A note another agent left for Overwatch to bring to you: opens its ticket, else Overwatch.
  noteCard(t, a) {
    return h_flex().id(`an-${a.id}`).rounded(8).bg(t.surface).border(1).border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => (a.ticket ? open(a.ticket) : run("layout.select", { stack: STACK, child: "overwatch" })))
      .child(div().w(3).h_full().rounded_l(8).bg(t.accent))
      .child(v_flex().flex_1().px(14).py(10).gap(3)
        .child(h_flex().gap(8)
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(a.ticket ? `#${a.ticket} · ${a.route}` : a.route))
          .child(div().text_size(12).text_color(t.accent).child(a.delivered ? "with Overwatch · click to talk" : "for Overwatch")))
        .child(div().text_color(t.muted).child(a.text)));
  }

  // A space whose repo has no factory: start one here (factory init, then setup's checklist),
  // or look at the sample, never the sample unasked.
  noFactoryPage(t, none, cx) {
    const tilde = (p) => (p ?? "").replace(home(), "~");
    const cmd = `factory init --name ${none.name} --path ${tilde(none.folder)}`;
    const button = (id, label, on, primary) => div().id(id).px(12).py(6).rounded(6).cursor_pointer()
      .bg(primary ? t.accent : t.surface).border(1).border_color(primary ? t.accent : t.border)
      .text_color(primary ? t.background : t.foreground).hover((st) => st.opacity(0.85)).on_click(on).child(label);
    return v_flex().id("home").size_full().px(18).pb(16).gap(10).bg(t.background).rounded(10).text_size(13).overflow_y_scroll()
      .child(div().pt(12).text_size(18).font_semibold().text_color(t.foreground).child(`No factory for ${none.name ?? "this space"} yet`))
      .when(!!none.folder, (el) => el.child(div().text_color(t.muted).child(`${tilde(none.folder)} has no factory. Start one here: it records the repo and its GitHub origin, then Home shows the setup checklist.`)))
      .when(!none.name || !none.folder, (el) => el.child(div().text_color(t.muted).child("Open a space on a repo's folder (Herdr's space picker) to start its factory.")))
      .when(!!none.name && !!none.folder, (el) => el.child(v_flex().gap(4).p(12).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.dim).child("runs"))
        .child(div().text_size(12).text_color(t.accent).child(cmd))))
      .child(h_flex().gap(8)
        .when(!!none.name && !!none.folder, (el) => el.child(button("init", this.initing ? "Starting…" : "Start a factory here", (_e, cx) => this.init_(none, cx), true)))
        .child(button("sample", "Show the sample instead", (_e, cx) => showSample(true, cx), false)));
  }

  init_(none, cx) {
    if (this.initing) return;
    this.initing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, `${home()}/.factory/${none.name}`, ["init", "--path", none.folder]);
      const r = await exec(c.command, c.args, { cwd: none.folder, timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.initing = false;
      if (r.code) notify({ title: "factory init failed", body: String(r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      cx.notify(); // the loader picks up the new status.json within 5 s
    });
  }

  // The sample is on: say so above everything, with the way back.
  sampleBanner(t) {
    return h_flex().id("sample-banner").gap(10).items_center().px(12).py(8).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
      .child(div().flex_1().min_w_0().text_color(t.blocked).child("Sample data (acme-api), not your factory"))
      .child(div().id("sample-off").text_size(12).text_color(t.accent).cursor_pointer().on_click((_e, cx) => showSample(false, cx)).child("Hide the sample"));
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
    if (!live && state().none) return this.noFactoryPage(t, state().none);
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
      .when(s.source === "fixture" && sampleOn(), (el) => el.child(div().pt(12).child(this.sampleBanner(t))))
      .when(Boolean(away), (el) => el.child(section(s.away.on ? `Away since ${clock(s.away.since)}` : `While you were away · ${clock(s.away.since)} – ${clock(s.away.until)}`))
        .child(v_flex().gap(2).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .children(s.away.events.map((e, i) => h_flex().id(`aw-${i}`).h(24).gap(10).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
            .on_click(() => e.ticket != null && open(e.ticket))
            .child(div().w(44).text_color(t.dim).child(clock(e.at)))
            .child(div().w(52).text_color(t.muted).child(e.ticket != null ? `#${e.ticket}` : ""))
            .child(div().w(70).text_color(t.dim).truncate().child(e.who))
            .child(div().flex_1().min_w_0().text_color(t.foreground).truncate().child(e.what))))
          .when(!s.away.events.length, (el) => el.child(div().text_color(t.dim).child("Nothing happened.")))))
      .when(Boolean(holdText(s)), (el) => el.child(v_flex().id("hold").mt(8).p(10).gap(2).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child(holdText(s)))
        .child(div().text_color(t.muted).child("Tickets already running carry on; queued ones wait."))))
      .children((s.tracked_factory ?? []).map((x) => v_flex().id(`tracked-${x.repo}`).mt(8).p(10).gap(2).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child(`${x.repo} tracks .factory/ in git (${x.files} file${x.files === 1 ? "" : "s"}); it should stay on this machine`))
        .child(div().text_color(t.muted).child("Its PRs never carry it. To stop tracking it, run this yourself in the repo:"))
        .child(div().text_color(t.accent).child(x.fix))))
      .child(section("Needs you"))
      .children(overwatchNotes(s.asks).map((a) => this.noteCard(t, a)))
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
        .child(tile("Revert rate", `${Math.round(d.revert_rate * 100)}%`)))
      .children((s.auto_gates ?? []).map((g) => div().id(`auto-${g.blueprint}`).pt(6).text_size(12).text_color(g.reverted ? t.blocked : t.muted)
        .child(`${g.blueprint} merges itself (gate: auto) · ${g.reverted} of ${g.merged} merged in 30 days reverted (${Math.round(g.revert_rate * 100)}%)`)))
      .when((s.health ?? []).length > 0, (el) => el.child(section("Repo health")).children(s.health.map((h) => this.healthRow(t, h, now))));
  }

  // One repo's last scheduled full-suite run; a failure opens the ticket it filed.
  healthRow(t, h, now) {
    const l = healthLine(h, now);
    const color = { pass: t.done, fail: t.blocked, none: t.dim }[l.tone];
    return h_flex().id(`health-${h.repo}`).gap(10).px(4).py(4).items_start().rounded(6)
      .when(h.ticket != null, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => open(h.ticket)))
      .child(div().mt(5).size(7).rounded_full().bg(color))
      .child(v_flex().flex_1().min_w_0().gap(2)
        .child(div().text_color(l.tone === "pass" ? t.muted : t.foreground).truncate().child(l.text))
        .when(!!l.detail, (el) => el.child(div().text_size(12).text_color(t.dim).truncate().child(l.detail))));
  }
}
