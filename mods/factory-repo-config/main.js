import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, watchFolder, checking, appHome, home } from "herdr";
import { configFiles } from "./lib/model.js";
import { repoChoices, leadOf, repoPrecedence, fileBadge, checkoutOf, maintainerAsk } from "./lib/configfiles.js";
import { FileView, listFiles, badgesFor, badgedRow, viewerLabels, viewerDetail, maintainerLine } from "./lib/fileview.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh
import { root, status, factories, ask } from "./lib/store.js";

// `herdr-app check` has no factory index: the sample repo (its .factory/ is installed beside the
// sample status.json) and a second repo with none, so both the list and the empty state draw.
const CHECK_REPOS = () => [{ slug: "acme/api", path: `${appHome()}/factory-data/acme-api`, lead: true }, { slug: "acme/web", path: "/sample/acme-web", lead: false }];

// The Repo config page: one repo of the shown factory at a time (a switcher, the lead first), its
// own .factory/ files, the selected one read-only with its schema check, ⌘O to edit it in your
// editor, and on each file what it overrides (lib/configfiles.js mirrors the daemon's lookups).
export default class FactoryRepoConfig extends View {
  init(_props, cx) {
    this.view = new FileView("repo-config");
    this.repo = null; // the shown repo's path; null: the lead
    this.error = null;
    this.badges = {};
    this.checks = {};
    this.poke = null;
    const wait = (ms) => new Promise((done) => cx.timer.after(ms, done));
    cx.spawn(async (cx) => {
      await this.list();
      cx.notify();
      if (checking()) return;
      for (;;) {
        this.validate(cx); // the schema check fills in after the files show
        // A repo without .factory/ has nothing to watch: look again soon. A switch pokes the loop.
        const watch = this.error ? null : watchFolder(this.dir);
        const poked = new Promise((done) => { this.poke = done; });
        await Promise.race([watch?.catch(() => new Promise(() => {})) ?? new Promise(() => {}), poked, wait(this.error ? 3000 : 30000)]);
        watch?.cancel?.();
        this.poke = null; // a pick from here on reloads by itself
        await wait(300); // one reload for a burst of saves
        await this.list();
        cx.notify();
      }
    });
  }

  repos() {
    return checking() ? CHECK_REPOS() : repoChoices(factories(), status(), root());
  }

  // The shown repo: the one picked, while the factory still has it, else the lead.
  shown() {
    const list = this.repos();
    return list.find((r) => r.path === this.repo) ?? list[0] ?? null;
  }

  get dir() {
    const r = this.shown();
    return r ? `${r.path}/.factory` : null;
  }

  pick(r, cx) {
    if (r.path === this.shown()?.path) return;
    this.repo = r.path;
    this.checks = {};
    this.badges = {};
    if (this.poke) this.poke();
    else cx.spawn(async (cx) => { await this.list(); cx.notify(); });
    cx.notify();
  }

  async list() {
    const r = this.shown();
    const dir = this.dir;
    const paths = dir ? await listFiles(dir) : null;
    if (paths == null) {
      this.error = r ? `${r.slug} has no .factory/ folder` : "No factory is shown";
      this.badges = {};
      return this.view.show(dir, []);
    }
    this.error = null;
    const files = configFiles(paths);
    await this.view.show(dir, files);
    const lead = leadOf(this.repos());
    const o = { home: `${home()}/.factory`, checkout: checkoutOf(CLI), lead: r.lead ? null : lead };
    this.badges = await badgesFor(dir, files, (p) => repoPrecedence(p, o), fileBadge);
  }

  // The daemon's schema check of this .factory/, per file: path → errors (undefined while unknown).
  validate(cx) {
    if (this.error) return;
    const dir = this.dir;
    cx.spawn(async (cx) => {
      const v = await exec(CLI[0], [...CLI.slice(1), "validate", dir, "--json"], { timeout: 20000 }).catch(() => null);
      if (dir !== this.dir) return;
      try { this.checks = Object.fromEntries(JSON.parse(v.stdout).map((x) => [x.path, x.errors])); } catch { this.checks = {}; }
      cx.notify();
    });
  }

  switcher(t, list, shown) {
    return h_flex().id("repo-switcher").flex_none().gap(6).items_center().flex_wrap()
      .child(div().pr(4).text_size(11).text_color(t.dim).child("REPO"))
      .children(list.map((r) => {
        const on = r.path === shown?.path;
        return h_flex().id(`repo-${r.slug}`).h(26).px(10).gap(6).items_center().rounded(7).border(1).cursor_pointer()
          .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(r, cx))
          .child(div().child(r.slug))
          .when(r.lead, (el) => el.child(div().text_size(11).text_color(t.dim).child("lead")));
      }))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child("Local to this machine, never pushed"));
  }

  empty(t, r) {
    return v_flex().id("no-factory").flex_1().min_h(0).items_center().justify_center().gap(6).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(this.error))
      .child(div().text_color(t.muted).child(r && !r.lead
        ? "Its tickets run the lead repo's agents and skills. A repo agent of its own goes in .factory/agents/ here."
        : "Factory setup writes one into the lead repo."))
      .child(div().text_size(12).text_color(t.dim).child("Ask the maintainer to add one; it edits .factory/ in place."));
  }

  render() {
    const t = theme();
    const v = this.view;
    const list = this.repos();
    const shown = this.shown();
    const sel = v.selected?.path;
    const ask_ = () => ask(maintainerAsk(shown && !shown.lead ? shown.slug : null));
    return v_flex().size_full().min_h(0).gap(8).text_size(13)
      .child(this.switcher(t, list, shown))
      .child(maintainerLine(t, `${shown ? `${shown.slug}/.factory` : ".factory"}: this repo's own settings. The maintainer makes every change here; this view is read-only.`, ask_))
      .child(this.error ? this.empty(t, shown) : h_flex().flex_1().min_h(0).w_full().gap(8)
        .child(v.list(t, ".FACTORY", v.files.map((f) => badgedRow(v, t, f, this.badges[f.path], this.checks[f.path]))))
        .child(v.pane(t, viewerLabels(t, this.badges[sel], this.checks[sel]), viewerDetail(t, this.badges[sel], this.checks[sel]))));
  }
}
