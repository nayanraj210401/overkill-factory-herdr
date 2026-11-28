// The About popup: the factory's own build and Herdr's versions, and a check for updates on
// each. Opened from the brand row's ⓘ chip (factory-chrome). The Factory row reads
// status.json's factory.build and factory.schema (daemon/status.ts); the Herdr rows read
// updates(). "Check for updates" starts Herdr's own look (app.check_updates), polled on a
// timer; the Factory check runs the CLI's `update --check --json`, and when it says the
// checkout is behind, "Update factory" asks first (factory-ask) and runs `update --run`:
// backups, a fast-forward, scripts/sync.sh, service install. Esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, run, exec, updates } from "herdr";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { cliCommand } from "./lib/actions.js";
import { status, root, ask } from "./lib/store.js";

// "1.2.3" → numbers to compare: is the note's version newer than the running app's?
const parts = (v) => String(v ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) > (y[i] ?? 0)) return true;
    if ((x[i] ?? 0) < (y[i] ?? 0)) return false;
  }
  return false;
};

// "2026-11-27T…" → "Nov 27", the popup's build date.
const day = (iso) => new Date(iso).toString().slice(4, 10);

export default class FactoryAbout extends View {
  init(_props, cx) {
    this.busy = false; // the Factory check is out
    this.result = null; // its answer: the check, or { error }
    this.closed = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus()); // the overlay takes focus once it's shown
    // Herdr's check runs apart from this view: repaint so its row keeps up.
    cx.timer.every(1000, (cx) => { if (!this.closed) cx.notify(); });
  }

  close() {
    this.closed = true;
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Herdr's button: Herdr does the looking; the timer repaints the row as it goes.
  checkHerdr() {
    try { run("app.check_updates"); } catch (e) { this.herdrError = String(e); }
  }

  // The factory's button: the CLI checks the checkout the daemon runs from.
  checkFactory(cx) {
    if (this.busy) return;
    this.busy = true;
    this.result = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { command, args } = cliCommand(CLI, root(), ["update", "--check", "--json"]);
      const r = await exec(command, args, { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = false;
      let check = null;
      if (r.code === 0) { try { check = JSON.parse(String(r.stdout).trim()); } catch {} }
      this.result = check?.commit != null ? check : { error: String(r.stderr || r.stdout || "the check failed").replace(/^factory: /, "").trim() };
      cx.notify();
    });
  }

  // Behind: the same confirm dialog every action goes through, then `update --run`.
  updateFactory() {
    ask({
      title: "Update the factory?",
      detail: "Backs up every factory database, fast-forwards the daemon's checkout to origin/develop, resyncs the mods (scripts/sync.sh), and reinstalls the service. A checkout with uncommitted changes refuses.",
      confirm: "Update",
      args: ["update", "--run", "--json"],
      done: "Factory updated",
      timeout: 300000,
    });
  }

  button(t, id, label, onClick) {
    return h_flex().id(id).flex_none().h(26).px(10).items_center().rounded(7).border_1().border_color(t.border).bg(t.raised)
      .text_size(11.5).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
  }

  // One INSTALLED row: the label, then what it is.
  installed(t, label, line) {
    return h_flex().gap(8).items_start()
      .child(div().w(74).flex_none().text_size(11.5).text_color(t.muted).child(label))
      .child(div().flex_1().min_w_0().truncate().text_size(11.5).text_color(t.foreground).child(line));
  }

  // The Herdr update row: its own look, started here, polled from the timer. Ready-to-restart
  // and the build-from-source case leave the button out.
  herdrRow(t) {
    const u = updates() ?? { app: { version: "?", ready: null, updates: true }, notes: [], checks: true, checked: null, checking: false };
    const source = u.app.updates === false;
    let state;
    if (u.checking) state = h_flex().gap(6).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900))
      .child(div().text_size(11.5).text_color(t.muted).child("checking…"));
    else if (u.app.ready) state = `${u.app.version} ready — restart to update`;
    else if (source) state = "build from source — never updates";
    else if (u.checks && u.checked) state = "up to date";
    else state = u.checks ? "never checked" : "checks are off for this build";
    // Notes newer than the running app, collapsed: one headline each.
    const notes = (u.notes ?? []).filter((n) => newer(n.version, u.app.version))
      .map((n) => div().truncate().text_size(11.5).text_color(t.muted).child(`• ${n.items?.[0]?.headline ?? n.version}`));
    return v_flex().gap(2)
      .child(h_flex().gap(8).items_start()
        .child(div().w(74).flex_none().pt(3).text_size(11.5).text_color(t.muted).child("Herdr"))
        .child(div().flex_1().min_w_0().truncate().text_size(11.5).text_color(u.app.ready ? t.accent : t.foreground).child(state))
        .child(!source && !u.checking
          ? this.button(t, "herdr-check", u.checked ? "Check again" : "Check for updates", () => this.checkHerdr())
          : div()))
      .children(notes)
      .when(Boolean(this.herdrError), (el) => el.child(div().truncate().text_size(11.5).text_color(t.blocked).child(this.herdrError)));
  }

  // The Factory update row: the CLI's check, then the update behind the confirm dialog.
  factoryRow(t) {
    const f = status()?.factory ?? null;
    let line, lines = [], right;
    if (this.busy) {
      line = h_flex().gap(6).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900))
        .child(div().text_size(11.5).text_color(t.muted).child("checking…"));
    } else if (this.result?.error) {
      line = this.result.error;
      right = this.button(t, "factory-check", "Check", (_e, cx) => this.checkFactory(cx));
    } else if (this.result) {
      line = this.result.upToDate ? `${this.result.commit} · up to date` : `${this.result.commit} · ${this.result.behind} commit${this.result.behind === 1 ? "" : "s"} behind develop`;
      lines = (this.result.commits ?? []).slice(0, 3).map((c) => div().truncate().text_size(11.5).text_color(t.muted).child(`${c.short} ${c.subject}`));
      right = this.result.upToDate ? div() : this.button(t, "factory-update", "Update factory", () => this.updateFactory());
    } else {
      line = div().truncate().text_size(11.5).text_color(t.foreground).child(f ? "not checked" : "no factory yet");
      right = this.button(t, "factory-check", "Check", (_e, cx) => this.checkFactory(cx));
    }
    return v_flex().gap(2)
      .child(h_flex().gap(8).items_start()
        .child(div().w(74).flex_none().pt(3).text_size(11.5).text_color(t.muted).child("Factory"))
        .child(v_flex().flex_1().min_w_0().gap(2).child(line).children(lines))
        .child(right ?? div()));
  }

  render() {
    const t = theme();
    const u = updates() ?? { app: { version: "?", ready: null, updates: true }, notes: [], core: { version: null, managed: null, ready: null, updating: false, error: null }, checks: true, checking: false, checked: null };
    const f = status()?.factory ?? null;
    const build = f ? `${f.build ? `${f.build.commit} · ${day(f.build.date)}` : "unknown build"}${f.schema ? ` · schema ${f.schema}` : ""}` : "no factory yet";
    const app = `${u.app.version}${u.app.ready ? " · ready to restart" : ""}${u.app.updates === false ? " · build from source — never updates" : ""}`;
    const core = u.core?.version ? `${u.core.version}${u.core.managed ? ` · managed by ${u.core.managed}` : ""}${u.core.ready ? " · ready to restart" : ""}${u.core.error ? ` · ${u.core.error}` : ""}` : "not found";
    const section = (title) => div().pt(12).pb(3).text_size(11).font_semibold().text_color(t.dim).child(title);
    return v_flex().id("factory-about").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        this.close();
      })
      .w_full().p(14).gap(2).bg(t.popover).text_size(13)
      .child(h_flex().items_center().gap(8).px(4)
        .child(svg("mods/workspace-chrome/layers.svg").size(16).text_color(t.accent))
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Factory"))
        .child(div().id("about-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(section("INSTALLED"))
      .child(this.installed(t, "Factory", build))
      .child(this.installed(t, "Herdr", app))
      .child(this.installed(t, "herdr-core", core))
      .child(section("CHECK FOR UPDATES"))
      .child(this.herdrRow(t))
      .child(this.factoryRow(t));
  }
}
