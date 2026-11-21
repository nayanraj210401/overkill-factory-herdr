import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, EditorState, Editor } from "gpui-base";
import { theme, exec, readTextFile, watchFolder, nextCommand, checking } from "herdr";
import { configFiles } from "./lib/model.js";
import { root } from "./lib/store.js";

// The Config page: the .factory/ files, the selected one read-only, ⌘O to edit it
// in your own editor (docs/layouts/07-config.png). Schema checks arrive with M2.
export default class FactoryConfig extends View {
  init(_props, cx) {
    this.dir = `${root()}/.factory`;
    this.files = [];
    this.selected = null;
    this.error = null;
    this.editor = null;
    cx.spawn(async (cx) => {
      await this.list();
      if (this.files.length) await this.select(this.files[0], cx);
      cx.notify();
      if (checking()) return;
      for (;;) {
        await watchFolder(this.dir);
        await this.list();
        if (this.selected) await this.select(this.selected, cx);
        cx.notify();
      }
    });
    if (!checking()) cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()).endsWith("open") && this.selected) await exec("open", [`${this.dir}/${this.selected.path}`]);
        cx.notify();
      }
    });
  }

  async list() {
    const r = await exec("find", [".", "-type", "f"], { cwd: this.dir }).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) {
      this.files = [];
      this.error = `${this.dir}: no .factory folder`;
      return;
    }
    this.error = null;
    this.files = configFiles(r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, "")));
  }

  async select(file, cx) {
    const t = theme();
    const text = (await readTextFile(`${this.dir}/${file.path}`)) ?? "";
    // A file's language is fixed when its editor is made, so each selection gets its own.
    if (this.selected?.path !== file.path || !this.editor) {
      this.editor = EditorState.new({ language: file.language, value: text, readonly: true, soft_wrap: true,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi3, constant: t.ansi4, boolean: t.ansi3 } });
    } else if (this.editor.value() !== text) this.editor.set_value(text);
    this.selected = file;
    cx.notify();
  }

  render() {
    const t = theme();
    const row = (f) => {
      const on = f.path === this.selected?.path;
      return h_flex().id(`f-${f.path}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.select(f, cx))
        .child(svg(`mods/workspace-chrome/${f.language === "markdown" ? "file-text" : "settings"}.svg`).size(13))
        .child(div().truncate().child(f.path));
    };
    return h_flex().size_full().gap(8).text_size(13)
      .child(v_flex().id("files").w(240).flex_none().h_full().p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border).overflow_y_scroll()
        .child(div().px(8).pb(6).text_size(11).text_color(t.dim).child(".FACTORY"))
        .children(this.files.map(row))
        .when(Boolean(this.error), (el) => el.child(div().px(8).text_color(t.blocked).child(this.error))))
      .child(v_flex().flex_1().h_full().rounded(10).bg(t.background).border(1).border_color(t.border)
        .child(h_flex().h(36).px(14).gap(10).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().font_semibold().text_color(t.foreground).truncate().child(this.selected?.path ?? "No file"))
          .child(div().text_size(12).text_color(t.dim).child("Schema check: coming in M2"))
          .child(div().id("open").px(8).py(2).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => this.selected && exec("open", [`${this.dir}/${this.selected.path}`]))
            .child("Open in editor ⌘O")))
        .child(div().flex_1().p(4).when(Boolean(this.editor), (el) => el.child(Editor.new(this.editor).size_full()))));
  }
}
