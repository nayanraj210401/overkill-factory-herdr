#!/usr/bin/env node
// Writes layouts/factory.json and keys.json from lib/pages.js, so the stack,
// the keys and the menu can't drift apart, and the sample repo's agents and steps
// (fixtures/acme-api/.factory/{agents,steps}/) from the example library (examples/),
// so the two never drift either. `--check` fails if any is stale.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { PAGES, STACK } from "../lib/pages.js";

const root = new URL("..", import.meta.url);
const block = (id, mod, props, extra = {}) => ({ id, type: "block", ...extra, content: props ? { mod, props } : { mod } });

// A page that is a live agent terminal: its mod is a strip that starts the agent and focuses it.
const agentPage = (p) => ({
  id: p.id,
  type: "column",
  resizable: false,
  children: [
    block(`${p.id}-bar`, p.mod, null, { size: { px: 56 } }),
    { id: `${p.id}-terminal`, type: "block", size: { weight: 1 }, content: { agent: "focused" } },
  ],
});

export function layout() {
  return {
    id: "root",
    type: "row",
    titlebar: "none",
    traffic_lights: [12, 16],
    background: "canvas",
    theme: { light: "paper", dark: "factory" },
    divider: { width: 1, color: "border" },
    preview: "layouts/factory.svg",
    children: [
      {
        id: "sidebar",
        type: "column",
        size: { px: 268 },
        min: 44,
        max: 480,
        background: "chrome",
        resizable: false,
        children: [
          block("brand", "factory-chrome", null, { size: { px: 134 }, window_drag: true }), // room for the "⚠ <factory>: N needs you" line
          block("sidebar-tickets", "factory-tickets", null, { size: { weight: 1 }, min: 90 }),
          block("sidebar-menu", "factory-menu", null, { size: { px: 40 + 30 * PAGES.filter((p) => p.key).length } }),
          block("sidebar-budget", "factory-chrome", { footer: true }, { size: { px: 44 } }),
        ],
      },
      {
        id: "work",
        type: "column",
        resizable: false,
        children: [
          block("header", "factory-header", null, { size: { px: 42 }, window_drag: true }),
          {
            id: STACK,
            type: "stack",
            active: PAGES[0].id,
            padding: 8,
            children: PAGES.map((p) => p.agent ? agentPage(p) : block(p.id, p.mod ?? "factory-soon", p.mod ? null : { page: p.id })),
          },
          block("status", "factory-status", null, { size: { px: 30 } }),
        ],
      },
    ],
  };
}

export const FACTORY_KEYS = { "g f": "mod.open:factory-picker", "]": "factory-chrome.needs-next", "[": "factory-chrome.needs-prev" };

export function keys() {
  // ⌘O opens the file the shown config page has selected. It goes to the header, which every page
  // shows: a <mod>.<command> reaches shown copies only, and there are two config pages.
  const factory = { "cmd-shift-f": "layout.switch:main", "cmd-o": "factory-header.open" };
  for (const n of ["1", "2", "3", "4", "5", "6"]) factory[`cmd-alt-${n}`] = `factory-ticket.tab-${n}`;
  for (const p of PAGES) if (p.key) factory[`cmd-${p.key}`] = { command: "layout.select", args: { stack: STACK, child: p.id } };
  // The factory picker, and the next / previous other factory that needs you (factory-chrome).
  Object.assign(factory, FACTORY_KEYS);
  // Bare keys bound for the layout would be taken from the terminals in it (Overwatch, a
  // ticket's agent): the terminal section wins, so these go to the program there.
  const terminal = Object.fromEntries(["g", "[", "]"].map((k) => [k, "terminal"]));
  return { global: { "cmd-shift-f": "layout.switch:factory" }, terminal, "layout:factory": factory };
}

const files = { "layouts/factory.json": layout(), "keys.json": keys() };

// The sample repo's agents and steps are the example library's, byte for byte.
const LIBRARIES = [["agents", /\.md$/], ["steps", /\.ya?ml$/]].map(([kind, ext]) => ({
  kind, from: new URL(`examples/${kind}/`, root), to: new URL(`fixtures/acme-api/.factory/${kind}/`, root),
  list: (url) => { try { return readdirSync(url).filter((f) => ext.test(f)).sort(); } catch { return []; } },
}));
const copies = Object.fromEntries(LIBRARIES.flatMap((l) => l.list(l.from).map((f) => [`fixtures/acme-api/.factory/${l.kind}/${f}`, readFileSync(new URL(f, l.from), "utf8")])));
const extra = LIBRARIES.flatMap((l) => l.list(l.to).filter((f) => !(`fixtures/acme-api/.factory/${l.kind}/${f}` in copies)).map((f) => ({ l, f })));

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  const texts = { ...Object.fromEntries(Object.entries(files).map(([p, v]) => [p, JSON.stringify(v, null, 2) + "\n"])), ...copies };
  if (!check) for (const l of LIBRARIES) mkdirSync(l.to, { recursive: true });
  for (const { l, f } of extra) {
    if (!check) rmSync(new URL(f, l.to));
    else { console.error(`fixtures/acme-api/.factory/${l.kind}/${f} isn't in examples/${l.kind}/: run scripts/gen.mjs`); stale++; }
  }
  for (const [path, text] of Object.entries(texts)) {
    const url = new URL(path, root);
    if (!check) writeFileSync(url, text);
    else if ((() => { try { return readFileSync(url, "utf8"); } catch { return ""; } })() !== text) {
      console.error(`${path} is stale: run scripts/gen.mjs`);
      stale++;
    }
  }
  process.exit(stale ? 1 : 0);
}
