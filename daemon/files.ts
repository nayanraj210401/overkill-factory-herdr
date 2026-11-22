import { readFileSync, renameSync, writeFileSync } from "node:fs";

// The daemon rewrites the window's files every tick. Writing one whose content hasn't
// changed (only its generated_at) wakes every page for nothing, so skip it. The write
// itself is atomic: the window's watcher never sees a half-written file.
const STAMP = /"generated_at":\s*"[^"]*"/;

export function writeIfChanged(path: string, text: string): boolean {
  let old: string | null = null;
  try { old = readFileSync(path, "utf8"); } catch {}
  if (old !== null && old.replace(STAMP, "") === text.replace(STAMP, "")) return false;
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
  return true;
}
