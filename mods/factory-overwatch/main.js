import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, exec, run, notify } from "herdr";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status } from "./lib/store.js";

// Overwatch: one agent for every factory (daemon/overwatch.ts), so every factory's page shows
// the same terminal. This mod is the strip above the page; the live
// terminal under it is the layout's `{ agent: "focused" }` block, so the strip starts
// overwatch (or finds the one running) and focuses it. It reads the factory's state files
// and acts only through the factory CLI (docs/layouts/04-overwatch.png).
const RECHECK = 5000; // showing the page again re-focuses it, at most this often
const TRIES = 6; // a fresh agent takes a moment to report its status

export default class FactoryOverwatch extends View {
  init() {
    this.state = "idle"; // idle | starting | ready | failed
    this.error = "";
    this.at = 0;
  }

  focus(cx, terminal, left = TRIES) {
    try {
      run("agent.focus", { terminal });
      this.state = "ready";
      return cx.notify();
    } catch (e) {
      if (left <= 1) return this.fail(cx, String(e));
    }
    cx.timer.after(500, (cx) => this.focus(cx, terminal, left - 1));
  }

  fail(cx, error) {
    this.state = "failed";
    this.error = error.trim();
    cx.notify();
    notify({ title: "Overwatch didn't start", body: this.error, level: "error" });
  }

  open(cx) {
    this.at = Date.now();
    if (status()?.source !== "daemon") return;
    this.state = "starting";
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), ["overwatch", "--json"]);
      const r = await exec(c.command, c.args, { timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) return this.fail(cx, r.stderr || r.stdout);
      try { this.focus(cx, JSON.parse(r.stdout).terminal); }
      catch { this.fail(cx, r.stdout); }
    });
  }

  render(cx) {
    const t = theme();
    const sample = status()?.source !== "daemon";
    if (!sample && this.state !== "starting" && Date.now() - this.at > RECHECK) this.open(cx);
    const note = sample ? "This is sample data: start a factory (factory init) to talk to its overwatch."
      : this.state === "failed" ? this.error
      : this.state === "ready" ? "One Overwatch for every factory. Ask what's blocked, or to start, pause or reorder tickets. A change to the factory itself comes back as a request for you, never an edit."
      : "Starting overwatch…";
    return h_flex().size_full().px(16).items_center().gap(12).text_size(13).bg(t.background)
      .child(div().font_semibold().text_color(t.foreground).child("Overwatch"))
      .child(div().flex_1().min_w_0().text_size(12).text_color(this.state === "failed" ? t.blocked : t.dim).child(note));
  }
}
