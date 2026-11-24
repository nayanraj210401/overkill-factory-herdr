import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, notify } from "herdr";
import { draftsFor, stageNotes } from "./lib/blueprints.js";
import { flowRows, failArcs, isLive, statTiles, compareGrid, stepsTable, usedBy, leaves, took, passTo, passPct } from "./lib/blueprint-v2.js";
import { maintainerAsk } from "./lib/configfiles.js";
import { openFile, setOpenTarget } from "./lib/fileview.js";
import { ask, root, status } from "./lib/store.js";

// The V2 Blueprint page (docs/prototypes/blueprint-v2), drawn when the V2_UI gate is on:
// the blueprints on the left, the picked one's flow (or Compare, or the shared steps) in the
// middle, the selected stage on the right. main.js loads blueprints.json and hands it here.
const ROW = 58; // a flow row's height: the fail-back arcs are drawn from it
const GAP = 4;
const GUTTER = 40; // room on the flow's left for the arcs
const STEP_W = 118;
const RUNS_W = 112;
const mid = (i) => i * (ROW + GAP) + ROW / 2;
const toast = (title, body) => notify({ title, body, level: "info", timeout: 3000 });

export class BlueprintV2 {
  // props (a layout's, for scripts/smoke.sh): {view, blueprint, stage, step} to start on.
  constructor(cx, props = {}) {
    this.handle = cx.focus_handle();
    this.bp = props?.blueprint ?? null; // the picked blueprint's name; null: feature, else the first
    this.at = props?.stage ?? 0; // the selected flow row
    this.view = props?.view ?? "flow"; // flow | compare | steps
    this.step = props?.step ?? null; // the step picked on the shared steps view
  }

  // Every blueprint, then one a pending request only drafts, with no stages yet.
  list(doc) {
    const current = doc?.blueprints ?? [];
    const only = (doc?.drafts ?? []).filter((d, i, all) => !current.some((x) => x.name === d.name) && all.findIndex((x) => x.name === d.name) === i);
    return [...current, ...only.map((d) => ({ name: d.name, error: null, stages: [], draftOnly: true }))];
  }

  picked(bps) {
    return bps.find((x) => x.name === this.bp) ?? bps.find((x) => x.name === "feature") ?? bps[0] ?? null;
  }

  // Picks a blueprint; with `step`, the row that runs it (found once its rows are drawn).
  go(name, step = null) {
    this.bp = name;
    this.at = 0;
    if (this.view === "steps") this.view = "flow";
    this.pendingStep = step;
  }

  key(e, ctx, cx) {
    const mod = e.modifiers ?? {};
    if (mod.platform || mod.control || mod.alt || mod.function) return;
    const { bps, b, rows, steps } = ctx;
    const k = e.key;
    if (k === "j" || k === "down") {
      if (this.view === "steps") this.step = steps[Math.min(steps.length - 1, Math.max(0, steps.findIndex((s) => s.step === this.step) + 1))]?.step ?? null;
      else this.at = Math.min(this.at + 1, Math.max(0, rows.length - 1));
    } else if (k === "k" || k === "up") {
      if (this.view === "steps") this.step = steps[Math.max(0, steps.findIndex((s) => s.step === this.step) - 1)]?.step ?? null;
      else this.at = Math.max(this.at - 1, 0);
    } else if (k === "]" || k === "[") {
      if (!bps.length) return;
      const i = Math.max(0, bps.indexOf(b));
      this.go(bps[(i + (k === "]" ? 1 : bps.length - 1)) % bps.length].name);
    } else if (k === "c") this.view = this.view === "compare" ? "flow" : "compare";
    else if (k === "s") { this.view = "steps"; this.step ??= steps[0]?.step ?? null; }
    else if (k === "escape" && this.view !== "flow") this.view = "flow";
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // A step's file, as the daemon wrote it: absolute, or (the sample) beside blueprints.json.
  stepFile(doc, step) {
    const f = doc?.steps?.[step]?.file ?? null;
    return f && !f.startsWith("/") ? `${root()}/${f}` : f;
  }

  openStep(doc, step) {
    const f = this.stepFile(doc, step);
    if (!step) return toast("This stage names no step", "Its work is written out in the blueprint file.");
    if (!f) return toast(`No file for step ${step}`, "The daemon couldn't find it in .factory/steps/ or ~/.factory/steps/.");
    openFile(f);
  }

  askChange(step, n) {
    const a = maintainerAsk();
    ask({ ...a, input: { ...a.input, value: step ? `Change the ${step} step${n > 1 ? ` (it runs in ${n} blueprints)` : ""}: ` : "" } });
  }

  render(doc, error) {
    const t = theme();
    const live = status()?.tickets ?? [];
    const bps = this.list(doc);
    const b = this.picked(bps);
    const rows = flowRows(doc, b, live);
    if (this.pendingStep) {
      const i = rows.findIndex((r) => r.step === this.pendingStep);
      if (i >= 0) this.at = i;
      this.pendingStep = null;
    }
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const steps = doc ? stepsTable(doc) : [];
    const sel = this.view === "steps" ? null : rows[this.at] ?? null;
    const stepName = this.view === "steps" ? this.step : sel?.step ?? null;
    setOpenTarget("blueprint", stepName ? this.stepFile(doc, stepName) : null); // ⌘O (the header) opens it
    const ctx = { bps, b, rows, steps };
    return v_flex().id("blueprint-v2").size_full().min_h(0).gap(8).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, ctx, cx))
      .child(h_flex().flex_none().gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w_0().truncate().child(error ?? (doc ? `Counts are the last ${doc.days} days; retries count as runs.` : "")))
        .child(div().flex_none().child("j/k stage · [ ] blueprint · c compare · s steps · ⌘O open step")))
      .child(h_flex().flex_1().min_h(0).w_full().gap(8).items_start()
        .child(this.side(t, doc, bps, b, live, steps))
        .child(this.main(t, doc, b, rows, steps))
        .child(this.inspector(t, doc, b, rows, sel, steps)));
  }

  card(t, id) {
    return v_flex().id(id).h_full().min_h(0).rounded(10).bg(t.surface).border(1).border_color(t.border).overflow_y_scrollbar();
  }

  side(t, doc, bps, b, live, steps) {
    const caption = (s) => div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim).child(s);
    const item = (id, on, title, count, desc, dot, click) => v_flex().id(id).flex_none().px(10).py(8).gap(3).rounded(8).cursor_pointer()
      .bg(on ? t.selected : t.surface).hover((s) => s.bg(t.hover)).on_click(click)
      .child(h_flex().gap(6).items_center()
        .when(dot, (el) => el.child(div().size(7).flex_none().rounded_full().bg(t.done)))
        .child(div().flex_1().min_w_0().truncate().font_semibold().text_color(on ? t.foreground : t.muted).child(title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(count)))
      .when(Boolean(desc), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(desc)));
    return this.card(t, "bp-side").w(190).flex_none().p(8).gap(2)
      .child(caption("BLUEPRINTS"))
      .children(bps.map((x) => item(`bp-${x.name}`, this.view !== "steps" && x === b, x.name,
        x.draftOnly ? "draft" : x.stats ? `${x.stats.tickets} / ${doc.days}d` : "",
        x.error ? `can't load: ${x.error}` : x.description ?? null, isLive(x, live),
        (_e, cx) => { this.go(x.name); this.handle.focus(); cx.notify(); })))
      .child(div().h(8))
      .child(caption("LIBRARY"))
      .child(item("bp-steps", this.view === "steps", "Shared steps", String(steps.length), "Each step is one file; blueprints point at it.", false,
        (_e, cx) => { this.view = "steps"; this.step ??= steps[0]?.step ?? null; this.handle.focus(); cx.notify(); }));
  }

  main(t, doc, b, rows, steps) {
    const body = this.card(t, "bp-main").flex_1().min_w_0().p(16).gap(12).bg(t.background);
    if (!doc) return body.child(div().text_color(t.muted).child("No blueprints.json yet: the daemon writes it (factory run), or run factory blueprints."));
    if (this.view === "steps") return body.child(this.head(t, "Shared steps", "A step is one file: what to do, what it leaves behind, which agent runs it. Blueprints only list steps in order.", null))
      .child(this.stepsView(t, steps));
    if (!b) return body.child(div().text_color(t.muted).child("No blueprints in .factory/blueprints/ yet."));
    const tiles = statTiles(b.stats, doc.days);
    const drafts = draftsFor(doc, b.name);
    const why = b.description ? `Grooming picks it for: ${b.description}` : "Grooming picks it from the ticket. A description: line in the blueprint file says why.";
    return body
      .child(this.head(t, b.name, why, this.tabs(t)))
      .when(Boolean(b.error), (el) => el.child(div().text_color(t.ansi1).child(`${b.name}: ${b.error}`)))
      .when(tiles.length > 0, (el) => el.child(h_flex().gap(8).children(tiles.map((x) => v_flex().flex_1().min_w_0().px(10).py(8).rounded(8).border(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child(x.value))
        .child(div().text_size(11).text_color(t.dim).child(x.label))))))
      .child(this.view === "compare" ? this.compare(t, doc) : this.flow(t, rows))
      .children(drafts.map((d) => this.draft(t, d)))
      .when(this.view === "flow" && !b.error && !b.draftOnly, (el) => el.child(v_flex().gap(2).pt(4)
        .child(div().text_size(12).text_color(t.dim).child(`Grooming picks the blueprint${b.orchestrator ? `, then the ${b.orchestrator} agent picks each next stage` : ""}. Retries count as runs.`))
        .children(stageNotes(b).filter((n) => /can go to/.test(n)).map((n) => div().text_size(12).text_color(t.dim).child(n)))));
  }

  head(t, title, why, right) {
    return h_flex().flex_none().gap(12).items_start()
      .child(v_flex().flex_1().min_w_0().gap(3)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(12.5).text_color(t.muted).child(why)))
      .children(right ? [right] : []);
  }

  tabs(t) {
    const tab = (id, label) => div().id(`tab-${id}`).px(12).py(3).rounded(6).cursor_pointer().text_size(12.5)
      .bg(this.view === id ? t.selected : t.surface).text_color(this.view === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = id; this.handle.focus(); cx.notify(); }).child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(8).border(1).border_color(t.border).bg(t.surface).child(tab("flow", "Flow")).child(tab("compare", "Compare"));
  }

  // The bars: one per run of the last 10, oldest first.
  bars(t, last) {
    const tone = { pass: t.done, fail: t.ansi1, running: t.accent, stopped: t.dim };
    return h_flex().gap(2).items_end().h(14)
      .children([...Array(Math.max(0, 10 - last.length)).fill(null), ...last].map((o) => div().w(6).h(o === "fail" ? 14 : 10).rounded(1).bg(o ? tone[o] : t.border)));
  }

  flow(t, rows) {
    if (!rows.length) return div().text_color(t.muted).child("This blueprint has no stages to draw.");
    const arcs = failArcs(rows);
    const chip = (text, color) => div().flex_none().px(6).rounded(8).border(1).border_color(color).text_size(10.5).text_color(color).child(text);
    const row = (r, i) => {
      const on = i === this.at;
      const tone = r.you ? t.ansi5 : r.check ? t.muted : r.grooming ? t.dim : t.accent;
      const runs = r.runs ? `${r.runs} run${r.runs === 1 ? "" : "s"}${r.pct != null ? ` · ${r.pct}%` : ""} · ${took(r.median_s)}` : "no runs this week";
      return h_flex().id(`st-${r.id}`).h(ROW).flex_none().px(10).gap(10).items_center().rounded(8).cursor_pointer().border(1)
        .border_color(on ? t.accent : t.background).bg(on ? t.selected : t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.handle.focus(); cx.notify(); })
        .child(h_flex().size(24).flex_none().rounded_full().border(r.check ? 1 : 2).when(Boolean(r.check), (el) => el.border_dashed()).border_color(tone)
          .items_center().justify_center().text_size(11).text_color(tone).child(String(r.n)))
        .child(v_flex().flex_1().min_w(110).gap(2)
          .child(h_flex().gap(6).items_center().min_w_0()
            .child(div().flex_none().font_semibold().text_color(t.foreground).child(r.id))
            .when(r.skip, (el) => el.child(chip("may skip", t.dim)))
            .when(r.you, (el) => el.child(chip("you", t.ansi5)))
            .children(r.here.map((id) => chip(`● #${id} here`, t.done))))
          .child(div().text_size(11.5).text_color(t.dim).truncate()
            .child([r.failsTo && `fails → ${r.failsTo}`, r.kind, r.waits && r.kind !== "ready rules" && `waits for ${r.waits}`].filter(Boolean).join(" · "))))
        .child(v_flex().w(STEP_W).flex_none().gap(2)
          .child(div().truncate().text_size(12).text_color(r.step ? t.foreground : t.dim).child(r.step ?? "–"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(r.shared)))
        .child(v_flex().w(RUNS_W).flex_none().gap(3)
          .child(this.bars(t, r.last ?? []))
          .child(div().truncate().text_size(11).text_color(t.dim).child(runs)));
    };
    // The arcs: a bracket from the failing row's middle round to the row it goes back to,
    // one lane each (lane 0 nearest the nodes), with an arrowhead where it lands.
    const arc = (a) => {
      const [top, bottom] = [Math.min(mid(a.from), mid(a.to)), Math.max(mid(a.from), mid(a.to))];
      const x = GUTTER - 14 - a.lane * 9;
      return [
        div().absolute().left(x).top(top).w(GUTTER - x + 2).h(bottom - top).border_l(1).border_t(1).border_b(1).border_dashed().border_color(t.ansi1).rounded(6),
        div().absolute().left(GUTTER - 4).top(mid(a.to) - 8).text_size(11).text_color(t.ansi1).child("▸"),
      ];
    };
    return v_flex().gap(6)
      .child(h_flex().pl(GUTTER + 44).pr(10).gap(10).text_size(11).text_color(t.dim)
        .child(div().flex_1().child("STAGE")).child(div().w(STEP_W).flex_none().child("STEP")).child(div().w(RUNS_W).flex_none().child("LAST 10 RUNS")))
      .child(div().relative().w_full()
        .child(v_flex().pl(GUTTER).gap(GAP).children(rows.map(row)))
        .children(arcs.flatMap(arc)))
      .child(h_flex().gap(14).pl(GUTTER).text_size(11).text_color(t.dim)
        .child(div().text_color(t.ansi1).child("╌ fails back"))
        .child(div().child("◌ dashed ring: a check, no agent"))
        .child(div().text_color(t.ansi5).child("○ you")));
  }

  compare(t, doc) {
    const g = compareGrid(doc);
    const cell = (text, w, color, bold = false) => div().when(w == null, (el) => el.flex_1()).when(w != null, (el) => el.w(w).flex_none()).min_w_0().truncate()
      .text_color(color).when(bold, (el) => el.font_semibold()).child(text);
    const line = (kids, head = false) => h_flex().min_h(30).px(8).gap(8).items_center().border_b(1).border_color(t.border)
      .text_size(head ? 11 : 12).children(kids);
    return v_flex().gap(8)
      .child(div().text_size(12.5).text_color(t.muted).child("Which step each blueprint runs. A step in more than one column is one file: change it once, every blueprint gets it."))
      .child(v_flex().rounded(8).border(1).border_color(t.border).bg(t.surface)
        .child(line([cell("STEP", 130, t.dim), ...g.names.map((n) => cell(n.toUpperCase(), null, n === this.picked(this.list(doc))?.name ? t.accent : t.dim)), cell("USED BY", 56, t.dim)], true))
        .children(g.rows.map((r) => line([cell(r.step, 130, t.foreground, true), ...r.cells.map((c) => cell(c ?? "–", null, c ? t.foreground : t.dim)), cell(String(r.used), 56, t.muted)]))))
      .when(g.inline.length > 0, (el) => el.child(div().text_size(12).text_color(t.dim).child(`Written out in the blueprint, no step: ${g.inline.join(", ")}.`)));
  }

  stepsView(t, steps) {
    const cell = (text, w, color) => div().when(w == null, (el) => el.flex_1()).when(w != null, (el) => el.w(w).flex_none()).min_w_0().truncate().text_color(color).child(text);
    return v_flex().rounded(8).border(1).border_color(t.border).bg(t.surface)
      .child(h_flex().min_h(30).px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11)
        .child(cell("STEP", 130, t.dim)).child(cell("LEAVES BEHIND", null, t.dim)).child(cell("USED BY", null, t.dim)).child(cell("RUNS 7D", 60, t.dim)))
      .children(steps.map((s) => h_flex().id(`step-${s.step}`).min_h(32).px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).cursor_pointer()
        .bg(s.step === this.step ? t.selected : t.surface).hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.step = s.step; this.handle.focus(); cx.notify(); })
        .child(cell(s.step, 130, t.foreground)).child(cell(s.leaves, null, t.muted)).child(cell(s.usedBy.join(", "), null, t.muted)).child(cell(String(s.runs), 60, t.foreground))));
  }

  // A pending maintainer request's draft of this blueprint, against the current one.
  draft(t, d) {
    const MARK = { added: [t.done, "+ added"], changed: [t.blocked, "~ changed"], same: [t.dim, ""] };
    return v_flex().gap(6).p(12).rounded(8).border(1).border_dashed().border_color(t.accent)
      .child(div().text_size(11).text_color(t.accent).child(`DRAFT FROM #${d.ticket}${d.title ? `: ${d.title}` : ""} · ${d.summary}`))
      .when(Boolean(d.error), (el) => el.child(div().text_color(t.ansi1).child(d.error)))
      .children(d.stages.map((s, i) => {
        const [color, word] = MARK[s.change] ?? MARK.same;
        return h_flex().gap(10).items_center().text_size(12)
          .child(div().w(20).flex_none().text_color(t.dim).child(String(i + 1)))
          .child(div().w(110).flex_none().truncate().font_semibold().text_color(s.change === "same" ? t.muted : t.foreground).child(s.id))
          .child(div().flex_1().min_w_0().truncate().text_color(t.dim).child([s.step ?? s.who, s.on_fail && `fails → ${s.on_fail}`].filter(Boolean).join(" · ")))
          .child(div().w(80).flex_none().text_color(color).child(word));
      }))
      .when(d.removed.length > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(`Removed: ${d.removed.map((s) => s.id).join(", ")}`)));
  }

  inspector(t, doc, b, rows, sel, steps) {
    const box = this.card(t, "bp-inspector").w(260).flex_none().p(14).gap(12);
    const sec = (s) => div().text_size(11).text_color(t.dim).child(s);
    const kv = (k, v, color = t.foreground) => h_flex().gap(10).items_start().text_size(12)
      .child(div().w(96).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w_0().text_color(color).child(v));
    const step = this.view === "steps" ? steps.find((s) => s.step === this.step) ?? null : null;
    const name = step?.step ?? sel?.step ?? null;
    const users = usedBy(doc, name);
    const info = name ? doc?.steps?.[name] : null;
    const btn = (id, label, click, primary = false) => div().id(id).w_full().px(10).py(5).rounded(6).border(1).border_color(primary ? t.accent : t.border)
      .text_size(12).text_color(primary ? t.accent : t.muted).text_center().cursor_pointer().hover((s) => s.bg(t.hover)).on_click(click).child(label);
    const usedByEl = name ? v_flex().gap(6)
      .child(sec("STEP USED BY"))
      .child(h_flex().flex_wrap().gap(6).children(users.map((n) => div().id(`go-${n}`).px(8).py(2).rounded(6).border(1).cursor_pointer()
        .border_color(n === b?.name && this.view !== "steps" ? t.accent : t.border).text_size(12).text_color(t.foreground).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.view = "flow"; this.go(n, name); this.handle.focus(); cx.notify(); })
        .child(`${n}${n === b?.name && this.view !== "steps" ? " · here" : ""}`))))
      .when(users.length > 1, (el) => el.child(div().text_size(12).text_color(t.muted).child(`Changing ${name} changes all ${users.length} blueprints.`))) : null;
    const actions = v_flex().gap(6).pt(4)
      .child(btn("open-step", "Open step  ⌘O", () => this.openStep(doc, name)))
      .child(btn("ask-change", "Ask maintainer to change", () => this.askChange(name, users.length), true));
    if (step) {
      return box.child(div().text_size(15).font_semibold().text_color(t.foreground).child(step.step))
        .when(Boolean(step.description), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(step.description)))
        .child(v_flex().gap(6).child(kv("Leaves", step.leaves)).child(kv("Runs 7d", String(step.runs))).when(Boolean(step.label), (el) => el.child(kv("File", step.label, t.muted))))
        .children(usedByEl ? [usedByEl] : []).child(actions);
    }
    if (!sel) return box.child(div().text_color(t.dim).child(b?.draftOnly ? "A pending request drafts this blueprint; it has no stages yet." : "Pick a stage."));
    const runsBy = sel.grooming ? "the triage agent" : sel.you ? "you" : sel.requires === "ready" ? `the ready rules${sel.agent ? `, then the ${sel.agent} agent` : ""}` : sel.check ? `a ${sel.check} check, no agent` : sel.agent ? `the ${sel.agent} agent` : "the daemon";
    const pct = passPct(sel);
    const recent = (sel.recent ?? []).map((r) => h_flex().gap(8).text_size(12)
      .child(div().w(44).flex_none().text_color(t.dim).child(`#${r.ticket}`))
      .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(r.title))
      .child(div().flex_none().text_color(r.outcome === "fail" ? t.ansi1 : r.outcome === "running" ? t.accent : t.muted)
        .child(r.outcome === "running" ? "running" : r.outcome === "fail" ? `fail → ${sel.on_fail ?? "parked"}` : `${r.outcome} · ${took(r.duration_s)}`)));
    return box
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(sel.id))
        .when(sel.you, (el) => el.child(div().px(6).rounded(8).border(1).border_color(t.ansi5).text_size(10.5).text_color(t.ansi5).child("you")))
        .when(sel.skip, (el) => el.child(div().px(6).rounded(8).border(1).border_color(t.dim).text_size(10.5).text_color(t.dim).child("may skip"))))
      .when(Boolean(info?.description), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(info.description)))
      .child(v_flex().gap(6)
        .child(kv("Runs", runsBy))
        .child(kv("Step", sel.grooming ? "triage, before any blueprint" : sel.step ? `${sel.step} · ${users.length > 1 ? "shared" : "only here"}` : "none: written out in the blueprint", sel.step ? t.foreground : t.dim))
        .child(kv("Leaves", info?.output ?? leaves(sel)))
        .child(kv("Pass →", passTo(sel), t.done))
        .when(Boolean(sel.on_fail), (el) => el.child(kv("Fail →", sel.on_fail, t.ansi1)))
        .when(Boolean(sel.must), (el) => el.child(kv("Must end with", sel.must)))
        .when(Boolean(sel.waits), (el) => el.child(kv("Waits for", sel.waits)))
        .child(kv(`Last ${doc.days} days`, sel.runs ? `${sel.runs} run${sel.runs === 1 ? "" : "s"}${pct != null ? ` · ${pct}% pass` : ""} · median ${took(sel.median_s)}` : "no runs", sel.runs ? t.foreground : t.dim)))
      .children(usedByEl ? [usedByEl] : [])
      .when(recent.length > 0, (el) => el.child(v_flex().gap(6).child(sec("RECENT RUNS")).children(recent)))
      .when(!sel.grooming, (el) => el.child(actions));
  }
}
