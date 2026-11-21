// The factory's confirm dialog: every action that changes a ticket asks here first.
// Opened by lib/store.js with props { title, detail, confirm, args, done, root, overlay }.
// Enter runs `factory <args>` on the shown factory; Esc cancels. Failures toast gh's
// or the CLI's own reason, so nothing fails silently.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, props, closeOverlay, theme, notify } from "herdr";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

export default class FactoryAsk extends View {
  init(_props, cx) {
    this.busy = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  // Stays open while the CLI runs (a merge talks to GitHub), then closes either way.
  yes(cx) {
    if (this.busy) return;
    const p = props();
    this.busy = true;
    cx.notify();
    cx.spawn(async () => {
      const { command, args } = cliCommand(CLI, p.root, p.args);
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
      .child(div().flex_1().min_h(0).text_color(t.muted).child(p.detail ?? ""))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("ask-no", "Cancel", false, () => this.no()))
        .child(button("ask-yes", this.busy ? "Working…" : p.confirm ?? "Confirm", true, (_e, cx) => this.yes(cx))));
  }
}
