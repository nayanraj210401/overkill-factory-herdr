// The factory's confirm dialog: every action that changes a ticket asks here first.
// Opened by lib/store.js with props { title, detail, input?, confirm, args, done, peek?, timeout?, root, overlay }.
// Enter runs `factory <args>` on the shown factory (with `input`, plus what you typed,
// as the shipped prompt mod does); Esc cancels. Failures toast gh's
// or the CLI's own reason, so nothing fails silently. With `peek`, the terminal the command
// started (its --json `terminal`) opens over the page, so you land in the agent's conversation.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, props, closeOverlay, theme, notify, run } from "herdr";
import { cliCommand, terminalOf } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

export default class FactoryAsk extends View {
  init(_props, cx) {
    this.busy = false;
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    // Several boxes (New ticket's goal + note) or the one box (a note for an answer).
    // `inputs` entries carry a `key`, which `args`' "@key" tokens stand for.
    const list = p.inputs ?? (p.input ? [{ ...p.input, key: "input", required: true }] : []);
    this.texts = Object.fromEntries(list.map((i) => [i.key, i.value ?? ""]));
    this.inputs = list.map((i) => {
      const st = InputState.new({ value: i.value ?? "" });
      st.set_selected_range({ start: 0, end: (i.value ?? "").length });
      st.on("change", (_e, cx) => { this.texts[i.key] = st.value(); cx.notify(); });
      st.on("submit", (_e, cx) => this.yes(cx));
      return { ...i, st };
    });
    this.legacy = !p.inputs && p.input; // the old single-input dialog appends its text as the last arg
    if (!this.inputs.length) return this.handle.focus();
    this.inputs[0].st.focus();
    cx.timer.after(600, () => this.inputs[0].st.focus()); // the overlay takes focus once it's shown
  }

  // Stays open while the CLI runs (a merge talks to GitHub), then closes either way.
  yes(cx) {
    const p = props();
    if (this.busy) return;
    // A required box empty (or the legacy box empty) does nothing; the note box may be empty.
    if (this.inputs.some((i) => i.required && !this.texts[i.key]?.trim())) return;
    if (this.legacy && !this.texts.input?.trim()) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async () => {
      let args = p.args;
      if (this.inputs.length) {
        args = [];
        for (let i = 0; i < p.args.length; i++) {
          const a = p.args[i];
          const key = typeof a === "string" && a.startsWith("@") ? a.slice(1) : null;
          if (key) {
            const v = (this.texts[key] ?? "").trim();
            // An empty optional value drops it, and the flag before it: the note only lands when you wrote one.
            if (v) args.push(v);
            else if (i > 0 && String(p.args[i - 1]).startsWith("--")) args.pop();
            continue;
          }
          args.push(a);
        }
      } else if (this.legacy) {
        args = [...p.args, this.texts.input.trim()];
      }
      const { command, args: runArgs } = cliCommand(CLI, p.root, args);
      const r = await exec(command, runArgs, { timeout: p.timeout ?? 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      closeOverlay(p.overlay);
      if (r.code !== 0) return notify({ title: `${p.confirm ?? "Action"} failed`, body: (r.stderr || r.stdout || "").replace(/^factory: /, "").trim(), level: "error" });
      notify({ title: p.done ?? "Done", level: "success", timeout: 3000 });
      const terminal = p.peek ? terminalOf(r.stdout) : null;
      if (!terminal) return;
      try { run("terminal.peek", { terminal }); } catch (e) { notify({ title: `Press e to open ${terminal}`, body: String(e), level: "info" }); }
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
    const box = (i) => v_flex().gap(6)
      .child(div().text_size(11.5).text_color(t.dim).child(i.label ?? ""))
      .child(Input.new(i.st).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(Boolean(i.hint), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(i.hint)));
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
      .when(Boolean(this.inputs.length), (el) => el.child(v_flex().gap(10).children(this.inputs.map(box))))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("ask-no", "Cancel", false, () => this.no()))
        .child(button("ask-yes", this.busy ? "Working…" : p.confirm ?? "Confirm", true, (_e, cx) => this.yes(cx))));
  }
}
