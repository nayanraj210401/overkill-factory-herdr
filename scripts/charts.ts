#!/usr/bin/env bun
// Draws the sample data's charts (fixtures/acme-api/charts/) the way the daemon draws a real
// factory's, and points the sample metrics.json at them, so the Metrics page shows charts with
// no daemon. Run after changing the sample metrics or daemon/charts.ts:
//   bun scripts/charts.ts
// daemon/charts.test.ts fails while the checked-in files are stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeStale, writeCharts } from "../daemon/charts.ts";

const dir = join(import.meta.dir, "../fixtures/acme-api");
const path = join(dir, "metrics.json");
const doc = JSON.parse(readFileSync(path, "utf8"));
const { manifest, stale } = writeCharts(dir, doc);
doc.charts = manifest;
writeFileSync(path, JSON.stringify(doc, null, 1) + "\n");
removeStale(stale);
console.log(`${Object.values(manifest).reduce((n, r) => n + Object.keys(r).length * 2, 0)} charts in ${join(dir, "charts")}`);
