import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, watchFolder, checking, notify, home, appHome } from "herdr";
import { daemonView, pendingNotes } from "./lib/model.js";
import { globalFiles, globalPrecedence, fileBadge, checkoutOf, maintainerAsk, GLOBAL_TOP } from "./lib/configfiles.js";
import { FileView, listFiles, badgesFor, badgedRow, viewerLabels, viewerDetail, maintainerLine } from "./lib/fileview.js";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status, act, ask } from "./lib/store.js";
import { keyAction, clamp } from "./lib/keys.js";

// The Config page, the factory's global settings: the daemon's service controls, then the files in
// ~/.factory every repo shares (factory agents, skills, shared steps, the account's files), the
// selected one read-only, ⌘O to edit it in your own editor. Each repo's own .factory/ is on Repo config.
export default class FactoryConfig extends View {
  // ~/.factory. `herdr-app check` has none: it shows the sample repo's folder, so the list draws rows.
  get dir() {
    return checking() ? `${appHome()}/factory-data/acme-api/.factory` : `${home()}/.factory`;
  }

  init(_props, cx) {
    this.view = new FileView("config");
    this.error = null;
    this.badges = {};
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
      cx.notify();
      if (checking()) return;
      for (;;) {
        this.validate(cx); // the schema check fills in after the files show
        // ~/.factory itself changes every tick (agents-live.json, each factory's status.json), so
        // watch the agents folder and look again every 15 s for the rest.
        const watch = this.error ? null : watchFolder(`${this.dir}/agents`);
        await Promise.race([watch?.catch(() => new Promise(() => {})) ?? new Promise(() => {}), wait(this.error ? 3000 : 15000)]);
        watch?.cancel?.();
        await wait(300); // one reload for a burst of saves
        await this.list();
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

  // ~/.factory's config: its top files, then agents/, skills/ and steps/ (only those listed).
  async list() {
    const top = await listFiles(this.dir, [".", "-maxdepth", "1"]);
    if (top == null) {
      this.error = `${this.dir}: not there yet (factory setup makes it)`;
      return this.view.show(this.dir, []);
    }
    this.error = null;
    const deep = (await listFiles(this.dir, ["agents", "skills", "steps"])) ?? [];
    const files = globalFiles([...top.filter((p) => GLOBAL_TOP.includes(p)), ...deep]);
    await this.view.show(this.dir, files);
    const checkout = checkoutOf(CLI);
    this.badges = await badgesFor(this.dir, files, (p) => globalPrecedence(p, { home: this.dir, checkout }), fileBadge);
  }

  // The daemon's schema check of the global files (factory validate's ~/.factory rows), per file:
  // path → errors (undefined while unknown). Only a live factory has a CLI to ask.
  validate(cx) {
    if (this.error || status()?.source !== "daemon") return;
    cx.spawn(async (cx) => {
      const { command, args } = cliCommand(CLI, root(), ["validate", "--json"]);
      const v = await exec(command, args, { timeout: 20000 }).catch(() => null);
      try {
        this.checks = Object.fromEntries(JSON.parse(v.stdout).filter((x) => x.path.startsWith("~/.factory/")).map((x) => [x.path.slice("~/.factory/".length), x.errors]));
      } catch { this.checks = {}; }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const v = this.view;
    const sel = v.selected?.path;
    const overrides = this.overrides();
    this.at = clamp(this.at, overrides.length);
    const notes = pendingNotes(status()?.asks);
    const cards = [status()?.claude?.found?.length, notes.length, overrides.length].some(Boolean);
    // The cards scroll in their own capped area and the files row takes what's left (min_h 0), so
    // neither the file list nor the file view grows past the window.
    return v_flex().size_full().min_h(0).gap(8).text_size(13).child(this.daemonBar(t))
      .when(cards, (el) => el.child(v_flex().id("config-cards").flex_none().max_h(260).gap(8).overflow_y_scrollbar()
        .when(Boolean(status()?.claude?.found?.length), (c) => c.child(this.claudeCard(t, status().claude)))
        .when(notes.length > 0, (c) => c.child(this.pendingCard(t, notes)))
        .when(overrides.length > 0, (c) => c.child(this.overridesCard(t, overrides)))))
      .child(maintainerLine(t, "Global: ~/.factory, shared by every factory and repo. The maintainer makes every change here; this view is read-only.", () => ask(maintainerAsk())))
      .child(h_flex().flex_1().min_h(0).w_full().gap(8)
        .child(v.list(t, "~/.FACTORY", v.files.map((f) => badgedRow(v, t, f, this.badges[f.path], this.checks[f.path])),
          this.error ? div().px(8).text_color(t.blocked).child(this.error) : null))
        .child(v.pane(t, viewerLabels(t, this.badges[sel], this.checks[sel]), viewerDetail(t, this.badges[sel], this.checks[sel]))));
  }
}
