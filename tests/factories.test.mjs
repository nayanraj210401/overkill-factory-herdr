import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { factoryCounts, pickerRows, countsText, needsLine, stepNeeding, switchTarget, brandSub, factoryDot } from "../lib/factories.js";
import { needsYou, overwatchNotes } from "../lib/model.js";
import { keys } from "../scripts/gen.mjs";

const status = JSON.parse(readFileSync(new URL("../fixtures/acme-api/status.json", import.meta.url)));
const home = "/Users/me";
const FACTORIES = [
  { name: "acme-api", dir: `${home}/.factory/acme-api`, repos: [{ slug: "acme/web", path: `${home}/src/web`, lead: false }, { slug: "acme/api", path: `${home}/src/api`, lead: true }] },
  { name: "shop", dir: `${home}/.factory/shop`, repos: [{ slug: "me/shop", path: `${home}/src/shop`, lead: true }] },
  { name: "blog", dir: `${home}/.factory/blog`, repos: [{ slug: "me/blog", path: `${home}/src/blog`, lead: true }] },
];
const c = (needs, running = 0, review = 0) => ({ running, needs, review });

test("a factory's counts are Home's Needs you, its running tickets and its to-review number", () => {
  const n = factoryCounts(status);
  assert.equal(n.needs, needsYou(status.tickets).length + overwatchNotes(status.asks).length);
  assert.equal(n.running, status.tickets.filter((t) => t.state === "running").length);
  assert.equal(n.review, status.to_review);
  assert.ok(n.needs > 0 && n.running > 0);
  assert.equal(factoryCounts(null), null);
  assert.equal(factoryCounts({}), null);
});

test("picker rows list repos lead first, mark the shown factory and carry a status dot", () => {
  const rows = pickerRows(FACTORIES, { "acme-api": c(0, 2), shop: c(1) }, "acme-api");
  assert.deepEqual(rows.map((r) => [r.name, r.current, r.dot]), [["acme-api", true, "working"], ["shop", false, "blocked"], ["blog", false, "unknown"]]);
  assert.deepEqual(rows[0].repos, ["acme/api", "acme/web"]);
  assert.equal(rows[0].lead.slug, "acme/api");
  assert.equal(factoryDot(c(0)), "idle");
  assert.equal(countsText(c(1, 2, 3)), "2 running · 1 needs you · 3 to review");
  assert.equal(countsText(c(0)), "nothing waiting");
  assert.equal(countsText(null), "no status yet");
});

test("the brand's line names the other factory that needs you most, +N for the rest", () => {
  assert.equal(needsLine(pickerRows(FACTORIES, { "acme-api": c(5), shop: c(1) }), "acme-api").text, "⚠ shop: 1 needs you");
  const two = needsLine(pickerRows(FACTORIES, { shop: c(1), blog: c(3) }), "acme-api");
  assert.deepEqual(two, { name: "blog", text: "⚠ blog: 3 needs you +1" });
  // The shown factory never warns about itself.
  assert.equal(needsLine(pickerRows(FACTORIES, { "acme-api": c(4) }), "acme-api"), null);
});

test("] and [ walk the other factories that need you, wrapping", () => {
  const rows = pickerRows(FACTORIES, { "acme-api": c(1), shop: c(1), blog: c(2) });
  assert.equal(stepNeeding(rows, "acme-api", 1).name, "shop");
  assert.equal(stepNeeding(rows, "acme-api", -1).name, "blog");
  assert.equal(stepNeeding(rows, "blog", 1).name, "acme-api");
  assert.equal(stepNeeding(rows, "shop", -1).name, "acme-api");
  assert.equal(stepNeeding(rows, null, 1).name, "acme-api");
  assert.equal(stepNeeding(pickerRows(FACTORIES, { shop: c(0) }), "acme-api", 1), null);
  assert.equal(stepNeeding(pickerRows(FACTORIES, { "acme-api": c(3) }), "acme-api", 1), null);
});

test("picking a factory focuses its lead repo's space, else any of its spaces, else makes one", () => {
  const sp = (id, folder, machine = null) => ({ id, folder, machine });
  const [acme] = FACTORIES;
  const go = (spaces) => switchTarget(acme, spaces, home, FACTORIES);
  assert.deepEqual(go([sp("s1", `${home}/src/web`), sp("s2", `${home}/src/api/lib`)]), { command: "space.select", args: { id: "s2" } });
  assert.deepEqual(go([sp("s1", `${home}/src/web`), sp("s3", `${home}/src/shop`)]), { command: "space.select", args: { id: "s1" } });
  assert.deepEqual(go([sp("s4", `${home}/src/api`, "vps")]), { command: "space.new", args: { folder: `${home}/src/api`, machine: "" } });
  assert.equal(switchTarget({ name: "x", repos: [] }, [], home, FACTORIES), null);
});

test("the brand's second line: lead repo, branch, and the repo count when there are several", () => {
  assert.equal(brandSub(status, "main"), "acme/api · main · 2 repos");
  assert.equal(brandSub({ factory: { name: "a", repo: "me/a" } }, null), "me/a");
});

test("the factory picker and needs-you keys are chords; no bare key is bound, so text boxes get every letter", () => {
  const k = keys();
  assert.equal(k["layout:factory"]["cmd-k"], "mod.open:factory-picker");
  assert.equal(k["layout:factory"]["cmd-j"], "factory-chrome.needs-next");
  assert.equal(k["layout:factory"]["cmd-shift-j"], "factory-chrome.needs-prev");
  for (const [section, bindings] of Object.entries(k))
    for (const key of Object.keys(bindings)) assert.match(key, /^(cmd|ctrl|alt|shift)-/, `${section}: "${key}" is a bare key`);
});
