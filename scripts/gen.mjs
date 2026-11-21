#!/usr/bin/env node
// Writes layouts/factory.json and keys.json from lib/pages.js, so the stack,
// the keys and the menu can't drift apart. `--check` fails if either is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { PAGES, STACK } from "../lib/pages.js";

const root = new URL("..", import.meta.url);
const block = (id, mod, props, extra = {}) => ({ id, type: "block", ...extra, content: props ? { mod, props } : { mod } });

export function layout() {
  return {
    id: "root",
    type: "row",
    titlebar: "none",
    traffic_lights: [12, 16],
    background: "canvas",
    theme: { light: "paper", dark: "factory" },
    divider: { width: 1, color: "border" },
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
          block("brand", "factory-chrome", null, { size: { px: 84 }, window_drag: true }),
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
            children: PAGES.map((p) => block(p.id, p.mod ?? "factory-soon", p.mod ? null : { page: p.id })),
          },
          block("status", "factory-status", null, { size: { px: 30 } }),
        ],
      },
    ],
  };
}

export function keys() {
  const factory = { "cmd-shift-f": "layout.switch:main" };
  for (const p of PAGES) if (p.key) factory[`cmd-${p.key}`] = { command: "layout.select", args: { stack: STACK, child: p.id } };
  return { global: { "cmd-shift-f": "layout.switch:factory" }, "layout:factory": factory };
}

const files = { "layouts/factory.json": layout(), "keys.json": keys() };

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, value] of Object.entries(files)) {
    const text = JSON.stringify(value, null, 2) + "\n";
    const url = new URL(path, root);
    if (!check) writeFileSync(url, text);
    else if ((() => { try { return readFileSync(url, "utf8"); } catch { return ""; } })() !== text) {
      console.error(`${path} is stale: run scripts/gen.mjs`);
      stale++;
    }
  }
  process.exit(stale ? 1 : 0);
}
