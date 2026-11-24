// A stand-in for Herdr's gpui-kit, gpui-base and herdr modules, so a mod's render() runs
// under node. Every builder call is recorded on a plain tree ({ kind, calls, kids }), and
// layoutWidths() lays that tree out along x with the flexbox rules that decide whether a
// row fits: basis, grow, shrink, and the automatic minimum width (min-content unless min_w_0).

export const fake = { status: null, reviews: null };

function element(kind) {
  const node = { kind, calls: {}, kids: [] };
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop === "node") return node;
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (prop === "child") return (c) => { if (c != null && c !== false) node.kids.push(c); return proxy; };
      if (prop === "children") return (cs) => { for (const c of cs ?? []) if (c != null) node.kids.push(c); return proxy; };
      if (prop === "when") return (cond, f) => (cond ? f(proxy) : proxy);
      if (prop === "hover") return () => proxy;
      return (...args) => { node.calls[prop] = args; return proxy; };
    },
  });
  return proxy;
}

export const div = () => element("div");
export const h_flex = () => element("h");
export const v_flex = () => element("v");
export const svg = () => element("div");
export const image = () => element("div");
export class View {}
export const InputState = { new: () => ({ on() {}, value: () => "", set_value() {}, focus() {} }) };
export const Input = { new: () => element("div") };
export const TextView = { markdown: (id, text) => element("div").child(text) };
export const EditorState = { new: () => { let v = ""; return { value: () => v, set_value(x) { v = x; }, on() {}, focus() {} }; } };
export const Editor = { new: () => element("div") };
export const ScrollHandle = { new: () => ({ scroll_to_item() {}, release() {} }) };

// herdr: lib/store.js reads the status from shared("factory.state"); that is fake.status.
export const settings = () => ({ dark: true });
export const theme = () => new Proxy({}, { get: (_t, k) => `color:${String(k)}` });
export const checking = () => false;
export const shared = (key) => (key === "factory.state" ? { at: 0, status: fake.status, errors: [] } : null);
export const setShared = () => {};
export const run = () => {};
export const exec = () => {};
export const hc = async () => ({ code: 1, stdout: "", stderr: "" });
export const notify = () => {};
export const props = () => ({});
export const readTextFile = async () => null;
export const watchFolder = () => ({ then() {}, cancel() {} });
export const appHome = () => "/fake";
export const home = () => "/fake";
export const spaces = () => [];
export const openOverlay = () => {};

export const cx = { focus_handle: () => ({ is_focused: () => true, focus() {} }), spawn() {}, notify() {} };

// --- layout ---

const node = (el) => (el && typeof el === "object" ? el.node ?? el : el);
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}/u;
// Display width in px at 13px text: a narrow glyph ~0.6em, a CJK or emoji one twice that.
export const textWidth = (s) => [...segmenter.segment(String(s).replace(/\x1b\[[0-9;]*m/g, ""))]
  .reduce((n, { segment }) => n + (WIDE.test(segment) ? 2 : 1) * 7.8, 0);

const num = (n, name) => (n.calls[name] ? n.calls[name][0] : null);
const has = (n, name) => name in n.calls;
const padL = (n) => num(n, "pl") ?? num(n, "px") ?? num(n, "p") ?? 0;
const padR = (n) => num(n, "pr") ?? num(n, "px") ?? num(n, "p") ?? 0;
const padX = (n) => padL(n) + padR(n);
const fixedW = (n) => num(n, "w") ?? num(n, "size");
const minW = (n) => (has(n, "min_w_0") ? 0 : num(n, "min_w"));

// The width the content asks for, nothing wrapping (truncate and h_flex never wrap).
function content(el) {
  if (typeof el !== "object") return textWidth(el);
  const n = node(el);
  const f = fixedW(n);
  if (f != null) return f;
  const kids = n.kids.map(content);
  const inner = n.kind === "h" ? kids.reduce((a, b) => a + b, 0) + (num(n, "gap") ?? 0) * Math.max(0, kids.length - 1) : Math.max(0, ...kids);
  return Math.max(inner + padX(n), num(n, "min_w") ?? 0);
}

// The automatic minimum width of a flex item: its min-content, unless min_w_0 / min_w(n) says otherwise.
function autoMin(n) {
  const m = minW(n);
  if (m != null) return m;
  const f = fixedW(n);
  return f != null ? Math.min(f, content(n)) : content(n);
}

// Lays `el` out at `width`, storing x and width on every node (and `used` on a row).
function place(el, x, width) {
  if (typeof el !== "object") return;
  const n = node(el);
  n.x = x;
  n.width = width;
  const inner = width - padX(n);
  const left = x + padL(n);
  const kids = n.kids.filter((k) => typeof k === "object").map(node);
  if (n.kind !== "h") { // block / column: children stretch, but never below their own minimum
    for (const k of kids) place(k, left, fixedW(k) ?? Math.max(inner, num(k, "min_w") ?? 0));
    return;
  }
  const gap = num(n, "gap") ?? 0;
  const items = kids.map((k) => {
    const grow = has(k, "flex_1") ? 1 : 0;
    const basis = fixedW(k) ?? (grow ? 0 : content(k));
    return { k, basis, grow, shrink: has(k, "flex_none") ? 0 : 1, min: autoMin(k), size: basis };
  });
  let free = inner - gap * Math.max(0, items.length - 1) - items.reduce((a, i) => a + i.basis, 0);
  // Resolve flexible lengths: grow or shrink, freeze items at their minimum, repeat.
  for (let round = 0; round < items.length + 1; round++) {
    const open = items.filter((i) => !i.frozen && (free > 0 ? i.grow : i.shrink));
    if (!open.length || Math.abs(free) < 1e-6) break;
    const weight = open.reduce((a, i) => a + (free > 0 ? i.grow : i.shrink * i.basis), 0);
    if (!weight) break;
    for (const i of open) i.size = i.size + free * (free > 0 ? i.grow : i.shrink * i.basis) / weight;
    const clamped = open.filter((i) => i.size < i.min);
    for (const i of clamped) { i.size = i.min; i.frozen = true; }
    free = inner - gap * Math.max(0, items.length - 1) - items.reduce((a, i) => a + i.size, 0);
    if (!clamped.length) break;
  }
  let at = left;
  for (const i of items) { place(i.k, at, Math.max(i.size, i.min)); at += Math.max(i.size, i.min) + gap; }
  n.used = (items.length ? at - gap : left) - x + padR(n); // how wide the children actually are
}

export function layoutWidths(el, width) {
  place(el, 0, width);
  return node(el);
}

export function find(root, pred, path = []) {
  const n = node(root);
  if (typeof n !== "object") return [];
  const here = pred(n) ? [{ n, path }] : [];
  return here.concat(...n.kids.map((k) => find(k, pred, [...path, n])));
}

export const text = (n) => n.kids.filter((k) => typeof k !== "object").join("");
