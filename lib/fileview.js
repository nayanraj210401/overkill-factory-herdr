// The read-only file browser both config pages draw: a list of files, the selected one with line
// numbers and highlighting, and Open in editor (⌘O). Config shows ~/.factory, Repo config a repo's
// .factory/. ⌘O reaches the header (scripts/gen.mjs), which opens what the shown page selected:
// each page publishes its selected file under its page id (openTarget).
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, EditorState, Editor } from "gpui-base";
import { theme, exec, readTextFile, shared, setShared } from "herdr";

const OPEN_KEY = "factory.open-file";
export const openTarget = (page) => shared(OPEN_KEY)?.[page] ?? null;
export const openFile = (file) => file && exec("open", [file]);

export class FileView {
  constructor(page) {
    this.page = page;
    this.dir = null;
    this.files = [];
    this.selected = null; // { path, language }
    this.text = null; // the selected file's text
    this.editor = null;
    this.editors = {}; // absolute path → its read-only EditorState, made once (a language is fixed at creation)
  }

  get file() {
    return this.selected && this.dir ? `${this.dir}/${this.selected.path}` : null;
  }

  // A new folder or list keeps the selection when the file is still there, else shows the first.
  async show(dir, files) {
    const same = dir === this.dir;
    this.dir = dir;
    this.files = files;
    const keep = (same && this.selected && files.find((f) => f.path === this.selected.path)) || files[0];
    if (keep) await this.select(keep);
    else this.clear();
  }

  clear() {
    this.selected = null;
    this.editor = null;
    this.text = null;
    this.publish();
  }

  // Shows a file. The caller repaints, with a cx of its own (see tests/mods.test.mjs).
  async select(f) {
    const t = theme();
    const key = `${this.dir}/${f.path}`;
    const text = (await readTextFile(key)) ?? "";
    let editor = this.editors[key];
    if (!editor) {
      editor = this.editors[key] = EditorState.new({ language: f.language, value: text, readonly: true, soft_wrap: true,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi3, constant: t.ansi4, boolean: t.ansi3 } });
    } else if (editor.value() !== text) editor.set_value(text);
    this.editor = editor;
    this.selected = f;
    this.text = text;
    this.publish();
  }

  publish() {
    if ((shared(OPEN_KEY)?.[this.page] ?? null) !== this.file) setShared(OPEN_KEY, { ...shared(OPEN_KEY), [this.page]: this.file });
  }

  // One row: icon, path, and `extra` (the schema mark) on the right; `sub` (the badge) under the path.
  row(t, f, extra = null, sub = null) {
    const on = f.path === this.selected?.path;
    return v_flex().id(`f-${f.path}`).flex_none().min_h(28).px(8).py(5).justify_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      // select awaits the file; this click's cx is gone by then, so a spawned task repaints.
      .on_click((_e, cx) => cx.spawn(async (cx) => { await this.select(f); cx.notify(); }))
      .child(h_flex().gap(8).items_center()
        .child(svg(`mods/workspace-chrome/${f.language === "markdown" ? "file-text" : "settings"}.svg`).size(13).flex_none())
        .child(div().flex_1().min_w_0().truncate().child(f.path))
        .children(extra ? [extra] : []))
      .when(Boolean(sub), (el) => el.child(h_flex().pl(21).pt(3).gap(6).items_center().text_size(11).text_color(t.dim).child(sub)));
  }

  // The list card: a caption, the rows, then `foot` (an error or an empty state).
  list(t, caption, rows, foot = null) {
    return v_flex().id(`${this.page}-files`).w(300).flex_none().h_full().min_h(0).p(8).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border).overflow_y_scrollbar()
      .child(div().px(8).pb(6).text_size(11).text_color(t.dim).child(caption))
      .children(rows)
      .children(foot ? [foot] : []);
  }

  // The viewer card: the path, `labels` (schema check, badge), Open in editor, then `under` (problems).
  pane(t, labels = [], under = null) {
    return v_flex().flex_1().min_w(0).min_h(0).h_full().rounded(10).bg(t.background).border(1).border_color(t.border)
      .child(h_flex().h(36).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w_0().font_semibold().text_color(t.foreground).truncate().child(this.selected?.path ?? "No file"))
        .children(labels)
        .child(div().id(`${this.page}-open`).px(8).py(2).rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => openFile(this.file))
          .child("Open in editor ⌘O")))
      .children(under ? [under] : [])
      .child(div().flex_1().min_h(0).p(4).when(Boolean(this.editor), (el) => el.child(Editor.new(this.editor).size_full())));
  }
}

// The line both pages carry: who changes these files, and a button that asks it.
export function maintainerLine(t, text, onAsk) {
  return h_flex().id("maintainer-line").flex_none().h(32).px(14).gap(10).items_center().rounded(10).bg(t.surface).border(1).border_color(t.border).text_size(12)
    .child(div().flex_1().min_w_0().truncate().text_color(t.muted).child(text))
    .child(div().id("ask-maintainer").flex_none().px(10).py(2).rounded(6).border(1).border_color(t.accent).text_color(t.accent).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onAsk).child("Ask maintainer"));
}

// `find <args> -type f` in `dir` (default every file under it), as paths relative to it. A
// missing folder is null when the search starts at "."; a missing named folder is skipped.
export async function listFiles(dir, args = ["."]) {
  const r = await exec("find", [...args, "-type", "f"], { cwd: dir }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  const paths = (r.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
  if (r.code !== 0 && !paths.length && args[0] === ".") return null;
  return paths;
}

// Each file's badge (fileBadge): `precedence(path)` names the copies to compare with; the first
// that exists is read. Missing files read as null, so a lookup costs one read per candidate.
export async function badgesFor(dir, files, precedence, fileBadge) {
  const out = {};
  for (const f of files) {
    const p = precedence(f.path);
    if (!p.ignored && !p.others.length) continue;
    let found = null;
    for (const o of p.others) {
      const text = await readTextFile(o.file);
      if (text != null) { found = { ...o, text }; break; }
    }
    out[f.path] = fileBadge(p, found, found ? await readTextFile(`${dir}/${f.path}`) : null);
  }
  return out;
}

// A badge pill for a file row or the viewer's header.
export function badgePill(t, b) {
  if (!b?.badge) return null;
  const color = b.tone === "accent" ? t.accent : b.tone === "blocked" ? t.blocked : t.dim;
  return div().flex_none().px(6).rounded(8).border(1).border_color(color).text_size(10.5).text_color(color).child(b.badge);
}

// A file row with its badge, its note ("differs from built-in") and its schema mark (✓ or ✗ n).
export function badgedRow(view, t, f, badge, errors) {
  const mark = errors ? div().flex_none().text_size(11).text_color(errors.length ? t.blocked : t.done).child(errors.length ? `✗ ${errors.length}` : "✓") : null;
  const sub = badge?.badge ? h_flex().min_w_0().gap(6).items_center().child(badgePill(t, badge))
    .when(Boolean(badge.note), (el) => el.child(div().min_w_0().truncate().child(badge.note))) : null;
  return view.row(t, f, mark, sub);
}

// The viewer's labels: the selected file's badge and its schema check.
export function viewerLabels(t, badge, errors) {
  const check = !errors ? div().text_size(12).text_color(t.dim).child("Schema check: not run")
    : div().text_size(12).text_color(errors.length ? t.blocked : t.done)
      .child(errors.length ? `Schema check: ${errors.length} ${errors.length === 1 ? "problem" : "problems"}` : "Schema check: passes");
  return [badgePill(t, badge), check].filter(Boolean);
}

// Under the viewer's header: why the badge (and the note), then the schema problems; null when neither.
export function viewerDetail(t, badge, errors) {
  if (!errors?.length && !badge?.why) return null;
  return v_flex().px(14).py(8).gap(2).flex_none().border_b(1).border_color(t.border).text_size(12)
    .when(Boolean(badge?.why), (el) => el.child(div().w_full().truncate().text_color(t.muted).child(`${badge.why}${badge.note ? ` · ${badge.note}` : ""}`)))
    .children((errors ?? []).map((e) => div().w_full().truncate().text_color(t.blocked).child(e)));
}
