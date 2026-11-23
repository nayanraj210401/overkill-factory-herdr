// The factory's confirm dialog: every action that changes a ticket asks here first.
// Opened by lib/store.js with props { title, detail, input?, confirm, args, done, root, overlay }.
// Enter runs `factory <args>` on the shown factory (with `input`, plus what you typed,
// as the shipped prompt mod does); Esc cancels. Failures toast gh's
// or the CLI's own reason, so nothing fails silently.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, props, closeOverlay, theme, notify } from "herdr";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

export default class FactoryAsk extends View {
  init(_props, cx) {
    this.busy = false;
    this.handle = cx.focus_handle();
    const input = props()?.input;
    if (!input) return this.handle.focus();
    this.text = input.value ?? "";
    this.input = InputState.new({ value: this.text });
    this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.yes(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus()); // the overlay takes focus once it's shown
  }

  // Stays open while the CLI runs (a merge talks to GitHub), then closes either way.
  yes(cx) {
    const p = props();
    const typed = this.input ? this.text.trim() : null;
    if (this.busy || typed === "") return;
    this.busy = true;
    cx.notify();
    cx.spawn(async () => {
      const { command, args } = cliCommand(CLI, p.root, typed == null ? p.args : [...p.args, typed]);
      const r = await exec(command, args, { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      closeOverlay(p.overlay);
      if (r.code === 0) notify({ title: p.done ?? "Done", level: "success", timeout: 3000 });
      else notify({ title: `${p.confirm ?? "Action"} failed`, body: (r.stderr || r.stdout || "").replace(/^factory: /, "").trim(), level: "error" });
    });
  }

  no() {
    if (!this.busy) closeOverlay(props().overlay);
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const button = (id, label, primary, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("factory-ask").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes(cx);
        else if (e.key === "escape") this.no();
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      // A long question scrolls on its own, so the answer box and the buttons stay in view. A max
      // height, not flex_1: the dialog sizes to its content, where a flex_1 area collapses to nothing.
      .child(div().id("ask-detail").max_h(320).overflow_y_scrollbar().pr(6).text_color(t.muted).child(p.detail ?? ""))
      .when(Boolean(this.input), (el) => el.child(v_flex().gap(6)
        .child(div().text_size(11.5).text_color(t.dim).child(p.input.label ?? ""))
        .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
        .when(Boolean(p.input.hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(p.input.hint)))))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("ask-no", "Cancel", false, () => this.no()))
        .child(button("ask-yes", this.busy ? "Working…" : p.confirm ?? "Confirm", true, (_e, cx) => this.yes(cx))));
  }
}
