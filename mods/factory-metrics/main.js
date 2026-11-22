import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, readTextFile, watchFolder, checking, props } from "herdr";
import { validateMetrics, headlineTiles, minutes, bars, agreementCard } from "./lib/metrics.js";
import { validateBenchmarks, variantRows, suiteNote, COLUMNS } from "./lib/benchmarks.js";
import { root } from "./lib/store.js";

const TABS = ["Throughput", "Cost", "Quality", "Benchmarks"];

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
    cx.spawn(async (cx) => {
      for (;;) {
        const dir = root();
        const text = await readTextFile(`${dir}/metrics.json`);
        if (text == null) [this.doc, this.error] = [null, "No metrics.json yet: the daemon writes it (factory run)."];
        else {
          try {
            const doc = JSON.parse(text);
            const errors = validateMetrics(doc);
            [this.doc, this.error] = errors.length ? [null, `metrics.json: ${errors[0]}`] : [doc, null];
          } catch (e) { [this.doc, this.error] = [null, `metrics.json: ${e.message}`]; }
        }
        // The Benchmarks tab's file: absent until a suite has run.
        const btext = await readTextFile(`${dir}/benchmarks.json`);
        [this.bench, this.benchError] = [null, null];
        if (btext != null) {
          try {
            const b = JSON.parse(btext);
            const errors = validateBenchmarks(b);
            if (errors.length) this.benchError = `benchmarks.json: ${errors[0]}`;
            else this.bench = b;
          } catch (e) { this.benchError = `benchmarks.json: ${e.message}`; }
        }
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(dir);
        await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
        watch.cancel();
      }
    });
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

  // Columns for a series, tallest = 100px; each labelled under with its day's date.
  columns(t, id, xs, days, fmt) {
    const hs = bars(xs);
    return h_flex().id(id).h(130).items_end().gap(days.length > 10 ? 2 : 8).children(xs.map((x, i) => v_flex().flex_1().items_center().gap(4)
      .child(div().w_full().h(Math.max(hs[i] * 100, x ? 2 : 0)).rounded(3).bg(t.accent))
      .when(days.length <= 10, (el) => el.child(div().text_size(10).text_color(t.dim).child(x == null ? "–" : fmt(x))))));
  }

  rows(t, pairs) {
    return v_flex().gap(8).children(pairs.map(([k, v]) => h_flex().child(div().flex_1().text_color(t.muted).child(k)).child(div().font_semibold().text_color(t.foreground).child(v))));
  }

  render() {
    const t = theme();
    const r = this.doc?.ranges?.[this.days];
    const head = h_flex().gap(8)
      .children(TABS.map((x) => this.chip(t, `tab-${x}`, x, x === this.tab, (_e, cx) => { this.tab = x; cx.notify(); })))
      .child(div().flex_1())
      .children(["7", "30"].map((d) => this.chip(t, `days-${d}`, `Last ${d} days`, d === this.days, (_e, cx) => { this.days = d; cx.notify(); })));
    const page = v_flex().size_full().p(16).gap(12).text_size(13).bg(t.background).overflow_y_scroll().child(head);
    if (!r) return page.child(div().text_color(t.muted).child(this.error ?? "Loading…"));
    const tiles = h_flex().gap(10).children(headlineTiles(r, this.days).map((x) => v_flex().flex_1().p(14).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_color(t.muted).child(x.label))
      .child(div().text_size(24).font_semibold().text_color(t.foreground).child(x.value))
      .child(div().text_size(12).text_color(t.dim).child(x.sub))));
    page.child(tiles);
    if (this.tab === "Throughput") return page
      .child(h_flex().gap(10).items_start()
        .child(this.card(t, "Cycle time, median", `${r.prs_merged} merged`, this.rows(t, [
          ["Pickup → PR", minutes(r.cycle.pickup_to_pr_min)], ["PR → merge", minutes(r.cycle.pr_to_merge_min)], ["Pickup → merge", minutes(r.cycle.pickup_to_merge_min)]])).flex_1())
        .child(this.card(t, "PRs merged per day", `${r.prs_merged} in ${this.days} days`, this.columns(t, "merged", r.merged_per_day, r.days, String)).flex_1()))
      .child(this.card(t, "Human interactions per PR", "lower means more hands-off", this.columns(t, "inter", r.interactions_per_day, r.days, String)));
    if (this.tab === "Cost") {
      const spent = r.usd_per_day.reduce((a, b) => a + b, 0);
      const list = (xs) => this.rows(t, xs.length ? xs.map((x) => [x.name, `$${x.usd.toFixed(2)}`]) : [["Nothing spent yet", ""]]);
      return page
        .child(this.card(t, "Spend per day", `$${spent.toFixed(2)} in ${this.days} days`, this.columns(t, "spend", r.usd_per_day, r.days, (x) => `$${x.toFixed(0)}`)))
        .child(h_flex().gap(10).items_start()
          .child(this.card(t, "By stage", null, list(r.usd_by_stage)).flex_1())
          .child(this.card(t, "By model", null, list(r.usd_by_model)).flex_1()));
    }
    if (this.tab === "Quality") return page.child(this.card(t, "By blueprint", "merged PRs in range", r.quality.length
      ? v_flex().gap(8).children(r.quality.map((q) => h_flex().gap(16)
        .child(div().flex_1().text_color(t.foreground).child(q.blueprint))
        .child(div().w(110).text_color(t.muted).child(`${q.merged} merged`))
        .child(div().w(110).text_color(q.reverted ? t.blocked : t.muted).child(`${q.reverted} reverted`))
        .child(div().w(140).text_color(t.muted).child(`${q.retries_per_ticket} retries / ticket`))))
      : div().text_color(t.muted).child("No merged PRs in range.")));
    return page.child(this.agreement(t)).children(this.benchmarks(t));
  }

  // The babysitter's agreement with your past review verdicts, which gates pushbacks while you're away.
  agreement(t) {
    const a = this.doc?.agreement;
    const c = agreementCard(a);
    return this.card(t, "Babysitter agreement", a ? (a.ok ? "pushbacks allowed while away" : "no pushbacks while away") : null, v_flex().gap(8)
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(24).font_semibold().text_color(a?.rate != null && !a.ok ? t.blocked : t.foreground).child(c.value))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).child(c.sub)))
      .when(c.rows.length > 0, (el) => el.child(this.rows(t, c.rows))));
  }

  // One card per suite: its latest report, a row per variant, the winner marked as a recommendation.
  benchmarks(t) {
    const suites = this.bench?.suites ?? [];
    if (!suites.length) return [this.card(t, "Benchmarks", null, div().text_color(t.muted)
      .child(this.benchError ?? "No benchmark has run yet. `factory bench <name>` replays your past merged PRs under each variant of a suite in .factory/benchmarks/."))];
    const widths = [0, 170, 130, 70, 80, 110];
    const cell = (i, text, color, bold) => (i === 0 ? div().flex_1().min_w(0).truncate() : div().w(widths[i]).flex_none())
      .text_color(color).when(bold, (el) => el.font_semibold()).child(text);
    return suites.map((s) => this.card(t, s.name, `${s.target} · latest run ${s.ended_at.slice(0, 10)}`, v_flex().gap(8)
      .child(div().text_size(12).text_color(t.dim).child(suiteNote(s)))
      .child(h_flex().gap(8).pb(4).border_b(1).border_color(t.border).text_size(12).text_color(t.dim).children(COLUMNS.map((c, i) => cell(i, c, t.dim, false))))
      .children(variantRows(s).map((r) => h_flex().gap(8).items_center()
        .children(r.cells.map((c, i) => cell(i, i === 0 && r.best ? `${c}  ✓ recommended` : c, r.best ? t.accent : i === 0 ? t.foreground : t.muted, r.best && i === 0)))))
      .child(div().text_color(s.winner ? t.foreground : t.dim).child(s.recommendation ?? "No recommendation: a comparison needs two variants with scored runs."))));
  }
}
