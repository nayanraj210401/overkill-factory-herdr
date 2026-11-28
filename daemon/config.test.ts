import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as openDb, setRepo } from "./db.ts";
import { main, paths } from "./cli.ts";
import { writeStatus } from "./status.ts";
import { withSwitch } from "./account.ts";

const before = process.env.FACTORY_HOME;
afterEach(() => { process.env.FACTORY_HOME = before; });

// A fresh FACTORY_HOME with this config.yaml, and a repo with a factory.yaml.
function account(yaml: string) {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  process.env.FACTORY_HOME = home;
  writeFileSync(join(home, "config.yaml"), yaml);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(repo, ".factory"));
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\n");
  return { home, repo };
}

test("factory config set V2_UI edits config.yaml in place, flips status.json at once, and refuses a bad value", () => {
  const yaml = "# mine: keep this\nplan: { pause_at: 85% }   # the 5h meter\nV2_UI: false   # the new pages\nprofile:\n  rules: [\"small diffs\"]\n";
  const { home, repo } = account(yaml);
  for (const n of ["one", "two"]) {
    mkdirSync(join(home, n));
    const db = openDb(paths(n).db);
    setRepo(db, { slug: `acme/${n}`, path: repo, lead: true });
    writeStatus(db, paths(n).status);
    db.close();
  }
  const ui = (n: string) => JSON.parse(readFileSync(paths(n).status, "utf8")).ui;
  const out: string[] = [];
  const run = (...a: string[]) => main([...a, "--name", "one"], (s) => out.push(s));
  expect(ui("one")).toEqual({ v2: false, sidebar: false });

  run("config", "set", "V2_UI", "true");
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(yaml.replace("V2_UI: false", "V2_UI: true"));
  expect([ui("one"), ui("two")]).toEqual([{ v2: true, sidebar: false }, { v2: true, sidebar: false }]); // every factory, not only --name's
  run("config", "get", "V2_UI", "--json");
  expect(JSON.parse(out.at(-1)!)).toEqual({ key: "V2_UI", account: true, factory: null, repo: "acme/one", effective: true });

  run("config", "set", "V2_UI", "false");
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(yaml);
  expect(ui("two")).toEqual({ v2: false, sidebar: false });

  for (const bad of [["V2_UI", "yes"], ["V2_UI"], ["away", "true"]]) expect(() => run("config", "set", ...bad)).toThrow();
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(yaml);

  // The repo's factory.yaml wins, and get says so.
  writeFileSync(join(repo, ".factory/factory.yaml"), "name: t\nV2_UI: true\n");
  run("config", "get", "V2_UI", "--json");
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ account: false, factory: true, effective: true });

  // No file yet: set makes one with just the key.
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "fh-"));
  run("config", "set", "V2_UI", "true");
  expect(readFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "utf8")).toBe("V2_UI: true\n");
  expect(existsSync(paths("one").status)).toBe(false);
});

test("withSwitch sets only the top-level key: a nested one of the same name and the comments stay", () => {
  expect(withSwitch("a: 1\nx:\n  V2_UI: false\n", "V2_UI", true)).toBe("a: 1\nx:\n  V2_UI: false\nV2_UI: true\n");
  expect(withSwitch("a: 1", "V2_UI", false)).toBe("a: 1\nV2_UI: false\n");
  expect(withSwitch("V2_UI:   true#why\nb: 2\n", "V2_UI", false)).toBe("V2_UI: false#why\nb: 2\n");
});
