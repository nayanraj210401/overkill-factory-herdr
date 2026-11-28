import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Runs the Metrics page's real render() with the All factories toggle on, over two copies of
// the sample, on every tab (tests/fake-gpui.mjs stands in for Herdr).
const FAKE = pathToFileURL("tests/fake-gpui.mjs").href;
const LIB = pathToFileURL("lib/").href;
const EMPTY = `data:text/javascript,${encodeURIComponent("export default null;")}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "gpui-kit" || spec === "gpui-base" || spec === "herdr") return { url: FAKE, shortCircuit: true };
    if (spec === "./sample.js" || spec === "./sample-reviews.js") return { url: EMPTY, shortCircuit: true };
    if (spec.startsWith("./lib/") && ctx.parentURL?.includes("/mods/")) return next(new URL(spec.slice(6), LIB).href, ctx);
    return next(spec, ctx);
  },
});

const { cx } = await import(FAKE);
const { default: FactoryMetrics } = await import("../mods/factory-metrics/main.js");
const { combineMetrics } = await import("../lib/combine.js");

const doc = JSON.parse(readFileSync("fixtures/acme-api/metrics.json", "utf8"));
const bench = JSON.parse(readFileSync("fixtures/acme-api/benchmarks.json", "utf8"));
const words = (el) => (typeof el === "object" ? (el.node ?? el).kids.map(words).join(" ") : String(el));

test("every tab renders combined, labelled per factory where it can't combine", () => {
  const view = new FactoryMetrics();
  view.init({}, cx);
  const factories = [{ name: "acme", dir: "/h/acme", doc, error: null, bench, benchError: null }, { name: "shop", dir: "/h/shop", doc, error: null, bench: null, benchError: null },
    { name: "new", dir: "/h/new", doc: null, error: "no metrics.json yet", bench: null, benchError: null }];
  view.all = { factories, doc: combineMetrics(factories.filter((f) => f.doc)), error: null };
  const seen = {};
  for (const tab of ["Throughput", "Cost", "Quality", "Learning", "Benchmarks"]) { view.tab = tab; seen[tab] = words(view.render()); }
  assert.match(seen.Throughput, /All factories \(3\)/);
  assert.match(seen.Throughput, /per factory/);
  assert.match(seen.Throughput, /Left out: new: no metrics.json yet/);
  assert.match(seen.Throughput, /acme · 10 merged/);
  assert.match(seen.Cost, /Summed over every factory/);
  assert.match(seen.Learning, /acme.*shop/s);
  assert.match(seen.Benchmarks, /Babysitter agreement · acme/);
  assert.match(seen.Benchmarks, /shop · Benchmarks/);
});
