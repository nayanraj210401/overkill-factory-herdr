// The Metrics page's line charts. A Herdr mod has no drawing surface, so the daemon draws
// each chart as an SVG and the page shows it with image(). renderChart is pure: a chart spec
// from lib/metrics.js's chartsFor in, SVG text out, once per appearance. Only the axes are
// text in the SVG; the headline, title and legend are the page's own text.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { CHART, PALETTE, chartsFor, minutes } from "../lib/metrics.js";
import { compact } from "../lib/model.js";

export type Mode = "light" | "dark";
export const MODES: Mode[] = ["light", "dark"];
type Unit = "count" | "usd" | "min" | "pct" | "tokens";
export type Chart = {
  id: string; kind: "line" | "stacked"; unit: Unit; days: string[];
  series: { name: string; values: (number | null)[] }[];
  ref?: { name: string; value: number };
  marks?: number[]; // day indices drawn as a dotted vertical rule (a tuning shift)
};

// The size the page shows a chart at (lib/metrics.js CHART); viewBox lets it scale.
const { w: W, h: H } = CHART;
const PAD = { left: 46, right: 10, top: 10, bottom: 24 };

// Axis ink follows Herdr's own theme: the layout names it (scripts/gen.mjs), and the daemon
// reads the installed theme file from the Herdr home, so charts match the app even when
// Herdr's theme changes. Light draws with that theme's background as ink over white; grid
// and labels are the ink mixed toward the card.
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => "#" + hex(a).map((x, i) => Math.round(x * t + hex(b)[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
const FALLBACK_THEME = { background: "#21252b", foreground: "#abb2bf" }; // atom-one-dark, when the home has no theme file (tests, fresh homes)
function loadDarkTheme(): { background: string; foreground: string } {
  try {
    const layout = JSON.parse(readFileSync(new URL("../layouts/factory.json", import.meta.url), "utf8"));
    const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
    if (layout.theme?.dark) {
      const file = join(home, "themes", `${layout.theme.dark}.json`);
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    }
  } catch {} // a stale or missing layout falls back below
  return FALLBACK_THEME;
}
const darkTheme = loadDarkTheme();
export function ink(mode: Mode) {
  const [fg, bg] = mode === "dark" ? [darkTheme.foreground, darkTheme.background] : [darkTheme.background, "#ffffff"];
  // Dark mode's ink is light text mixed toward the card; light mode's is dark ink over white,
  // mixed less so it stays clearly darker than dark mode's text (the appearance test pins this).
  const axis = mode === "dark" ? 0.6 : 0.8;
  return { axis: mix(fg, bg, axis), grid: mix(fg, bg, 0.14), ref: mix(fg, bg, mode === "dark" ? 0.75 : 0.9), series: PALETTE[mode] };
}

// About four round steps from 0 up past the top value: 1, 2, 2.5 or 5 times a power of ten.
// Counts step by whole numbers, shares by whole 5%, durations by clock steps; an all-zero
// chart still gets an axis (0 and 1).
const CLOCK = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
export function yTicks(top: number, unit: Unit) {
  const max = top > 0 ? top : 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  if (unit === "count") step = Math.max(1, Math.round(step));
  if (unit === "pct") step = Math.max(0.05, step);
  if (unit === "min") step = CLOCK.find((s) => s >= raw) ?? Math.ceil(raw / 1440) * 1440;
  const n = Math.ceil(max / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => +(i * step).toPrecision(12));
}

export function tickLabel(v: number, unit: Unit) {
  if (unit === "pct") return `${Math.round(v * 100)}%`;
  if (unit === "usd") return `$${v >= 1e4 ? compact(v) : +v.toFixed(2)}`;
  if (unit === "min") return v === 0 ? "0" : v % 60 === 0 && v < 1440 ? `${v / 60}h` : minutes(v);
  return v >= 1e4 ? compact(v).toUpperCase() : v.toLocaleString("en-US");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
// Up to four dates: the first, the last, and evenly between.
export const xTickDays = (n: number) => [...new Set(Array.from({ length: Math.min(n, 4) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(n, 4) - 1))))];

const f = (n: number) => +n.toFixed(1);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderChart(c: Chart, mode: Mode) {
  const k = ink(mode);
  const n = c.days.length;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  // Stacked: each series sits on the ones before it; a missing day counts as nothing spent.
  const stacks = c.kind === "stacked"
    ? c.series.reduce<number[][]>((acc, s, j) => [...acc, s.values.map((v, i) => (acc[j - 1]?.[i] ?? 0) + (v ?? 0))], [])
    : [];
  const values = c.kind === "stacked" ? stacks.flat() : c.series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const ticks = yTicks(Math.max(0, ...values, c.ref?.value ?? 0), c.unit);
  const top = ticks.at(-1)!;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const out: string[] = [];
  const text = (tx: number, ty: number, s: string, anchor: string) =>
    `<text x="${f(tx)}" y="${f(ty)}" text-anchor="${anchor}" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="11" fill="${k.axis}">${esc(s)}</text>`;
  for (const t of ticks) {
    out.push(`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${f(y(t))}" y2="${f(y(t))}" stroke="${k.grid}" stroke-width="1"/>`);
    out.push(text(PAD.left - 8, y(t) + 4, tickLabel(t, c.unit), "end"));
  }
  for (const i of xTickDays(n)) out.push(text(x(i), H - 6, dayLabel(c.days[i]), n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"));
  // Shift days under the lines, so a line crossing one stays whole.
  for (const i of c.marks ?? []) out.push(`<line x1="${f(x(i))}" x2="${f(x(i))}" y1="${PAD.top}" y2="${f(y(0))}" stroke="${k.ref}" stroke-width="1.5" stroke-dasharray="2 3"/>`);
  const color = (j: number) => k.series[j % k.series.length];
  if (c.kind === "stacked") {
    // Top layer first so each lower one paints over the band below it.
    for (let j = stacks.length - 1; j >= 0; j--) {
      const line = stacks[j].map((v, i) => `${f(x(i))},${f(y(v))}`);
      const base = j ? stacks[j - 1].map((v, i) => `${f(x(i))},${f(y(v))}`).reverse() : [`${f(x(n - 1))},${f(y(0))}`, `${f(x(0))},${f(y(0))}`];
      out.push(`<polygon points="${[...line, ...base].join(" ")}" fill="${color(j)}" fill-opacity="0.35" stroke="none"/>`);
      out.push(`<polyline points="${line.join(" ")}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  } else {
    c.series.forEach((s, j) => {
      // Runs of days with a value; a null breaks the line, a lone day is a dot.
      const runs: number[][] = [];
      s.values.forEach((v, i) => {
        if (v == null) return;
        if (i > 0 && s.values[i - 1] != null) runs.at(-1)!.push(i);
        else runs.push([i]);
      });
      for (const run of runs) {
        const pts = run.map((i) => `${f(x(i))},${f(y(s.values[i]!))}`);
        if (run.length === 1) { out.push(`<circle cx="${f(x(run[0]))}" cy="${f(y(s.values[run[0]]!))}" r="3" fill="${color(j)}"/>`); continue; }
        if (c.series.length === 1) out.push(`<polygon points="${[...pts, `${f(x(run.at(-1)!))},${f(y(0))}`, `${f(x(run[0]))},${f(y(0))}`].join(" ")}" fill="${color(j)}" fill-opacity="0.1" stroke="none"/>`);
        out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      }
    });
  }
  if (c.ref) out.push(`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${f(y(c.ref.value))}" y2="${f(y(c.ref.value))}" stroke="${k.ref}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  // Drawn at twice the viewBox so the raster stays sharp on a Retina screen.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}">\n${out.join("\n")}\n</svg>\n`;
}

// Every chart of every range, both appearances, into <dir>/charts/. A file's name carries a
// hash of its content: Herdr caches an image by its path, so a changed chart must be a new
// path. Returns the manifest metrics.json keeps ({range: {chart: {light, dark}}}) and the files
// it no longer names, which the caller removes once metrics.json points past them.
export function writeCharts(dir: string, doc: { ranges: Record<string, any> }) {
  const folder = join(dir, "charts");
  mkdirSync(folder, { recursive: true });
  const manifest: Record<string, Record<string, Record<Mode, string>>> = {};
  const keep = new Set<string>();
  for (const [range, r] of Object.entries(doc.ranges)) {
    manifest[range] = {};
    for (const c of chartsFor(r) as Chart[]) {
      manifest[range][c.id] = {} as Record<Mode, string>;
      for (const mode of MODES) {
        const svg = renderChart(c, mode);
        const name = `${range}-${c.id}-${mode}-${createHash("sha1").update(svg).digest("hex").slice(0, 10)}.svg`;
        if (!existsSync(join(folder, name))) writeFileSync(join(folder, name), svg);
        manifest[range][c.id][mode] = name;
        keep.add(name);
      }
    }
  }
  const stale = readdirSync(folder).filter((f) => f.endsWith(".svg") && !keep.has(f)).map((f) => join(folder, f));
  return { manifest, stale };
}

export const removeStale = (files: string[]) => { for (const f of files) rmSync(f, { force: true }); };

// image() takes a path inside Herdr's folder only, so <app home>/factory-charts/<factory> links
// to this factory's charts/ (lib/metrics.js chartAsset builds the same path). Kept pointing at
// the right folder; skipped when Herdr isn't installed or the charts already live inside it.
const lstatExists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const appHome = () => process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app");
export function linkCharts(dir: string, home = appHome()) {
  if (!existsSync(home) || dir.startsWith(`${home}/`)) return null;
  const link = join(home, "factory-charts", basename(dir));
  const target = join(dir, "charts");
  mkdirSync(dirname(link), { recursive: true });
  if (lstatExists(link)) {
    if (!lstatSync(link).isSymbolicLink()) return null; // something of the person's: leave it
    if (readlinkSync(link) === target) return link;
    unlinkSync(link);
  }
  symlinkSync(target, link);
  return link;
}
