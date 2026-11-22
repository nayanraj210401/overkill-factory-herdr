import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { factoriesOf, liveOverwatch, overwatch, stateFile } from "./overwatch.ts";
import type { Run } from "./runner.ts";

// Two factories under one FACTORY_HOME, each with its repos.
function twoFactories() {
  const home = mkdtempSync(join(tmpdir(), "ow-home-"));
  const repo = (n: string) => mkdtempSync(join(tmpdir(), `ow-${n}-`));
  const make = (name: string, repos: { slug: string; path: string; lead: boolean }[]) => {
    const db = open(join(home, name, "factory.db"));
    for (const r of repos) setRepo(db, r);
    db.close();
  };
  const api = repo("api"), web = repo("web"), shop = repo("shop");
  make("acme-api", [{ slug: "acme/api", path: api, lead: true }, { slug: "acme/web", path: web, lead: false }]);
  make("shop", [{ slug: "acme/shop", path: shop, lead: true }]);
  return { home, api, web, shop };
}

function hc() {
  const calls: string[][] = [];
  let exited = false, n = 0;
  const run: Run = (argv) => {
    calls.push(argv);
    if (argv[1] === "get") return { code: 0, out: JSON.stringify({ exit_code: exited ? 0 : null }) };
    return { code: 0, out: JSON.stringify({ address: `t${++n}` }) };
  };
  return { calls, run, exit: () => { exited = true; }, revive: () => { exited = false; } };
}

const now = "2026-11-23T10:00:00Z";

test("one Overwatch for every factory: in FACTORY_HOME, every repo added, every factory in its brief", () => {
  const { home, api, web, shop } = twoFactories();
  const h = hc();
  expect(factoriesOf(home).map((f) => [f.name, f.repos.map((r) => r.slug)])).toEqual([["acme-api", ["acme/api", "acme/web"]], ["shop", ["acme/shop"]]]);
  expect(overwatch({ run: h.run, now, home })).toEqual({ terminal: "t1", started: true });
  const argv = h.calls.find((c) => c[1] === "run")!;
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(home);
  const added = argv.flatMap((a, i) => (argv[i - 1] === "--add-dir" ? [a] : []));
  expect(added).toEqual([api, web, shop]);
  expect(argv).toContain(`FACTORY_HOME=${home}`);
  expect(argv).toContain("FACTORY_AGENT=overwatch");
  expect(argv.some((a) => a.startsWith("FACTORY_NAME="))).toBe(false); // it names the factory per command
  const brief = argv.at(-1)!;
  expect(brief.startsWith("## The factory's agents")).toBe(true);
  expect(brief).toContain(`- acme-api: acme/api (${api}, lead), acme/web (${web}); data ${join(home, "acme-api")}`);
  expect(brief).toContain(`- shop: acme/shop (${shop}, lead); data ${join(home, "shop")}`);
  expect(JSON.parse(readFileSync(stateFile(home), "utf8"))).toEqual({ terminal: "t1", started_at: now });
  // Asked again, from any factory: the same live one.
  expect(overwatch({ run: h.run, now, home })).toEqual({ terminal: "t1", started: false });
  expect(liveOverwatch(h.run, home)).toBe("t1");
  // It exited: the next ask starts a new one, and every factory sees that one.
  h.exit();
  expect(liveOverwatch(h.run, home)).toBeNull();
  h.revive();
  const calls = h.calls.length;
  h.exit();
  const again = overwatch({ run: (a) => (a[1] === "get" ? { code: 0, out: '{"exit_code":0}' } : h.run(a)), now, home });
  expect(again).toEqual({ terminal: "t2", started: true });
  expect(h.calls.length).toBeGreaterThan(calls);
});

test("in tests, the real hc never starts a terminal", () => {
  const { sh } = require("./runner.ts") as typeof import("./runner.ts");
  expect(sh(["hc", "run", "--bg", "--", "true"])).toEqual({ code: 1, out: "hc run is stubbed in tests" });
});
