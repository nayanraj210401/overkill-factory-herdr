import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings, appHome, home, readTextFile, watchFolder, checking, props, shared, setShared } from "herdr";
import { validateMetrics, headlineTiles, minutes, agreementCard, chartCards, chartAsset, CHART, PALETTE } from "./lib/metrics.js";
import { validateBenchmarks, variantRows, suiteNote, COLUMNS } from "./lib/benchmarks.js";
import { learningView } from "./lib/learning.js";
import { liveFactories, parseDoc, combineMetrics, combinedTiles, columnRows, ALL_NOTE } from "./lib/combine.js";
import { root, ask } from "./lib/store.js";
import { keyAction, clamp } from "./lib/keys.js";

const TABS = ["Throughput", "Cost", "Quality", "Learning", "Benchmarks"];
// The "All factories" toggle (A): a preference that outlives a reload.
const ALL_KEY = "factory.metrics.all";
const allOn = () => !checking() && !!shared(ALL_KEY);

// Metrics: the four numbers the factory is judged by, then one tab at a time, from
// the daemon's metrics.json (docs/layouts/06-metrics.png).
export default class FactoryMetrics extends View {
  init(_props, cx) {
    this.doc = null;
    this.error = null;
    this.bench = null;
    this.benchError = null;
    this.tab = TABS.includes(props()?.tab) ? props().tab : "Throughput"; // a prop only smoke.sh passes
    this.days = "7";
    this.width = 0; // the page's, for the charts' height
    this.at = 0; // the selected shift on the Learning tab
    this.handle = cx.focus_handle();
    this.pageHandle = cx.focus_handle(); // the page's own keys (A)
    this.all = null; // with the toggle on: {factories: [{name, dir, doc, error, bench, benchError}], doc, error}
    this.wake = () => {};
    cx.spawn(async (cx) => {
      for (;;) {
        const dir = allOn() ? `${home()}/.factory` : root();
        if (allOn()) this.all = await this.loadAll(dir);
        else {
          this.all = null;
          ({ doc: this.doc, error: this.error } = parseDoc(await readTextFile(`${dir}/metrics.json`), validateMetrics, "metrics.json"));
          if (!this.doc && !this.error) this.error = "No metrics.json yet: the daemon writes it (factory run).";
          // The Benchmarks tab's file: absent until a suite has run.
          ({ doc: this.bench, error: this.benchError } = parseDoc(await readTextFile(`${dir}/benchmarks.json`), validateBenchmarks, "benchmarks.json"));
        }
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(dir);
        await Promise.race([watch.catch(() => new Promise(() => {})), new Promise((done) => cx.timer.after(5000, done)), new Promise((done) => { this.wake = done; })]);
        watch.cancel();
      }
    });
  }

  // Every factory agents-live.json lists, each with its own metrics.json and benchmarks.json.
  async loadAll(dir) {
    const text = await readTextFile(`${dir}/agents-live.json`);
    let list = [];
    try { list = liveFactories(JSON.parse(text ?? "null")); } catch { /* read as none */ }
    if (!list.length) return { factories: [], doc: null, error: "No factory listed in ~/.factory/agents-live.json: the daemon writes it." };
    const factories = [];
    for (const f of list) {
      const m = parseDoc(await readTextFile(`${f.dir}/metrics.json`), validateMetrics, `${f.name}/metrics.json`);
      const b = parseDoc(await readTextFile(`${f.dir}/benchmarks.json`), validateBenchmarks, `${f.name}/benchmarks.json`);
      factories.push({ ...f, doc: m.doc, error: m.error ?? (m.doc ? null : "no metrics.json yet"), bench: b.doc, benchError: b.error });
    }
    const have = factories.filter((f) => f.doc);
    return { factories, doc: have.length ? combineMetrics(have) : null, error: have.length ? null : "No factory has a metrics.json yet." };
  }

  toggleAll(cx) {
    setShared(ALL_KEY, allOn() ? null : true);
    this.wake();
    cx.notify();
  }

  chip(t, id, label, on, click) {
    return div().id(id).px(14).py(4).rounded_full().border(1).cursor_pointer().border_color(on ? t.accent : t.border)
      .text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.hover)).on_click(click).child(label);
  }

  card(t, title, aside, body) {
    return v_flex().min_w(0).p(16).gap(10).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(title)).child(div().text_size(12).text_color(t.dim).child(aside ?? "")))
      .child(body);
  }

  // A line chart card: its label, the headline number, a legend for several series, and the
  // daemon's SVG for this appearance (daemon/charts.ts), scaled to the card's width.
  chart(t, c) {
    const inner = this.width ? (this.width - 32 - 10) / 2 - 32 : 0;
    const legend = h_flex().gap(14).flex_wrap().text_size(12).text_color(t.muted).children(c.legend.map((l) => h_flex().gap(6).items_center()
      .child(l.color ? div().w(10).h(10).rounded(2).bg(l.color) : div().w(12).h(0).border_t(2).border_color(t.muted))
      .child(l.name)));
    return v_flex().id(`chart-${c.id}`).flex_1().min_w(0).p(16).gap(6).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_color(t.muted).child(c.title))
      .child(h_flex().gap(8).items_baseline()
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child(c.value))
        .child(div().text_size(12).text_color(t.dim).child(c.note)))
      .when(c.legend.length > 0, (el) => el.child(legend))
      .child(c.image
        ? image(c.image).w_full().h(inner > 0 ? Math.round((inner * CHART.h) / CHART.w) : 150)
        : this.all ? this.columns(t, c.series)
        : div().h(150).text_color(t.dim).child("The daemon draws this chart with the next metrics.json."));
  }

  // A combined chart, which the daemon doesn't draw: a row of day columns per series.
  columns(t, series) {
    const palette = PALETTE[settings().dark ? "dark" : "light"];
    const h = series.length > 1 ? 60 : 120;
    return v_flex().gap(8).children(columnRows(series).map((s, i) => h_flex().h(h).gap(2).items_end()
      .children(s.cols.map((c) => (c == null ? div().flex_1().h(1).bg(t.border) : div().flex_1().h(Math.max(1, Math.round(c * h))).rounded(2).bg(palette[i % palette.length]))))))
      .child(div().text_size(12).text_color(t.dim).child("Summed over every factory, each day as a column."));
  }

  // A tab's charts, two to a row; extra cards (not charts) fill the last row.
  // doc and dir: whose charts (a factory's own on the all-factories Learning tab).
  charts(t, tab, extra = [], doc = this.all?.doc ?? this.doc, dir = root()) {
    const mode = settings().dark ? "dark" : "light";
    const cards = chartCards(doc, this.days, tab, mode, (file) => chartAsset(dir, appHome(), file)).map((c) => this.chart(t, c)).concat(extra);
    const rows = [];
    for (let i = 0; i < cards.length; i += 2) rows.push(h_flex().gap(10).items_start().child(cards[i]).child(cards[i + 1] ?? div().flex_1()));
    return rows;
  }

  rows(t, pairs) {
    return v_flex().gap(8).children(pairs.map(([k, v]) => h_flex().child(div().flex_1().text_color(t.muted).child(k)).child(div().font_semibold().text_color(t.foreground).child(v))));
  }

  render() {
    const t = theme();
    const all = this.all;
    const r = (all?.doc ?? (all ? null : this.doc))?.ranges?.[this.days];
    const head = h_flex().gap(8).items_center()
      .children(TABS.map((x) => this.chip(t, `tab-${x}`, x, x === this.tab, (_e, cx) => { this.tab = x; cx.notify(); })))
      .child(div().flex_1())
      .when(!!all, (el) => el.child(div().font_semibold().text_color(t.foreground).child(`All factories (${all.factories.length})`)))
      .child(this.chip(t, "all-factories", "All factories · A", !!all, (_e, cx) => this.toggleAll(cx)))
      .children(["7", "30"].map((d) => this.chip(t, `days-${d}`, `Last ${d} days`, d === this.days, (_e, cx) => { this.days = d; cx.notify(); })));
    const page = v_flex().id("root").track_focus(this.pageHandle)
      .on_mouse_down("left", () => { if (!this.handle.is_focused()) this.pageHandle.focus(); })
      .on_key_down((e, cx) => { if (keyAction(e)?.kind === "all-factories") { this.toggleAll(cx); cx.stop_propagation(); } })
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); }).size_full().p(16).gap(12).text_size(13).bg(t.background).overflow_y_scroll().child(head);
    // Learning and Benchmarks with the toggle on: each factory's own, labelled.
    if (all && this.tab === "Learning") return this.allLearning(t, page);
    if (all && this.tab === "Benchmarks") return page.children(all.factories.flatMap((f) => [this.agreement(t, f.doc, f.name), ...this.benchmarks(t, f.bench, f.benchError, f.name)]));
    if (!r) return page.child(div().text_color(t.muted).child((all ? all.error : this.error) ?? "Loading…"));
    const tiles = h_flex().gap(10).children((all ? combinedTiles(r) : headlineTiles(r, this.days)).map((x) => v_flex().flex_1().min_w(0).p(14).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_color(t.muted).child(x.label))
      .child(div().text_size(24).font_semibold().text_color(t.foreground).child(x.value))
      .child(div().text_size(12).text_color(t.dim).child(x.sub))));
    page.child(tiles);
    if (all) {
      const missing = all.factories.filter((f) => !f.doc).map((f) => `${f.name}: ${f.error}`);
      page.child(div().text_size(12).text_color(t.dim).child(ALL_NOTE + (missing.length ? ` Left out: ${missing.join("; ")}.` : "")));
    }
    const cycle = (c) => [["Pickup → PR", minutes(c.pickup_to_pr_min)], ["PR → merge", minutes(c.pr_to_merge_min)], ["Pickup → merge", minutes(c.pickup_to_merge_min)]];
    if (this.tab === "Throughput") return page.children(this.charts(t, "Throughput", [all
      ? this.card(t, "Cycle time, median, per factory", "medians don't add up", v_flex().gap(10).children(r.per_factory.map((f) => v_flex().gap(4)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(`${f.name} · ${f.merged} merged`))
        .child(f.cycle ? this.rows(t, cycle(f.cycle)) : div().text_color(t.dim).child("no cycle times in this metrics.json"))))).flex_1()
      : this.card(t, "Cycle time, median", `${r.prs_merged} merged`, this.rows(t, cycle(r.cycle))).flex_1()]));
    if (this.tab === "Cost") return page.children(this.charts(t, "Cost"));
    if (this.tab === "Quality") return page.children(this.charts(t, "Quality")).child(this.card(t, "By blueprint", "merged PRs in range", r.quality.length
      ? v_flex().gap(8).children(r.quality.map((q) => h_flex().gap(16)
        .child(div().flex_1().text_color(t.foreground).child(q.blueprint))
        .child(div().w(110).text_color(t.muted).child(`${q.merged} merged`))
        .child(div().w(110).text_color(q.reverted ? t.blocked : t.muted).child(`${q.reverted} reverted`))
        .child(div().w(140).text_color(t.muted).child(`${q.retries_per_ticket} retries / ticket`))))
      : div().text_color(t.muted).child("No merged PRs in range.")));
    if (this.tab === "Learning") return this.learning(t, page);
    return page.child(this.agreement(t)).children(this.benchmarks(t));
  }

  // Learning: the target and why experiments are held, the target over time with its shifts,
  // each experiment's values, the shifts with z to undo one, and the lesson store.
  // doc and dir: whose learning; ro: no undo (the all-factories view, where z would act on
  // the space's factory, not the one shown).
  learning(t, page, doc = this.doc, dir = root(), ro = false) {
    const v = learningView(doc, this.days);
    if (v.state === "none") return page.child(this.card(t, "Learning", null, div().text_color(t.muted).child(v.message)));
    const h = v.header;
    page.child(h_flex().gap(10)
      .child(v_flex().flex_1().min_w(0).p(14).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_color(t.muted).child(`Target: ${h.target}`))
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child(h.value))
        .child(div().text_size(12).text_color(t.dim).child(h.trend)))
      .child(v_flex().flex_1().min_w(0).p(14).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_color(t.muted).child("Experiments"))
        .child(div().text_size(16).font_semibold().text_color(h.held ? t.blocked : t.done).child(h.status))
        .child(div().text_size(12).text_color(t.dim).child(h.summary)))
      .child(v_flex().flex_1().min_w(0).p(14).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(div().text_color(t.muted).child("Learning budget today"))
        .child(div().text_size(24).font_semibold().text_color(h.budgetSpent ? t.blocked : t.foreground).child(h.budgetShare == null ? "–" : `${Math.round(h.budgetShare * 100)}%`))
        .child(div().text_size(12).text_color(t.dim).child(h.budget))));
    // The target chart beside the shifts it marks (or, while warming up, why there are none).
    page.children(this.charts(t, "Learning", [v.state === "warmup"
      ? this.card(t, "Nothing learned yet", null, div().text_color(t.muted).child(v.message)).flex_1()
      : this.shifts(t, v.shifts, ro).flex_1()], doc, dir));
    return page.children(this.experiments(t, v.experiments)).child(this.lessons(t, v.lessons, v.upkeep));
  }

  experiments(t, cards) {
    const widths = [0, 110, 90, 80, 80, 80];
    const cell = (i, text, color) => (i === 0 ? div().flex_1().min_w(0).truncate() : div().w(widths[i]).flex_none()).text_color(color).child(text);
    const floor = (f) => div().w(80).flex_none().text_size(12).text_color(f === "below" ? t.blocked : f === "ok" ? t.done : t.dim).child(f === "below" ? "below floor" : f === "ok" ? "floor ok" : "floor ?");
    return cards.map((c) => this.card(t, `${c.title} · ${c.context}`, `${c.status} · ${c.epsilon} · ${c.outcomes}`, v_flex().gap(8)
      .child(h_flex().gap(8).pb(4).border_b(1).border_color(t.border).text_size(12).text_color(t.dim)
        .children(["Value", "Results", "Mean", "First try", "Reverts"].map((x, i) => cell(i, x, t.dim))).child(div().w(80).flex_none().child("Floor")))
      .children(c.rows.map((r) => h_flex().gap(8).items_center()
        .child(cell(0, `${r.value}${r.in_force ? "  · in force" : ""}${r.winner ? "  ✓ winner" : ""}`, r.winner ? t.accent : r.in_force ? t.foreground : t.muted))
        .child(cell(1, r.n, t.muted)).child(cell(2, r.mean, t.foreground)).child(cell(3, r.first_try, t.muted)).child(cell(4, r.revert_rate, t.muted))
        .child(floor(r.floor))))));
  }

  // Newest first; z (or a click on undo) asks before it drops the shift's override.
  shifts(t, rows, ro = false) {
    if (ro) return this.card(t, "Shifts", "undo from this factory's own Metrics", rows.length
      ? v_flex().gap(4).children(rows.map((r) => h_flex().gap(12).items_center()
        .child(div().w(120).flex_none().text_size(12).text_color(t.dim).child(r.at))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${r.line} · ${r.context}`))
        .child(div().w(110).flex_none().text_size(12).text_color(r.state === "in force" ? t.done : t.dim).child(r.state))))
      : div().text_color(t.muted).child("No shift yet."));
    this.at = clamp(this.at, rows.length);
    const focused = this.handle.is_focused();
    return v_flex().id("shifts").min_w(0).p(16).gap(6).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        const a = keyAction(e);
        if (a?.kind === "move") this.at = clamp(this.at + a.delta, rows.length);
        else if (a?.kind === "undo-override" && rows[this.at]) ask(rows[this.at].undo);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child("Shifts"))
        .child(div().text_size(12).text_color(t.dim).child(rows.length ? (focused ? "j/k select · z undo" : "click, then z to undo") : "")))
      .child(rows.length ? v_flex().gap(2).children(rows.map((r, i) => h_flex().id(`shift-${i}`).px(8).py(4).gap(12).items_center().rounded(6).cursor_pointer()
        .bg(focused && i === this.at ? t.selected : t.surface).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.handle.focus(); cx.notify(); })
        .child(div().w(120).flex_none().text_size(12).text_color(t.dim).child(r.at))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(`${r.line} · ${r.context}`))
          .child(div().text_size(12).text_color(t.dim).child(r.why)))
        .child(div().w(110).flex_none().text_size(12).text_color(r.state === "in force" ? t.done : t.dim).child(r.state))
        .when(!r.undo.error, (el) => el.child(div().id(`undo-${i}`).px(10).py(2).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.at = i; ask(r.undo); cx.stop_propagation(); cx.notify(); }).child("Undo")))))
        : div().text_color(t.muted).child("No shift yet: a setting moves once an experiment is decided."));
  }

  // The store by area, and the daily upkeep's last run (merges and retirements) above it.
  lessons(t, areas, upkeep) {
    const n = areas.reduce((a, x) => a + x.lessons.length, 0);
    const head = upkeep ? h_flex().gap(12).pb(6).border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(12).text_color(t.muted).child(upkeep.line))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(upkeep.totals)) : null;
    const body = areas.length
      ? v_flex().gap(10).children(areas.map((a) => v_flex().gap(4)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(a.area))
        .children(a.lessons.map((x) => h_flex().gap(12).items_start()
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(x.text))
          .child(div().w(70).flex_none().text_size(12).text_color(t.dim).child(x.hits))))))
      : div().text_color(t.muted).child("No lessons yet. `factory lesson add <area> \"<text>\"` adds one; a ticket brief carries the ones whose area its files match.");
    return this.card(t, "Lessons", n ? `${n} active · used in briefs by area` : null, head ? v_flex().gap(8).child(head).child(body) : body);
  }

  // Each factory's Learning tab in turn, under its name.
  allLearning(t, page) {
    if (!this.all.factories.length) return page.child(div().text_color(t.muted).child(this.all.error));
    for (const f of this.all.factories) {
      page.child(div().pt(8).text_size(16).font_semibold().text_color(t.foreground).child(f.name));
      if (f.doc) this.learning(t, page, f.doc, f.dir, true);
      else page.child(div().text_color(t.muted).child(f.error));
    }
    return page;
  }

  // The babysitter's agreement with your past review verdicts, which gates pushbacks while you're away.
  // name: the factory's, on the all-factories view.
  agreement(t, doc = this.doc, name = null) {
    const a = doc?.agreement;
    const c = agreementCard(a);
    return this.card(t, name ? `Babysitter agreement · ${name}` : "Babysitter agreement", a ? (a.ok ? "pushbacks allowed while away" : "no pushbacks while away") : null, v_flex().gap(8)
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(24).font_semibold().text_color(a?.rate != null && !a.ok ? t.blocked : t.foreground).child(c.value))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).child(c.sub)))
      .when(c.rows.length > 0, (el) => el.child(this.rows(t, c.rows))));
  }

  // One card per suite: its latest report, a row per variant, the winner marked as a recommendation.
  benchmarks(t, bench = this.bench, benchError = this.benchError, name = null) {
    const suites = bench?.suites ?? [];
    const label = (x) => (name ? `${name} · ${x}` : x);
    if (!suites.length) return [this.card(t, label("Benchmarks"), null, div().text_color(t.muted)
      .child(benchError ?? "No benchmark has run yet. `factory bench <name>` replays your past merged PRs under each variant of a suite in .factory/benchmarks/."))];
    const widths = [0, 170, 130, 70, 80, 110];
    const cell = (i, text, color, bold) => (i === 0 ? div().flex_1().min_w(0).truncate() : div().w(widths[i]).flex_none())
      .text_color(color).when(bold, (el) => el.font_semibold()).child(text);
    return suites.map((s) => this.card(t, label(s.name), `${s.target} · latest run ${s.ended_at.slice(0, 10)}`, v_flex().gap(8)
      .child(div().text_size(12).text_color(t.dim).child(suiteNote(s)))
      .child(h_flex().gap(8).pb(4).border_b(1).border_color(t.border).text_size(12).text_color(t.dim).children(COLUMNS.map((c, i) => cell(i, c, t.dim, false))))
      .children(variantRows(s).map((r) => h_flex().gap(8).items_center()
        .children(r.cells.map((c, i) => cell(i, i === 0 && r.best ? `${c}  ✓ recommended` : c, r.best ? t.accent : i === 0 ? t.foreground : t.muted, r.best && i === 0)))))
      .child(div().text_color(s.winner ? t.foreground : t.dim).child(s.recommendation ?? "No recommendation: a comparison needs two variants with scored runs."))));
  }
}
