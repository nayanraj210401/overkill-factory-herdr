import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, EditorState, Editor } from "gpui-base";
import { theme, exec, readTextFile, watchFolder, nextCommand, checking, notify } from "herdr";
import { configFiles, daemonView } from "./lib/model.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status, act } from "./lib/store.js";
import { keyAction, clamp } from "./lib/keys.js";

// The Config page: the daemon's service controls, the .factory/ files, the selected
// one read-only, ⌘O to edit it in your own editor (docs/layouts/07-config.png).
export default class FactoryConfig extends View {
  init(_props, cx) {
    this.dir = `${root()}/.factory`;
    this.files = [];
    this.selected = null;
    this.error = null;
    this.editor = null;
    this.checks = {};
    this.daemon = undefined; // undefined: not asked yet; null: the CLI didn't answer
    this.busy = null;
    this.at = 0; // the selected override
    this.handle = cx.focus_handle();
    if (!checking()) {
      this.refreshDaemon(cx);
      cx.timer.every(10000, (cx) => this.refreshDaemon(cx));
    }
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

  factory(args) {
    return exec(CLI[0], [...CLI.slice(1), ...args], { timeout: 20000 });
  }

  refreshDaemon(cx) {
    cx.spawn(async (cx) => {
      const r = await this.factory(["service", "status", "--json"]).catch(() => null);
      try {
        this.daemon = r?.code === 0 ? JSON.parse(r.stdout) : null;
        this.daemonError = r ? r.stderr || r.stdout : "could not run";
      } catch {
        this.daemon = null;
        this.daemonError = `not JSON: ${r.stdout}`;
      }
      cx.notify();
    });
  }

  act(action, cx) {
    if (action === "logs") return exec("open", [this.daemon.logs]);
    this.busy = action;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.factory(["service", action]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Daemon ${action} failed`, body: (r.stderr || r.stdout).trim(), level: "error" });
      this.busy = null;
      this.refreshDaemon(cx);
    });
  }

  daemonBar(t) {
    const v = this.daemon === undefined ? { text: "Checking…", tone: "dim", actions: [] } : daemonView(this.daemon, this.daemonError);
    const LABEL = { install: "Install", restart: "Restart", uninstall: "Uninstall", logs: "Logs" };
    return h_flex().id("daemon").h(40).flex_none().px(14).gap(10).items_center().rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().size(8).rounded_full().bg(t[v.tone]))
      .child(div().font_semibold().text_color(t.foreground).child("Daemon"))
      .child(div().flex_1().truncate().text_color(t.muted).child(this.busy ? `${LABEL[this.busy]}…` : v.text))
      .children(v.actions.map((a) => div().id(`d-${a}`).px(10).py(3).rounded(6).border(1).cursor_pointer().text_size(12)
        .border_color(a === "install" ? t.accent : t.border).text_color(a === "install" ? t.accent : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.busy || this.act(a, cx)).child(LABEL[a])));
  }

  // Tuned settings (learn overrides): each next to the file's value; z undoes the selected one.
  overrides() {
    return status()?.overrides ?? [];
  }

  overridesCard(t, rows) {
    const focused = this.handle.is_focused();
    const show = (v) => (v == null ? "not set" : String(v));
    return v_flex().id("overrides").flex_none().p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const a = keyAction(e);
        if (a?.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
        else if (a?.kind === "undo-override") act(a, rows[this.at]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().px(8).pb(4).gap(10).text_size(11).text_color(t.dim)
        .child(div().flex_1().child("TUNED SETTINGS"))
        .child(div().child(focused ? "j/k select · z undo" : "click, then z to undo")))
      .children(rows.map((o, i) => h_flex().id(`o-${o.key}`).h(28).px(8).gap(12).items_center().rounded(6).cursor_pointer()
        .bg(focused && i === this.at ? t.selected : t.surface).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.handle.focus(); cx.notify(); })
        .child(div().w(250).flex_none().truncate().font_semibold().text_color(t.foreground).child(o.key))
        .child(div().w(150).flex_none().truncate().text_color(t.muted).child(`file: ${show(o.file)}`))
        .child(div().w(150).flex_none().truncate().text_color(t.accent).child(`override: ${show(o.value)}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(o.reason ?? ""))));
  }

  schemaLabel(t) {
    const errors = this.checks[this.selected?.path];
    if (!errors) return div().text_size(12).text_color(t.dim).child("Schema check: not run");
    return div().text_size(12).text_color(errors.length ? t.blocked : t.done)
      .child(errors.length ? `Schema check: ${errors.length} ${errors.length === 1 ? "problem" : "problems"}` : "Schema check: passes");
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
    // The daemon's schema check, per file: path → errors (undefined while unknown).
    if (checking()) return;
    const v = await this.factory(["validate", this.dir, "--json"]).catch(() => null);
    try { this.checks = Object.fromEntries(JSON.parse(v.stdout).map((x) => [x.path, x.errors])); } catch { this.checks = {}; }
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
        .child(div().flex_1().truncate().child(f.path))
        .when(Boolean(this.checks[f.path]), (el) => el.child(div().text_size(11)
          .text_color(this.checks[f.path].length ? t.blocked : t.done).child(this.checks[f.path].length ? `✗ ${this.checks[f.path].length}` : "✓")));
    };
    const overrides = this.overrides();
    this.at = clamp(this.at, overrides.length);
    return v_flex().size_full().gap(8).text_size(13).child(this.daemonBar(t))
      .when(overrides.length > 0, (el) => el.child(this.overridesCard(t, overrides))).child(h_flex().flex_1().w_full().gap(8)
      .child(v_flex().id("files").w(240).flex_none().h_full().p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border).overflow_y_scroll()
        .child(div().px(8).pb(6).text_size(11).text_color(t.dim).child(".FACTORY"))
        .children(this.files.map(row))
        .when(Boolean(this.error), (el) => el.child(div().px(8).text_color(t.blocked).child(this.error))))
      .child(v_flex().flex_1().min_w(0).h_full().rounded(10).bg(t.background).border(1).border_color(t.border)
        .child(h_flex().h(36).px(14).gap(10).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().font_semibold().text_color(t.foreground).truncate().child(this.selected?.path ?? "No file"))
          .child(this.schemaLabel(t))
          .child(div().id("open").px(8).py(2).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => this.selected && exec("open", [`${this.dir}/${this.selected.path}`]))
            .child("Open in editor ⌘O")))
        .when(Boolean(this.checks[this.selected?.path]?.length), (el) => el.child(v_flex().px(14).py(8).gap(2).border_b(1).border_color(t.border)
          .text_size(12).text_color(t.blocked).children(this.checks[this.selected.path].map((e) => div().w_full().truncate().child(e)))))
        .child(div().flex_1().p(4).when(Boolean(this.editor), (el) => el.child(Editor.new(this.editor).size_full())))));
  }
}
