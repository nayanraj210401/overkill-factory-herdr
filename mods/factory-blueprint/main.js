import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, readTextFile, watchFolder, checking, props } from "herdr";
import { validateBlueprints, stageOrder, stageNotes, draftsFor } from "./lib/blueprints.js";
import { root, status } from "./lib/store.js";
import { v2UI } from "./lib/model.js";
import { BlueprintV2 } from "./v2.js";

// Blueprint: each blueprint's stages in the order a ticket meets them, with run
// counts from the daemon's blueprints.json (docs/layouts/05-blueprint.png).
export default class FactoryBlueprint extends View {
  init(_props, cx) {
    this.doc = null;
    this.error = null;
    this.picked = null;
    this.v2 = new BlueprintV2(cx, props() ?? {}); // props: only smoke.sh passes them // drawn instead while the V2_UI gate is on (v2.js)
    cx.spawn(async (cx) => {
      for (;;) {
        const dir = root();
        await this.load(dir);
        cx.notify();
        if (checking()) return;
        const watch = watchFolder(dir);
        await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
        watch.cancel();
      }
    });
  }

  async load(dir) {
    const text = await readTextFile(`${dir}/blueprints.json`);
    if (text == null) return void ((this.doc = null), (this.error = "No blueprints.json yet: the daemon writes it (factory run), or run factory blueprints."));
    try {
      const doc = JSON.parse(text);
      const errors = validateBlueprints(doc);
      [this.doc, this.error] = errors.length ? [null, `blueprints.json: ${errors[0]}`] : [doc, null];
    } catch (e) {
      [this.doc, this.error] = [null, `blueprints.json: ${e.message}`];
    }
  }

  box(t, { id, label, sub, tone = "border", dashed = false, dim = false }) {
    return v_flex().id(`s-${id}`).w(132).h(58).flex_none().items_center().justify_center().gap(2).rounded(8).border(tone === "border" ? 1 : 2)
      .when(dashed, (el) => el.border_dashed()).border_color(t[tone]).bg(tone === "blocked" ? t.surface : t.background)
      .child(div().font_semibold().text_color(dim ? t.muted : t.foreground).child(label))
      .child(div().text_size(11).text_color(t.muted).child(sub));
  }

  render() {
    if (v2UI(status())) return this.v2.render(this.doc, this.error);
    const t = theme();
    const current = this.doc?.blueprints ?? [];
    // A blueprint only a pending request creates still gets a chip, with just its draft.
    const bps = [...current, ...(this.doc?.drafts ?? []).filter((d, i, all) => !current.some((x) => x.name === d.name) && all.findIndex((x) => x.name === d.name) === i).map((d) => ({ name: d.name, error: null, stages: [], draftOnly: true }))];
    const b = bps.find((x) => x.name === this.picked) ?? bps.find((x) => x.name === "feature") ?? bps[0];
    const drafts = b ? draftsFor(this.doc, b.name) : [];
    const chip = (x) => div().id(`b-${x.name}`).px(14).py(4).rounded_full().border(1).cursor_pointer()
      .border_color(x === b ? t.accent : t.border).text_color(x === b ? t.accent : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.picked = x.name; cx.notify(); }).child(x.name);
    const arrow = () => div().flex_none().px(4).text_color(t.dim).child("→");
    const stages = b && !b.error ? stageOrder(b) : [];
    const path = stages.filter((s) => s.onPath);
    const off = stages.filter((s) => !s.onPath);
    const runs = (n) => `${n} run${n === 1 ? "" : "s"}`;
    const tone = (s) => (s.gate === "human" ? "blocked" : "border");
    const stageBox = (s) => v_flex().gap(4).items_center()
      .child(this.box(t, { id: s.id, label: s.id, sub: runs(s.runs), tone: tone(s) }))
      .child(div().text_size(11).text_color(s.gate === "human" ? t.blocked : t.dim).child(s.gate === "human" ? "human gate" : s.requires === "ready" ? "needs ready rules" : s.who))
      .when(Boolean(s.step), (el) => el.child(div().text_size(11).text_color(t.muted).child(`step: ${s.step}`)));
    const MARK = { added: ["done", "+ added"], changed: ["blocked", "~ changed"] };
    const draftBox = (s) => {
      const [tn, word] = MARK[s.change] ?? ["border", ""];
      return v_flex().gap(4).items_center()
        .child(this.box(t, { id: `d-${s.id}`, label: s.id, sub: word || s.who, tone: tn }))
        .child(div().text_size(11).text_color(s.change === "same" ? t.dim : t[tn]).child(word ? s.who : s.gate === "human" ? "human gate" : ""));
    };
    const draftView = (d) => v_flex().gap(8).pt(10)
      .child(div().text_size(11).text_color(t.accent).child(`DRAFT FROM #${d.ticket}${d.title ? `: ${d.title}` : ""} · ${d.summary}`))
      .when(Boolean(d.error), (el) => el.child(div().text_color(t.blocked).child(d.error)))
      .child(h_flex().flex_wrap().items_start().gap(4).children(d.stages.filter((s) => s.onPath).flatMap((s, i) => (i ? [arrow(), draftBox(s)] : [draftBox(s)]))))
      .when(d.stages.some((s) => !s.onPath), (el) => el.child(h_flex().flex_wrap().gap(8).children(d.stages.filter((s) => !s.onPath).map(draftBox))))
      .when(d.removed.length > 0, (el) => el.child(div().text_color(t.muted).child(`Removed: ${d.removed.map((s) => s.id).join(", ")}`)));
    return v_flex().size_full().p(16).gap(14).text_size(13).bg(t.background).overflow_y_scroll()
      .child(h_flex().gap(8).children(bps.map(chip)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.muted).child(this.error)))
      .when(Boolean(b?.error), (el) => el.child(div().text_color(t.blocked).child(`${b.name}: ${b.error}`)))
      .when(stages.length === 0 && drafts.length > 0, (el) => el.children(drafts.map(draftView)))
      .when(stages.length > 0, (el) => el
        .child(h_flex().flex_wrap().items_start().gap(4)
          .child(v_flex().gap(4).items_center().child(this.box(t, { id: "grooming", label: "grooming", sub: runs(b.grooming_runs), dashed: true, dim: true }))
            .child(div().text_size(11).text_color(t.dim).child("triage agent")))
          .children(path.flatMap((s) => [arrow(), stageBox(s)])))
        .when(off.length > 0, (el) => el.child(v_flex().gap(6)
          .child(div().text_size(11).text_color(t.dim).child("OFF THE USUAL PATH"))
          .child(h_flex().flex_wrap().gap(8).children(off.map(stageBox)))))
        .child(v_flex().gap(4).pt(6)
          .child(div().text_color(t.foreground).child(`Grooming picks this blueprint${b.orchestrator ? `, then the ${b.orchestrator} agent picks each next stage` : ""}.`))
          .children(stageNotes(b).map((n) => div().text_color(t.muted).child(n))))
        .children(drafts.map(draftView))
        .child(div().text_size(12).text_color(t.dim).child(`Counts are stage runs in the last ${this.doc.days} days; retries count again.`)));
  }
}
