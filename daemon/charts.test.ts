import { test, expect } from "bun:test";
import "./test-env.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./db.ts";
import { renderChart, yTicks, tickLabel, xTickDays, ink, writeCharts, linkCharts, type Chart } from "./charts.ts";
import { writeMetrics } from "./cli.ts";
import { PALETTE, chartsFor } from "../lib/metrics.js";

const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
const chart = (o: Partial<Chart> & { series: Chart["series"] }): Chart => ({ id: "c", kind: "line", unit: "count", days: days(o.series[0].values.length), ...o });
const lines = (svg: string) => [...svg.matchAll(/<polyline points="([^"]+)"[^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => ({ points: m[1].split(" ").length, color: m[2] }));
const labels = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const tmp = () => mkdtempSync(join(tmpdir(), "charts-"));

test("y ticks: about four round steps from 0, past the top value", () => {
  expect(yTicks(7, "count")).toEqual([0, 2, 4, 6, 8]);
  expect(yTicks(4.77, "usd")).toEqual([0, 2, 4, 6]);
  expect(yTicks(2, "count")).toEqual([0, 1, 2]);
  expect(yTicks(0, "count")).toEqual([0, 1]);           // all zero: an axis all the same
  expect(yTicks(0.5, "pct")).toEqual([0, 0.2, 0.4, 0.6]);
  expect(yTicks(0.02, "pct")).toEqual([0, 0.05]);      // whole percents only
  expect(yTicks(70, "min")).toEqual([0, 30, 60, 90]);   // clock steps
  expect(yTicks(14_790_000, "tokens")).toEqual([0, 5e6, 10e6, 15e6]);
  expect([tickLabel(0.25, "pct"), tickLabel(2.5, "usd"), tickLabel(90, "min"), tickLabel(120, "min"), tickLabel(15e6, "tokens"), tickLabel(2000, "count")]).toEqual(["25%", "$2.5", "1.5h", "2h", "15M", "2,000"]);
});

test("x ticks: up to four dates, the first and the last among them", () => {
  expect(xTickDays(30)).toEqual([0, 10, 19, 29]);
  expect(xTickDays(3)).toEqual([0, 1, 2]);
  expect(xTickDays(1)).toEqual([0]);
});

test("one series: a 2px line with a wash under it, gridlines per tick, axis text only", () => {
  const svg = renderChart(chart({ series: [{ name: "Merged", values: [1, 3, 2, 7] }] }), "light");
  expect(lines(svg)).toEqual([{ points: 4, color: PALETTE.light[0] }]);
  expect(svg).toContain('fill-opacity="0.1"');
  expect(svg).toContain('viewBox="0 0 520 180"');
  expect(labels(svg)).toEqual(["0", "2", "4", "6", "8", "Nov 1", "Nov 2", "Nov 3", "Nov 4"]);
  expect(svg).not.toContain("Merged"); // the legend and title are the page's text
});

test("several series: one line each in palette order, no wash", () => {
  const svg = renderChart(chart({ series: [{ name: "Opened", values: [1, 2, 1] }, { name: "Merged", values: [0, 1, 2] }] }), "dark");
  expect(lines(svg)).toEqual([{ points: 3, color: PALETTE.dark[0] }, { points: 3, color: PALETTE.dark[1] }]);
  expect(svg).not.toContain('fill-opacity="0.1"');
});

test("gaps: a null day breaks the line instead of dropping to zero; a lone day is a dot", () => {
  const svg = renderChart(chart({ series: [{ name: "x", values: [5, 6, null, 4, null, null, 8, 9, 7] }] }), "light");
  expect(lines(svg).map((l) => l.points)).toEqual([2, 3]);
  expect(svg.match(/<circle /g)).toHaveLength(1);
  const one = renderChart(chart({ series: [{ name: "x", values: [3] }] }), "light");
  expect(lines(one)).toEqual([]);
  expect(one).toContain('<circle cx="278"'); // a single point sits in the middle
  expect(labels(one).at(-1)).toBe("Nov 1");
});

test("all zero: a flat line on the baseline under a 0–1 axis", () => {
  const svg = renderChart(chart({ series: [{ name: "x", values: [0, 0, 0] }] }), "dark");
  expect(labels(svg).slice(0, 2)).toEqual(["0", "1"]);
  expect(svg).toContain('points="46,156 278,156 510,156"');
});

test("stacked: each part sits on the ones before; the axis covers the total", () => {
  const svg = renderChart(chart({ kind: "stacked", unit: "usd", series: [{ name: "a", values: [1, 2] }, { name: "b", values: [3, null] }] }), "light");
  expect(svg.match(/<polygon /g)).toHaveLength(2);
  expect(labels(svg).slice(0, 3)).toEqual(["$0", "$1", "$2"].slice(0, 3)); // total 4: 0,1,2,3,4
  expect(labels(svg)).toContain("$4");
  // b's top edge: 4 on day 1, 2 on day 2 (its missing day adds nothing)
  const top = svg.match(new RegExp(`<polyline points="([^"]+)"[^>]*stroke="${PALETTE.light[1]}"`))![1];
  expect(top).toBe("46,10 510,83");
});

test("a budget level: dashed, and the axis reaches it", () => {
  const svg = renderChart(chart({ unit: "tokens", series: [{ name: "x", values: [1e6, 2e6] }], ref: { name: "Daily budget", value: 8e6 } }), "dark");
  expect(svg).toContain('stroke-dasharray="5 4"');
  expect(labels(svg)).toContain("8M");
});

test("shift marks: a dotted rule at each marked day, drawn under the line", () => {
  const svg = renderChart(chart({ unit: "usd", series: [{ name: "x", values: [2, 3, 1] }], marks: [1] }), "light");
  const rule = svg.match(/<line x1="([\d.]+)" x2="([\d.]+)" y1="10" y2="([\d.]+)"[^>]*stroke-dasharray="2 3"\/>/)!;
  expect(rule[1]).toBe("278"); // the middle of three days
  expect(svg.indexOf('stroke-dasharray="2 3"')).toBeLessThan(svg.indexOf("<polyline"));
  expect(renderChart(chart({ unit: "usd", series: [{ name: "x", values: [2, 3, 1] }] }), "light")).not.toContain('stroke-dasharray="2 3"');
});

test("light and dark: the palette and the axis ink each step for their appearance", () => {
  const c = chart({ series: [{ name: "x", values: [1, 2] }] });
  const [light, dark] = [renderChart(c, "light"), renderChart(c, "dark")];
  expect(lines(light)[0].color).toBe(PALETTE.light[0]);
  expect(lines(dark)[0].color).toBe(PALETTE.dark[0]);
  expect(light).toContain(`fill="${ink("light").axis}"`);
  expect(dark).toContain(`fill="${ink("dark").axis}"`);
  expect(ink("light").axis).not.toBe(ink("dark").axis);
  // dark text is light ink (Herdr's theme foreground), light text is dark ink
  const lum = (h: string) => parseInt(h.slice(1, 3), 16);
  expect(lum(ink("dark").axis)).toBeGreaterThan(lum(ink("light").axis));
});

test("writeCharts: both appearances of every chart, named by content, stale files listed", () => {
  const dir = tmp();
  const doc = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/acme-api/metrics.json"), "utf8"));
  mkdirSync(join(dir, "charts"));
  writeFileSync(join(dir, "charts", "7-spend-light-0000000000.svg"), "<svg/>");
  const a = writeCharts(dir, doc);
  expect(Object.keys(a.manifest["7"])).toEqual(chartsFor(doc.ranges["7"]).map((c: Chart) => c.id));
  expect(readdirSync(join(dir, "charts"))).toHaveLength(40 + 1);
  expect(a.stale.map((f) => f.split("/").at(-1))).toEqual(["7-spend-light-0000000000.svg"]);
  // same data, same names; changed data, a new name for that chart only
  expect(writeCharts(dir, doc).manifest).toEqual(a.manifest);
  doc.ranges["7"].usd_per_day[0] += 1;
  const b = writeCharts(dir, doc);
  expect(b.manifest["7"].spend.light).not.toBe(a.manifest["7"].spend.light);
  expect(b.manifest["7"].prs).toEqual(a.manifest["7"].prs);
  expect(b.stale.map((f) => f.split("/").at(-1)).sort()).toEqual([a.manifest["7"].spend.dark, a.manifest["7"].spend.light, "7-spend-light-0000000000.svg"].sort());
});

test("writeMetrics: the charts land in charts/ beside metrics.json, which names them; old ones go", () => {
  const dir = tmp();
  const db = open(join(dir, "factory.db"));
  const path = join(dir, "metrics.json");
  mkdirSync(join(dir, "charts"));
  writeFileSync(join(dir, "charts", "7-spend-dark-old.svg"), "<svg/>");
  writeMetrics(db, path, new Date("2026-11-21T12:00:00Z"));
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const named = Object.values(doc.charts as Record<string, Record<string, Record<string, string>>>).flatMap((r) => Object.values(r).flatMap((m) => [m.light, m.dark]));
  expect(named.length).toBeGreaterThan(0);
  expect(readdirSync(join(dir, "charts")).sort()).toEqual(named.sort());
  expect(readFileSync(join(dir, "charts", doc.charts["7"].prs.dark), "utf8")).toStartWith("<svg");
});

test("linkCharts: Herdr's folder links to the factory's charts, kept current, never over a real folder", () => {
  const [home, dir, other] = [tmp(), tmp(), tmp()];
  const link = linkCharts(dir, home)!;
  expect(link).toBe(join(home, "factory-charts", dir.split("/").at(-1)!));
  expect(readlinkSync(link)).toBe(join(dir, "charts"));
  expect(linkCharts(dir, home)).toBe(link);
  expect(linkCharts(join(home, "factory-data", "acme-api"), home)).toBeNull(); // already inside Herdr's folder
  expect(linkCharts(dir, join(home, "missing"))).toBeNull(); // Herdr not installed
  const real = join(home, "factory-charts", other.split("/").at(-1)!);
  mkdirSync(real);
  expect(linkCharts(other, home)).toBeNull();
  expect(lstatSync(real).isDirectory()).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("the sample's checked-in charts are fresh (bun scripts/charts.ts redraws them)", () => {
  const fixture = join(import.meta.dir, "../fixtures/acme-api");
  const doc = JSON.parse(readFileSync(join(fixture, "metrics.json"), "utf8"));
  const { charts, ...data } = doc;
  const dir = tmp();
  const fresh = writeCharts(dir, data).manifest;
  expect(charts).toEqual(fresh);
  expect(readdirSync(join(fixture, "charts")).sort()).toEqual(readdirSync(join(dir, "charts")).sort());
});
