import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, EditorState, Editor } from "gpui-base";
import { theme, exec, readTextFile, watchFolder, nextCommand, checking, notify } from "herdr";
import { configFiles, daemonView, pendingNotes } from "./lib/model.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status, act } from "./lib/store.js";
import { keyAction, clamp } from "./lib/keys.js";

// The Config page: the daemon's service controls, the .factory/ files, the selected
// one read-only, ⌘O to edit it in your own editor (docs/layouts/07-config.png).
export default class FactoryConfig extends View {
  // The lead repo's checkout holds .factory/; the sample data keeps one beside its status.json.
  get dir() {
    return `${status()?.factory?.path ?? root()}/.factory`;
  }

  init(_props, cx) {
    this.files = [];
    this.selected = null;
    this.error = null;
    this.editor = null;
    this.editors = {}; // path → its read-only EditorState, made once
    this.checks = {};
    this.daemon = undefined; // undefined: not asked yet; null: the CLI didn't answer
    this.busy = null;
    this.loginWanted = true; // the box before install: Install passes it as --login
    this.at = 0; // the selected override
    this.handle = cx.focus_handle();
    if (!checking()) {
      this.refreshDaemon(cx);
      cx.timer.every(30000, (cx) => this.refreshDaemon(cx));
    }
    const wait = (ms) => new Promise((done) => cx.timer.after(ms, done));
    cx.spawn(async (cx) => {
      await this.list();
      if (this.files.length) await this.select(this.files[0]);
      cx.notify();
      if (checking()) return;
      for (;;) {
        this.validate(cx); // the schema check fills in after the files show
        // A missing folder has nothing to watch: look again soon rather than spin. (Before
        // status.json loads, this.dir is the data folder's, which has no .factory.)
        if (this.error) await wait(1000);
        else await Promise.race([watchFolder(this.dir), wait(30000)]);
        await wait(300); // one reload for a burst of saves
        await this.list();
        if (this.selected) await this.select(this.selected);
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

  // action: install, start, restart, uninstall, logs, or "login on" / "login off" (the checkbox).
  act(action, cx) {
    if (action === "logs") return exec("open", [this.daemon.logs]);
    this.busy = action;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = action === "install" ? ["install", "--login", this.loginWanted ? "on" : "off"] : action.split(" ");
      const r = await this.factory(["service", ...args]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Daemon ${action} failed`, body: (r.stderr || r.stdout).trim(), level: "error" });
      this.busy = null;
      this.refreshDaemon(cx);
    });
  }

  daemonBar(t) {
    const v = this.daemon === undefined ? { text: "Checking…", tone: "dim", actions: [] } : daemonView(this.daemon, this.daemonError);
    const LABEL = { install: "Install", start: "Start", restart: "Restart", uninstall: "Uninstall", logs: "Logs", "login on": "Turning on start at login", "login off": "Turning off start at login" };
    return h_flex().id("daemon").h(40).flex_none().px(14).gap(10).items_center().rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().size(8).rounded_full().bg(t[v.tone]))
      .child(div().font_semibold().text_color(t.foreground).child("Daemon"))
      .child(div().flex_1().min_w_0().truncate().text_color(t.muted).child(this.busy ? `${LABEL[this.busy]}…` : v.text))
      .when(v.atLogin != null || v.actions.includes("install"), (el) => {
        // Installed: the box is the service's setting, and a click changes it. Not yet: it's
        // what Install will do.
        const on = v.atLogin ?? this.loginWanted;
        const click = (_e, cx) => {
          if (this.busy) return;
          if (v.atLogin == null) { this.loginWanted = !this.loginWanted; cx.notify(); }
          else this.act(on ? "login off" : "login on", cx);
        };
        return el.child(h_flex().id("d-login").gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
          .hover((s) => s.text_color(t.foreground)).on_click(click)
          .child(div().size(14).rounded(3).border(1).border_color(on ? t.accent : t.border).bg(on ? t.accent : t.surface)
            .flex().items_center().justify_center().text_size(10).text_color(t.background).child(on ? "✓" : ""))
          .child("Start at login"));
      })
      .children(v.actions.map((a) => div().id(`d-${a}`).px(10).py(3).rounded(6).border(1).cursor_pointer().text_size(12)
        .border_color(a === "install" ? t.accent : t.border).text_color(a === "install" ? t.accent : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.busy || this.act(a, cx)).child(LABEL[a])));
  }

  // Tuned settings (learn overrides): each next to the file's value; z undoes the selected one.
  overrides() {
    return status()?.overrides ?? [];
  }

  // Requests for the maintainer (each comes back as a PR) and the notes agents left each other,
  // each with who asked whom: "from the learner to the maintainer".
  pendingCard(t, notes) {
    return v_flex().id("pending").flex_none().p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("PENDING CHANGES"))
      .children(notes.map((a) => h_flex().h(26).px(8).gap(10).items_center()
        .child(div().w(56).flex_none().text_color(t.dim).child(`note ${a.id}`))
        .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(a.text))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(a.route))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(a.ticket ? `about #${a.ticket}` : a.delivered ? "delivered" : "waiting"))));
  }

  // Which claude every factory session runs (claude.path in config.yaml, else the newest
  // found), and the others on this machine. Changing it goes through Overwatch like any config.
  claudeCard(t, c) {
    const why = c.why === "configured" ? "claude.path in config.yaml" : "the newest found";
    return v_flex().id("claude").flex_none().p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().px(8).pb(4).gap(8).child(div().text_size(11).text_color(t.dim).child("CLAUDE CODE"))
        .child(div().text_size(11).text_color(t.muted).child(`every session runs this one · ${why}${c.found.length > 1 ? " · ask Overwatch to use another" : ""}`)))
      .children(c.found.map((f) => h_flex().h(24).px(8).gap(10).items_center()
        .child(div().w(14).flex_none().text_color(t.done).child(f.path === c.path ? "▸" : ""))
        .child(div().flex_1().min_w_0().truncate().text_color(f.path === c.path ? t.foreground : t.muted).child(f.path))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(f.version ?? "?"))));
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
  }

  // The daemon's schema check, per file: path → errors (undefined while unknown).
  validate(cx) {
    if (this.error) return;
    cx.spawn(async (cx) => {
      const v = await this.factory(["validate", this.dir, "--json"]).catch(() => null);
      try { this.checks = Object.fromEntries(JSON.parse(v.stdout).map((x) => [x.path, x.errors])); } catch { this.checks = {}; }
      cx.notify();
    });
  }

  // Shows a file. The caller repaints, with a cx of its own (see tests/mods.test.mjs).
  async select(file) {
    const t = theme();
    const text = (await readTextFile(`${this.dir}/${file.path}`)) ?? "";
    // A file's language is fixed when its editor is made: one editor per file, kept, so
    // clicking between files doesn't rebuild and re-highlight each one.
    const key = `${this.dir}/${file.path}`;
    let editor = this.editors[key];
    if (!editor) {
      editor = this.editors[key] = EditorState.new({ language: file.language, value: text, readonly: true, soft_wrap: true,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi3, constant: t.ansi4, boolean: t.ansi3 } });
    } else if (editor.value() !== text) editor.set_value(text);
    this.editor = editor;
    this.selected = file;
  }

  render() {
    const t = theme();
    const row = (f) => {
      const on = f.path === this.selected?.path;
      return h_flex().id(`f-${f.path}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        // select awaits the file; this click's cx is gone by then, so a spawned task repaints.
        .on_click((_e, cx) => cx.spawn(async (cx) => { await this.select(f); cx.notify(); }))
        .child(svg(`mods/workspace-chrome/${f.language === "markdown" ? "file-text" : "settings"}.svg`).size(13))
        .child(div().flex_1().min_w_0().truncate().child(f.path))
        .when(Boolean(this.checks[f.path]), (el) => el.child(div().text_size(11)
          .text_color(this.checks[f.path].length ? t.blocked : t.done).child(this.checks[f.path].length ? `✗ ${this.checks[f.path].length}` : "✓")));
    };
    const overrides = this.overrides();
    this.at = clamp(this.at, overrides.length);
    const notes = pendingNotes(status()?.asks);
    const cards = [status()?.claude?.found?.length, notes.length, overrides.length].some(Boolean);
    // The cards scroll in their own capped area and the files row takes what's left (min_h 0), so
    // neither the .factory list nor the file view grows past the window.
    return v_flex().size_full().min_h(0).gap(8).text_size(13).child(this.daemonBar(t))
      .when(cards, (el) => el.child(v_flex().id("config-cards").flex_none().max_h(260).gap(8).overflow_y_scrollbar()
        .when(Boolean(status()?.claude?.found?.length), (c) => c.child(this.claudeCard(t, status().claude)))
        .when(notes.length > 0, (c) => c.child(this.pendingCard(t, notes)))
        .when(overrides.length > 0, (c) => c.child(this.overridesCard(t, overrides)))))
      .child(h_flex().flex_1().min_h(0).w_full().gap(8)
      .child(v_flex().id("files").w(240).flex_none().h_full().min_h(0).p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border).overflow_y_scroll()
        .child(div().px(8).pb(6).text_size(11).text_color(t.dim).child(".FACTORY"))
        .children(this.files.map(row))
        .when(Boolean(this.error), (el) => el.child(div().px(8).text_color(t.blocked).child(this.error))))
      .child(v_flex().flex_1().min_w(0).min_h(0).h_full().rounded(10).bg(t.background).border(1).border_color(t.border)
        .child(h_flex().h(36).px(14).gap(10).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w_0().font_semibold().text_color(t.foreground).truncate().child(this.selected?.path ?? "No file"))
          .child(this.schemaLabel(t))
          .child(div().id("open").px(8).py(2).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => this.selected && exec("open", [`${this.dir}/${this.selected.path}`]))
            .child("Open in editor ⌘O")))
        .when(Boolean(this.checks[this.selected?.path]?.length), (el) => el.child(v_flex().px(14).py(8).gap(2).border_b(1).border_color(t.border)
          .text_size(12).text_color(t.blocked).children(this.checks[this.selected.path].map((e) => div().w_full().truncate().child(e)))))
        .child(div().flex_1().min_h(0).p(4).when(Boolean(this.editor), (el) => el.child(Editor.new(this.editor).size_full())))));
  }
}
