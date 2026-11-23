// The statusLine command factory agents run with. Claude Code passes it the account's
// plan usage (rate_limits.five_hour / seven_day: used_percentage, resets_at); this
// saves that reading to <FACTORY_HOME>/plan.json, where the plan meters read it. It's
// your whole account's usage, not just the factory's.
//   bun planline.ts <plan.json>     (the status line's JSON arrives on stdin)
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One file for the whole account, beside every factory's folder.
export const planFile = () => join(process.env.FACTORY_HOME ?? join(homedir(), ".factory"), "plan.json");

export type Window = { used: number; resets_at: string | null };
export type Reading = { at: string; five_hour: Window | null; seven_day: Window | null };

const windowOf = (w: any): Window | null =>
  w && typeof w.used_percentage === "number"
    ? { used: w.used_percentage / 100, resets_at: typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : typeof w.resets_at === "string" ? w.resets_at : null }
    : null;

export function readingOf(input: any, now = new Date()): Reading | null {
  const five = windowOf(input?.rate_limits?.five_hour);
  const week = windowOf(input?.rate_limits?.seven_day);
  return five || week ? { at: now.toISOString(), five_hour: five, seven_day: week } : null;
}

// A window's share used now: 0 once it has reset; null when there's no reading for it.
export function usedNow(w: Window | null | undefined, now: Date): number | null {
  if (!w) return null;
  if (w.resets_at && Date.parse(w.resets_at) <= now.getTime()) return 0;
  return +w.used.toFixed(3);
}

export function readPlan(file: string): Reading | null {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

if (import.meta.main) {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const r = readingOf(input);
  if (r && process.argv[2]) {
    writeFileSync(`${process.argv[2]}.tmp`, JSON.stringify(r) + "\n");
    renameSync(`${process.argv[2]}.tmp`, process.argv[2]);
  }
  const ctx = input?.context_window?.used_percentage;
  console.log(`factory${typeof ctx === "number" ? ` · ctx ${Math.round(ctx)}%` : ""}${r?.five_hour ? ` · 5h ${Math.round(r.five_hour.used * 100)}%` : ""}`);
}
