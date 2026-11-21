// `d`: what a ticket changed, in a window over the factory. Opened by lib/store.js
// with props { id, title, root, overlay }; runs `factory diff <id>` (the ticket's
// worktree against the repo's branch, uncommitted work included). r reloads, Esc closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, props, closeOverlay, theme, checking } from "herdr";
import { cliCommand } from "./lib/actions.js";
import { parseDiff } from "./lib/diff.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

export default class FactoryDiff extends View {
  init(_props, cx) {
    this.diff = parseDiff("");
    this.error = null;
    this.loading = true;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  load(cx) {
    const p = props() ?? {};
    if (checking() || p.root == null) { this.loading = false; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      const { command, args } = cliCommand(CLI, p.root, ["diff", String(p.id)]);
      const r = await exec(command, args, { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.loading = false;
      if (r.code === 0) { this.diff = parseDiff(r.stdout); this.error = null; }
      else this.error = (r.stderr || r.stdout || "").replace(/^factory: /, "").trim();
      cx.notify();
    });
  }

  row(r, t) {
    if (r.kind === "file") return h_flex().w_full().h(26).flex_none().px(12).gap(10).items_center().bg(t.surface).border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(r.file.path))
      .child(div().text_color(t.ansi2).child(`+${r.file.add}`)).child(div().text_color(t.ansi1).child(`−${r.file.del}`));
    if (r.kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(r.text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(r.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(String(r.number)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.text));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const d = this.diff;
    const note = this.loading ? "Reading the diff…" : this.error ?? (d.rows.length ? null : "No changes yet.");
    return v_flex().id("factory-diff").track_focus(this.handle).size_full().min_h(0).bg(t.popover).rounded(8).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "r") this.load(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().flex_none().px(16).py(12).gap(12).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(p.id == null ? "Diff" : `#${p.id} ${p.title ?? ""}`))
        .child(div().text_color(t.muted).child(`${d.files.length} files`))
        .child(div().text_color(t.ansi2).child(`+${d.add}`)).child(div().text_color(t.ansi1).child(`−${d.del}`))
        .child(div().text_size(11).text_color(t.dim).child("r reload · Esc")))
      .child(note
        ? div().flex_1().p(16).text_color(this.error ? t.ansi1 : t.dim).child(note)
        : div().relative().flex_1().min_h(0)
          .child(v_virtual_list("factory-diff-rows", d.rows.length, 20, (i) => String(i),
            (range) => d.rows.slice(range.start, range.end).map((r) => this.row(r, t))).size_full())
          .child(Scrollbar.vertical("factory-diff-rows").viewport_from_layout().absolute().inset_0()))
      .when(d.cut > 0, (el) => el.child(div().flex_none().px(16).py(6).border_t(1).border_color(t.border).text_color(t.dim)
        .child(`${d.cut} more lines not shown; see the branch on GitHub or in the worktree.`)));
  }
}
