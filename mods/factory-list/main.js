import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, run, setShared, readTextFile, watchFolder, checking, props, exec, notify } from "herdr";
import { FILTERS, filterTickets, countBy, factoryRepos, groupOf, repoBadge, subtitle, prLinks, prColor, warnMark, compact } from "./lib/model.js";
import { validateRuns, kindCounts, filterRuns, duration, runWhat, startedAt, runModel } from "./lib/runs.js";
import { STACK } from "./lib/pages.js";
import { keyAction, clamp } from "./lib/keys.js";
import { status, act, root } from "./lib/store.js";

const runTitle = (r) => (r.ticket == null ? r.title : `#${r.ticket} ${r.title}`);
const open = (id) => { setShared("factory.ticket", id); run("layout.select", { stack: STACK, child: "ticket" }); };
const DOT = { needs: "blocked", running: "working", ready: "done", queue: "dim" };
const COLS = [["Stage", 230], ["PR", 150], ["Blueprint", 100], ["Tokens in", 90], ["Cost", 70]];
const RUN_COLS = [["Kind", 140], ["Harness · model", 190], ["Started", 100], ["Time", 70], ["Tokens in / out", 110], ["Cost", 60]];
// The narrowest the ticket/run column gets. A pane narrower than that column plus the fixed
// ones scrolls the table sideways (header and rows together) instead of squeezing it.
const TITLE_MIN = 280;
const tableWidth = (cols) => TITLE_MIN + cols.reduce((n, [, w]) => n + w + 8, 0) + 16;

// Header and rows in one sideways scroll area, so they move in step; the rows scroll down on their own.
// The first column takes what the fixed ones leave and can shrink (min_w_0): a long title is cut
// with an ellipsis there and never pushes the other columns out of line with their headings.
const table = (t, cols, rows) => div().id("table").flex_1().min_h(0).w_full().overflow_x_scrollbar()
  .child(v_flex().size_full().min_w(tableWidth(cols))
    .child(h_flex().px(8).pb(4).gap(8).border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w_0().child("Ticket"))
      .children(cols.map(([name, w]) => div().w(w).flex_none().child(name))))
    .child(rows));

// The Tickets page: every ticket, chips by state, search (docs/layouts/03-tickets.png).
// r swaps it for the Runs view: every agent session, newest first, with its transcript.
export default class FactoryList extends View {
  init(_props, cx) {
    this.filter = "all";
    this.query = "";
    this.repo = null; // a slug, or null for every repo
    this.input = InputState.new({ placeholder: "Search tickets…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });
    this.handle = cx.focus_handle();
    this.at = 0;
    this.view = props()?.view === "runs" ? "runs" : "tickets"; // a prop only smoke.sh passes
    this.kind = null; // a run kind, or null for every kind
    this.doc = null;
    this.error = null;
    cx.spawn(async (cx) => {
      for (;;) {
        const dir = root();
        const text = await readTextFile(`${dir}/runs.json`);
        if (text == null) [this.doc, this.error] = [null, "No runs.json yet: the daemon writes it (factory run)."];
        else {
          try {
            const doc = JSON.parse(text);
            const errors = validateRuns(doc);
            [this.doc, this.error] = errors.length ? [null, `runs.json: ${errors[0]}`] : [doc, null];
          } catch (e) { [this.doc, this.error] = [null, `runs.json: ${e.message}`]; }
        }
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(dir);
        await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
        watch.cancel();
      }
    });
  }

  // A run's transcript, in your own editor (as the Config page's Open does).
  openTranscript(r) {
    if (!r) return;
    if (!r.transcript) return notify({ title: `Run ${r.id} has no transcript on this machine`, level: "info", timeout: 2500 });
    if (status()?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to open a run's transcript.", level: "info", timeout: 3500 });
    exec("open", [r.transcript]);
  }

  // Keys bubble up from the search box too: leave them to it while it has focus.
  key(e, rows, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.handle.focus(); cx.stop_propagation(); }
      return;
    }
    if (e.key === "/") { this.input.focus(); cx.stop_propagation(); return; }
    const a = keyAction(e);
    if (!a) return;
    if (a.kind === "runs") { this.view = this.view === "runs" ? "tickets" : "runs"; this.at = 0; }
    else if (this.view === "runs") { // only moving and opening make sense on a run
      if (a.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
      else if (a.kind === "open") this.openTranscript(rows[this.at]);
      else return;
    }
    else if (a.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
    else if (a.kind === "open" && rows[this.at]) open(rows[this.at].id);
    else act(a, rows[this.at]);
    cx.stop_propagation();
    cx.notify();
  }

  renderRuns(t) {
    const runs = this.doc?.runs ?? [];
    const kinds = kindCounts(runs);
    if (!kinds.some((k) => k.id === this.kind)) this.kind = null;
    const rows = filterRuns(runs, this.kind);
    const chip = (id, label, n) => {
      const on = id === this.kind;
      return div().id(`k-${id ?? "all"}`).px(10).py(3).rounded(12).border(1).cursor_pointer().text_size(12)
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.kind = id; this.at = 0; cx.notify(); })
        .child(`${label} · ${n}`);
    };
    const cell = (w, text, color) => div().w(w).flex_none().truncate().text_color(color).child(text);
    const focused = this.handle.is_focused();
    return v_flex().size_full().p(16).gap(10).bg(t.background).rounded(10).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, rows, cx))
      .child(h_flex().gap(6).items_center()
        .child(chip(null, "All runs", runs.length))
        .children(kinds.map((k) => chip(k.id, k.title, k.n)))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child("j k · enter opens the transcript"))
        .child(div().id("tickets").px(10).py(4).rounded(6).border(1).border_color(t.border).text_color(t.muted).text_size(12).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.view = "tickets"; this.at = 0; cx.notify(); }).child("Tickets  r")))
      .child(table(t, RUN_COLS, v_flex().id("rows").flex_1().min_h(0).overflow_y_scroll()
        .children(rows.map((r, i) => h_flex().id(`run-${r.id}`).h(34).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(focused && i === this.at, (el) => el.bg(t.selected))
          .hover((st) => st.bg(t.hover))
          .on_click(() => this.openTranscript(r))
          .child(div().id(`run-title-${r.id}`).flex_1().min_w_0().truncate().text_color(t.foreground).tooltip(runTitle(r)).child(runTitle(r)))
          .child(cell(140, runWhat(r), t.muted))
          .child(cell(190, runModel(r), t.muted))
          .child(cell(100, startedAt(r.started_at), t.muted))
          .child(cell(70, duration(r.duration_s), r.duration_s == null ? t.accent : t.muted))
          .child(cell(110, `${compact(r.tokens_in)} / ${compact(r.tokens_out)}`, t.muted))
          .child(cell(60, r.usd ? `$${r.usd.toFixed(2)}` : "–", t.foreground))))
        .when(!rows.length, (el) => el.child(div().p(12).text_color(t.dim).child(this.error ?? "No runs yet.")))));
  }

  render() {
    const t = theme();
    const s = status();
    if (!s) return div().size_full().bg(t.background);
    if (this.view === "runs") return this.renderRuns(t);
    const repos = factoryRepos(s);
    if (!repos.includes(this.repo)) this.repo = null;
    const counts = countBy(s.tickets, this.repo, s.factory.repo);
    const rows = filterTickets(s.tickets, this.filter, this.query, this.repo, s.factory.repo);
    const now = Date.now();
    const chip = (f) => {
      const on = f.id === this.filter;
      return div().id(`f-${f.id}`).px(10).py(3).rounded(12).border(1).cursor_pointer().text_size(12)
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.filter = f.id; this.at = 0; cx.notify(); })
        .child(`${f.title} · ${counts[f.id]}`);
    };
    // With more than one repo: which repo's tickets (a cross-repo ticket is in each of its repos).
    const repoChip = (slug) => {
      const on = slug === this.repo;
      return div().id(`repo-${slug ?? "all"}`).px(8).py(2).rounded(10).cursor_pointer().text_size(11.5)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => { this.repo = slug; this.at = 0; cx.notify(); })
        .child(slug ?? "All repos");
    };
    const cell = (w, text, color) => div().w(w).flex_none().truncate().text_color(color).child(text);
    // The ticket's PR(s): "#6 open", one per repo for a cross-repo ticket; a click opens it on GitHub.
    const prCell = (x) => h_flex().w(150).flex_none().gap(6)
      .children(prLinks(x, s.factory.repo).map((l) => div().id(`pr-${x.id}-${l.slug}`).flex_none().text_size(12).text_color(prColor(t, l.state))
        .when(!!l.url, (el) => el.cursor_pointer().hover((st) => st.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); exec("open", [l.url]); }))
        .child(`${l.text} ${l.word}`)));
    const focused = this.handle.is_focused();
    return v_flex().size_full().p(16).gap(10).bg(t.background).rounded(10).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, rows, cx))
      .child(h_flex().gap(6).items_center()
        .children(FILTERS.map(chip))
        .child(div().flex_1())
        .child(h_flex().id("search").w(220).h(28).px(8).rounded(6).border(1).border_color(t.input).bg(t.surface)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
        .child(div().text_size(11.5).text_color(t.dim).child("/ search · j k enter"))
        .child(div().id("runs").px(10).py(4).rounded(6).border(1).border_color(t.border).text_color(t.muted).text_size(12).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.view = "runs"; this.at = 0; cx.notify(); }).child("Runs  r"))
        .child(div().id("new").px(10).py(4).rounded(6).bg(t.accent).text_color(t.background).text_size(12).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).hover((st) => st.opacity(0.88))
          .on_click(() => act({ kind: "new" })).child("New ticket  n")))
      .when(repos.length > 1, (el) => el.child(h_flex().gap(4).items_center()
        .child(div().pr(4).text_size(11.5).text_color(t.dim).child("Repo"))
        .children([null, ...repos].map(repoChip))))
      .child(table(t, COLS, v_flex().id("rows").flex_1().min_h(0).overflow_y_scroll()
        .children(rows.map((x, i) => {
          const g = groupOf(x);
          const done = x.state === "merged" || x.state === "closed";
          return h_flex().id(`row-${x.id}`).h(34).px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(focused && i === this.at, (el) => el.bg(t.selected))
            .hover((st) => st.bg(t.hover))
            .on_click(() => open(x.id))
            .child(h_flex().flex_1().min_w_0().gap(8).items_center()
              .child(div().size(7).flex_none().rounded_full().bg(done ? t.done : t[DOT[g]]).opacity(done ? 0.5 : 1))
              .child(div().id(`title-${x.id}`).flex_1().min_w_0().truncate().text_color(done ? t.muted : t.foreground)
                .tooltip(`#${x.id} ${x.title}`).child(`#${x.id} ${x.title}`))
              .when(!!warnMark(x), (el) => el.child(div().flex_none().px(6).rounded(8).text_size(11).border(1).border_color(t.blocked).text_color(t.blocked).child(warnMark(x))))
              .when(!!repoBadge(s, x), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(repoBadge(s, x)))))
            .child(cell(230, subtitle(x, now), g === "needs" ? t.blocked : x.where === "cloud" ? t.accent : t.muted))
            .child(prCell(x))
            .child(cell(100, x.blueprint, t.muted))
            .child(cell(90, x.tokens.input ? `${(x.tokens.input / 1e6).toFixed(1)}M` : "–", t.muted))
            .child(cell(70, x.usd ? `$${x.usd.toFixed(2)}` : "–", t.foreground));
        }))
        .when(!rows.length, (el) => el.child(div().p(12).text_color(t.dim).child("No tickets match.")))));
  }
}
