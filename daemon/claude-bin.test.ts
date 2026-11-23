import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseClaude, findClaudes, newer, resolveClaude } from "./claude-bin.ts";

function fakeClaude(dir: string) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

test("every claude on the PATH and in the usual folders is found once, by its real file", () => {
  const root = mkdtempSync(join(tmpdir(), "claudes-"));
  const brew = fakeClaude(join(root, "brew"));
  const local = fakeClaude(join(root, "home/.local/bin"));
  mkdirSync(join(root, "alias"));
  symlinkSync(local, join(root, "alias/claude")); // the same program twice
  const versions: Record<string, string> = { [brew]: "2.1.85", [local]: "2.1.330", [join(root, "alias/claude")]: "2.1.330" };
  const found = findClaudes(`${join(root, "brew")}:${join(root, "alias")}`, join(root, "home"), (p) => versions[p]);
  // (the machine's own /opt/homebrew/bin and /usr/local/bin are searched too; only ours matter here)
  expect(found.filter((f) => f.path.startsWith(root))).toEqual([{ path: brew, version: "2.1.85" }, { path: join(root, "alias/claude"), version: "2.1.330" }]);
});

test("the newest claude runs unless config.yaml names one; a stale Homebrew copy never wins by PATH order", () => {
  const root = mkdtempSync(join(tmpdir(), "claudes-"));
  const mine = fakeClaude(join(root, "mine"));
  const found = [{ path: "/opt/homebrew/bin/claude", version: "2.1.85" }, { path: mine, version: "2.1.241" }, { path: "/x/claude", version: "2.1.330" }];
  expect(chooseClaude(found)).toMatchObject({ path: "/x/claude", why: "newest" });
  expect(chooseClaude(found, mine)).toMatchObject({ path: mine, version: "2.1.241", why: "configured" });
  expect(() => chooseClaude(found, join(root, "gone"))).toThrow("factory claude");
  expect(chooseClaude([])).toMatchObject({ path: "claude", why: "none" });
  expect(newer("2.1.330", "2.1.85")).toBe(true);
  expect(newer("2.1.85", "2.1.330")).toBe(false);
});

test("only a claude command is swapped; tests keep the bare name", () => {
  expect(resolveClaude(["claude", "-p", "hi"])).toEqual(["claude", "-p", "hi"]);
  expect(resolveClaude(["gh", "pr", "list"])).toEqual(["gh", "pr", "list"]);
});
