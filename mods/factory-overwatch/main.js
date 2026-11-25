import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, exec, run, notify, layout, focused, checking } from "herdr";
import { activePage } from "./lib/pages.js";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status } from "./lib/store.js";

// Overwatch: one agent for every factory (daemon/overwatch.ts), so every factory's page shows
// the same terminal. This mod is the strip above the page; the live
// terminal under it is the layout's `{ agent: "focused" }` block, which on its own shows
// whatever terminal you were in. So the block stays hidden until overwatch's own terminal
// (cwd ~/.factory) is focused in it, and every visit looks again and re-focuses it; with
// none running, the strip offers a Start button rather than starting a session unasked. It reads the factory's state files
// and acts only through the factory CLI (docs/layouts/04-overwatch.png).
const RECHECK = 5000; // showing the page again looks again, at most this often
const TRIES = 6; // a fresh agent takes a moment to report its status
const BLOCK = "overwatch-terminal"; // layouts/factory.json (scripts/gen.mjs agentPage)

export default class FactoryOverwatch extends View {
  init() {
    this.state = "idle"; // idle | looking | none | starting | ready | failed
    this.error = "";
    this.at = 0;
    this.terminal = null; // overwatch's, once focused
    this.shown = null; // whether the terminal block is shown, as last set
    this.seen = 0; // the last render with the page showing
    this.refocused = 0;
  }

  // The agent block shows overwatch's terminal or nothing, never the one you came from.
  show(want) {
    if (this.shown === want || checking()) return;
    this.shown = want;
    try { run(want ? "layout.show" : "layout.hide", { id: BLOCK }); } catch {}
  }

  focus(cx, terminal, left = TRIES) {
    try {
      run("agent.focus", { terminal });
      this.terminal = terminal;
      this.state = "ready";
      return cx.notify();
    } catch (e) {
      if (left <= 1) return this.fail(cx, String(e));
    }
    cx.timer.after(500, (cx) => this.focus(cx, terminal, left - 1));
  }

  fail(cx, error) {
    this.state = "failed";
    this.terminal = null;
    this.error = error.trim();
    cx.notify();
    notify({ title: "Overwatch didn't start", body: this.error, level: "error" });
  }

  // `factory overwatch`, or with --find only the live one: { terminal } either way.
  overwatch(cx, find) {
    this.at = Date.now();
    if (status()?.source !== "daemon") return;
    this.state = find ? "looking" : "starting"; // no cx.notify(): render calls this, and notify in render throws
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), ["overwatch", ...(find ? ["--find"] : []), "--json"]);
      const r = await exec(c.command, c.args, { timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) return this.fail(cx, r.stderr || r.stdout);
      let terminal;
      try { terminal = JSON.parse(r.stdout).terminal; } catch { return this.fail(cx, r.stdout); }
      if (terminal) return this.focus(cx, terminal);
      this.state = "none";
      this.terminal = null;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const sample = status()?.source !== "daemon";
    const busy = this.state === "looking" || this.state === "starting";
    const now = Date.now();
    const onPage = activePage(layout())?.id === "overwatch";
    // Coming back to the page (or from another layout, cmd-shift-f): look again at once.
    const back = onPage && now - this.seen > 1000;
    if (onPage) this.seen = now;
    if (!sample && !busy && this.state !== "failed" && (back || now - this.at > RECHECK)) this.overwatch(cx, true);
    // Something else took the agent block (you focused another agent): put overwatch back.
    if (onPage && this.state === "ready" && focused()?.agent !== this.terminal && now - this.refocused > 1000) {
      this.refocused = now;
      const terminal = this.terminal;
      cx.timer.after(0, (cx) => this.focus(cx, terminal));
    }
    this.show(!sample && (this.state === "ready" || (this.state === "looking" && !!this.terminal))); // no flicker while it looks again
    const note = sample ? "This is sample data: start a factory (factory init) to talk to its overwatch."
      : this.state === "failed" ? this.error
      : this.state === "ready" ? "One Overwatch for every factory. Ask what's blocked, or to start, pause or reorder tickets. A change to the factory itself comes back as a request for you, never an edit."
      : this.state === "none" ? "Overwatch isn't running. Start it to ask what's blocked, or to start, pause or reorder tickets."
      : this.state === "starting" ? "Starting overwatch…"
      : "Looking for overwatch…";
    const offer = !sample && (this.state === "none" || this.state === "failed" || this.state === "starting");
    return h_flex().size_full().px(16).items_center().gap(12).text_size(13).bg(t.background)
      .child(div().font_semibold().text_color(t.foreground).child("Overwatch"))
      .child(div().flex_1().min_w_0().text_size(12).text_color(this.state === "failed" ? t.blocked : t.dim).child(note))
      .when(offer, (el) => el.child(h_flex().id("overwatch-start").h(30).px(14).items_center().rounded(8)
        .border_1().border_color(t.solid).bg(t.solid).text_color(t.solid_foreground).text_size(12)
        .when(this.state !== "starting", (b) => b.cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => { this.overwatch(cx, false); cx.notify(); }))
        .child(this.state === "starting" ? "Starting…" : this.state === "failed" ? "Try again" : "Start Overwatch")));
  }
}
