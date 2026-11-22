// Which claude every factory session runs: overwatch, triage, stage agents, handoffs and the
// daemon's own `claude -p` calls all get the same binary. A machine can hold several (the
// native install in ~/.local/bin, a Homebrew cask, an npm global under nvm), and the first on
// a PATH may be a stale one that can't use the factory's models. So: the account config's
// `claude.path` when you set one, else the newest version found.
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAccount } from "./account.ts";

export type Found = { path: string; version: string | null };
export type Choice = { path: string; version: string | null; why: "configured" | "newest" | "none"; found: Found[] };

const runnable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

// Folders a claude is usually installed in, besides the PATH's own.
function usual(home: string) {
  const nvm = join(home, ".nvm/versions/node");
  const nodes = existsSync(nvm) ? readdirSync(nvm).map((v) => join(nvm, v, "bin")) : [];
  return [join(home, ".local/bin"), join(home, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin", ...nodes];
}

export const versionOf = (p: string) => {
  const r = Bun.spawnSync([p, "--version"], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().match(/\d+\.\d+\.\d+/)?.[0] ?? null;
};

// Every distinct claude (by its real file), in the order found.
export function findClaudes(path = process.env.PATH ?? "", home = homedir(), version = versionOf): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const dir of [...path.split(":").filter(Boolean), ...usual(home)]) {
    const p = join(dir, "claude");
    if (!existsSync(p) || !runnable(p)) continue;
    let real = p;
    try { real = realpathSync(p); } catch {}
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ path: p, version: version(p) });
  }
  return out;
}

const parts = (v: string | null) => (v ?? "0.0.0").split(".").map(Number);
export const newer = (a: string | null, b: string | null) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// Pure: what runs, given what's installed and what you set.
export function chooseClaude(found: Found[], configured?: string | null): Choice {
  if (configured) {
    if (!existsSync(configured) || !runnable(configured)) throw new Error(`claude.path in config.yaml is ${configured}, which isn't a program here; run \`factory claude\` to see the ones found`);
    return { path: configured, version: found.find((f) => f.path === configured)?.version ?? versionOf(configured), why: "configured", found };
  }
  const best = found.reduce<Found | null>((b, f) => (!b || newer(f.version, b.version) ? f : b), null);
  return best ? { ...best, why: "newest", found } : { path: "claude", version: null, why: "none", found };
}

// Cached for a few minutes: a tick starts many sessions, and an update or a config change
// is picked up soon after.
let cache: { at: number; choice: Choice } | null = null;
export function claudeChoice(now = Date.now()): Choice {
  if (cache && now - cache.at < 5 * 60_000) return cache.choice;
  const choice = chooseClaude(findClaudes(), readAccount().claude?.path ?? null);
  cache = { at: now, choice };
  return choice;
}
export const forgetClaude = () => { cache = null; };

// The program to start for argv[0] "claude"; tests never look one up.
export const claudeBin = () => (process.env.FACTORY_TEST_SANDBOX ? "claude" : claudeChoice().path);
export const resolveClaude = (argv: string[]) => (argv[0] === "claude" ? [claudeBin(), ...argv.slice(1)] : argv);
