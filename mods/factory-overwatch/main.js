import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, run, notify } from "herdr";
import { cliCommand } from "./lib/actions.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status } from "./lib/store.js";

const ASK = [
  "What's blocking #425?",
  "Which tickets are over half their budget?",
  "Pause everything in review and start #430.",
  "Why did #412's verify fail twice?",
];

// Overwatch: the factory's own agent, in a live terminal over the page. It reads the
// factory's state files and acts only through the factory CLI (docs/layouts/04-overwatch.png).
export default class FactoryOverwatch extends View {
  init() {
    this.busy = false;
  }

  open(cx) {
    if (status()?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to talk to its overwatch.", level: "info", timeout: 3500 });
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), ["overwatch", "--json"]);
      const r = await exec(c.command, c.args, { timeout: 20000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.busy = false;
      cx.notify();
      if (r.code !== 0) return notify({ title: "Overwatch didn't start", body: (r.stderr || r.stdout).trim(), level: "error" });
      try { run("terminal.peek", { terminal: JSON.parse(r.stdout).terminal }); }
      catch { notify({ title: "Overwatch didn't start", body: r.stdout.trim(), level: "error" }); }
    });
  }

  render() {
    const t = theme();
    return v_flex().size_full().p(24).gap(16).text_size(13).bg(t.background)
      .child(v_flex().max_w(680).gap(14).p(20).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Overwatch"))
        .child(div().text_color(t.muted).child("An agent that knows this factory: it reads status.json and every ticket's files to answer you, and changes things only through the factory CLI, after you agree."))
        .child(v_flex().gap(6).children(ASK.map((q) => h_flex().gap(8).child(div().text_color(t.dim).child("›")).child(div().text_color(t.foreground).child(q)))))
        .child(h_flex().gap(10).items_center()
          .child(div().id("overwatch").px(12).py(6).rounded(6).border(1).border_color(t.accent).text_color(t.accent).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.busy || this.open(cx)).child(this.busy ? "Starting…" : "Open overwatch"))
          .child(div().text_size(12).text_color(t.dim).child("Starts it the first time; after that it opens the one already running."))))
      .child(div().text_size(12).text_color(t.dim).child("A change to the factory itself (a blueprint, an agent, factory.yaml) comes back as a request for you, never an edit."));
  }
}
