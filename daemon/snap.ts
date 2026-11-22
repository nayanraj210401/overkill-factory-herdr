// The briefs' snapshots (briefs.snap.json): a brief is compared whole, so any change to its
// text shows up in review. After a deliberate change, regenerate them and read the diff:
//   UPDATE_SNAPSHOTS=1 bun test daemon/prompts.test.ts daemon/handoff.test.ts
import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(import.meta.dir, "briefs.snap.json");
const read = () => JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;

export function matchBrief(key: string, text: string) {
  if (!process.env.UPDATE_SNAPSHOTS) return expect(text).toBe(read()[key]);
  writeFileSync(FILE, JSON.stringify({ ...read(), [key]: text }, null, 2) + "\n");
}
