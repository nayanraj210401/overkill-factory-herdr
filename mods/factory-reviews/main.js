import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, notify, checking, watchFolder } from "herdr";
import { shapeReviews, splitFindings, findingsTally, riskLevel, label, key, sizeText, age, checksText, evidenceText, approveAsk, APPROVE_WIRED, lines } from "./lib/reviews.js";
import { keyAction, clamp } from "./lib/keys.js";
import { readReviews, ask, root } from "./lib/store.js";

const toast = (title, body) => notify({ title, body, level: "info", timeout: 3000 });

// The Reviews page: teammates' PRs waiting on you, the low-risk fast lane on top, then
// by risk; the selected PR's findings, check results and the link to your pending review
// (docs/layouts/08-reviews.png). All data comes through lib/reviews.js.
export default class FactoryReviews extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.res = { doc: null, error: null, missing: true };
    this.at = 0; // the highlighted row, in shapeReviews().all order
    this.opened = null; // key() of the PR shown below; null shows the first
    this.noise = false; // hidden findings shown
    cx.spawn(async (cx) => {
      for (;;) {
        this.res = await readReviews();
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(root());
        await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
        watch.cancel();
      }
    });
  }

  openOnGithub(p) {
    if (!p) return toast("No PR selected");
    exec("open", [p.url]);
  }

  approve(p) {
    const a = approveAsk(p);
    if (a.error) return toast(a.error);
    if (!APPROVE_WIRED) return toast("Approving isn't wired yet", `${label(p)} stays as it is; approve it on GitHub (o) for now.`);
    ask(a);
  }

  key(e, all, cx) {
    const a = keyAction(e);
    if (!a) return;
    const p = all[this.at];
    if (a.kind === "move") this.at = clamp(this.at + a.delta, all.length);
    else if (a.kind === "open") { if (p) { this.opened = key(p); this.noise = false; } }
    else if (a.kind === "approve") this.approve(p);
    else if (a.kind === "github") this.openOnGithub(this.shown(all) ?? p);
    else if (a.kind === "noise") this.noise = !this.noise;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  shown(all) { return all.find((p) => key(p) === this.opened) ?? all[0]; }

  render() {
    const t = theme();
    const { doc, error } = this.res;
    const { fastLane, queue, all, gate } = shapeReviews(doc);
    if (this.at >= all.length) this.at = clamp(this.at, all.length);
    const sel = this.shown(all);
    const now = Date.now();
    const focused = this.handle.is_focused();
    const LEVEL = { low: t.done, med: t.blocked, high: t.blocked };
    const section = (title, aside) => h_flex().pt(6).pb(2).items_baseline()
      .child(div().flex_1().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.dim).child(aside));
    const text = (p) => (p.risk.reasons.length ? p.risk.reasons.join(" · ") : "no risk flags");

    const row = (p, fast) => {
      const i = all.indexOf(p);
      const lvl = riskLevel(p);
      const shownRow = sel && key(sel) === key(p);
      return h_flex().id(`pr-${key(p)}`).min_h(34).px(8).py(4).gap(10).items_center().rounded(6).cursor_pointer()
        .when(shownRow, (el) => el.bg(t.surface))
        .when(focused && i === this.at, (el) => el.bg(t.selected))
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.opened = key(p); this.noise = false; this.handle.focus(); cx.notify(); })
        .child(fast
          ? div().size(8).flex_none().rounded_full().bg(t.done)
          : div().w(42).flex_none().py(1).rounded_full().border(1).border_color(LEVEL[lvl]).text_color(LEVEL[lvl]).text_size(11).text_center().child(lvl))
        .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(`${label(p)} ${p.title}`))
        .child(div().w(330).flex_none().truncate().text_size(12).text_color(t.muted)
          .child(fast ? `${p.author} · ${sizeText(p)} · ${checksText(p)}${p.evidence === "verified" ? " · evidence ✓" : ""}` : `${p.author} · ${sizeText(p)} · ${text(p)}`))
        .child(fast
          ? div().id(`approve-${key(p)}`).w(64).flex_none().text_color(t.accent).text_size(12).text_right().hover((st) => st.text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.approve(p); }).child("a approve")
          : div().w(88).flex_none().text_size(12).text_right().text_color(t.muted).child(findingsTally(p)))
        .child(div().w(34).flex_none().text_size(12).text_right().text_color(t.dim).child(age(p.requested_at, now)));
    };

    const finding = (f, color, word) => h_flex().gap(14).items_baseline()
      .child(div().w(72).flex_none().text_color(color).child(word))
      .child(div().flex_1().min_w_0().text_color(word === "noise" ? t.muted : t.foreground).child(f.text))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : ""));

    const detail = (p) => {
      const { mustFix, suggestions, noise } = splitFindings(p);
      const check = (c) => h_flex().gap(6).text_size(12.5)
        .child(div().text_color(c.status === "pass" ? t.done : t.blocked).child(c.status === "pass" ? "✓" : "✗"))
        .child(div().text_color(t.foreground).child(c.name))
        .when(!!c.detail, (el) => el.child(div().text_color(t.dim).child(c.detail)));
      const evColor = p.evidence === "verified" ? t.done : p.evidence === "failed" ? t.blocked : t.muted;
      return v_flex().id("detail").p(16).gap(10).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().min_w_0().truncate().text_size(16).font_semibold().text_color(t.foreground).child(`${label(p)} ${p.title}`))
          .child(div().id("github").flex_none().text_size(12.5).text_color(t.accent).cursor_pointer().hover((st) => st.text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.openOnGithub(p); })
            .child(p.pending_review ? "Pending review on GitHub ↗  o" : "Open on GitHub ↗  o")))
        .child(div().text_size(12).text_color(t.dim).child(`${p.author} · ${lines(p)} lines (+${p.additions} −${p.deletions}) · asked ${age(p.requested_at, now)} ago · risk ${p.risk.score}: ${text(p)}`))
        .when(!!p.summary, (el) => el.child(div().text_color(t.foreground).child(p.summary)))
        .child(v_flex().gap(6).pt(4)
          .children(mustFix.map((f) => finding(f, t.blocked, "must-fix")))
          .children(suggestions.map((f) => finding(f, t.accent, "suggestion")))
          .when(!mustFix.length && !suggestions.length, (el) => el.child(div().text_color(t.muted).child("Nothing to fix or suggest.")))
          .when(noise.length > 0, (el) => el.child(div().id("noise").text_color(t.dim).cursor_pointer().hover((st) => st.text_color(t.foreground))
            .on_click((_e, cx) => { this.noise = !this.noise; cx.notify(); })
            .child(`noise  ${noise.length} ${this.noise ? "shown" : "hidden"}, kept here, not posted  ·  h ${this.noise ? "hides" : "shows"}`)))
          .when(this.noise, (el) => el.children(noise.map((f) => finding(f, t.dim, "noise")))))
        .child(v_flex().gap(4).pt(8).border_t(1).border_color(t.border)
          .child(div().text_size(12).text_color(t.dim).child("Checked again here"))
          .child(h_flex().gap(16).flex_wrap().children(p.checks.map(check)))
          .child(div().text_size(12.5).text_color(evColor).child(evidenceText(p))))
        .child(div().text_size(12).text_color(t.dim).child(p.pending_review ? "Only you see the pending review until you submit it on github.com" : "No comments drafted; approve it, or open it on GitHub."));
    };

    const empty = (msg) => div().p(12).text_color(t.dim).child(msg);
    return v_flex().id("reviews").size_full().p(16).gap(6).bg(t.background).rounded(10).text_size(13).overflow_y_scroll()
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, all, cx))
      .when(!!error, (el) => el.child(empty(error)))
      .when(!doc && !error, (el) => el.child(empty("No reviews.json yet: the daemon writes it once it prepares reviews (M6).")))
      .when(!!doc && !all.length, (el) => el.child(empty("Nothing waiting on you.")))
      .when(!!doc && !!all.length, (el) => el
        .child(h_flex().gap(8).text_size(11.5).text_color(t.dim).child(div().flex_1()).child("j k · enter opens · a approve low-risk · o opens on GitHub"))
        .when(fastLane.length > 0, (el2) => el2
          .child(section(`Low risk · gate: ${gate}`, gate === "auto" ? "the factory approves these as you" : "no pending comments, just approve"))
          .children(fastLane.map((p) => row(p, true))))
        .child(section("To review · by risk", `${queue.length} ${queue.length === 1 ? "PR" : "PRs"}${queue.some((p) => p.pending_review) ? ", pending reviews ready on GitHub" : ""}`))
        .when(!queue.length, (el2) => el2.child(empty("Only low-risk PRs are waiting.")))
        .children(queue.map((p) => row(p, false)))
        .child(div().h(6))
        .when(!!sel, (el2) => el2.child(detail(sel))));
  }
}
