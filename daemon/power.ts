// Sleep and wake notices from macOS, through a small helper (daemon/factory-power.c) that
// registers with IOKit (IORegisterForSystemPower). IOKit is the one mechanism that tells a
// process *before* sleep and lets it hold the sleep until it acks, which is what a
// pre-sleep push needs. NSWorkspace's notifications need an app run loop; `pmset -g log`
// only reports after the fact; polling the clock misses the window entirely.
//
// The helper prints "sleep" / "wake" lines. On "sleep" the daemon does its work, then writes
// "done" so the system can sleep at once; the helper releases it by itself after 25 s.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error bun's text import
import SOURCE from "./factory-power.c" with { type: "text" };

export const helperPath = (factoryHome: string) => join(factoryHome, "bin", "factory-power");

// Compile the helper with clang (Xcode's command line tools). Returns an error text, or null when built.
export function buildHelper(factoryHome: string, run: (a: string[]) => { code: number; out: string } = (a) => {
  const r = Bun.spawnSync(a); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}): string | null {
  const dir = join(tmpdir(), `factory-power-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(factoryHome, "bin"), { recursive: true });
  const src = join(dir, "factory-power.c");
  writeFileSync(src, SOURCE as string);
  try {
    const r = run(["clang", "-O2", "-framework", "IOKit", "-framework", "CoreFoundation", "-o", helperPath(factoryHome), src]);
    return r.code === 0 ? null : r.out.trim().split("\n").slice(0, 3).join(" ") || `clang exited ${r.code}`;
  } catch (e) { return (e as Error).message; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export type Handlers = { sleep: () => void; wake: () => void };
// One line from the helper. Returns what to write back (the ack), if any.
export function handleLine(line: string, h: Handlers, log: (s: string) => void = () => {}): string | null {
  const word = line.trim();
  if (word === "sleep") {
    try { h.sleep(); } catch (e) { log(`factory: sleep handler: ${(e as Error).message}`); }
    return "done\n"; // always release the sleep, whatever the handler did
  }
  if (word === "wake") { try { h.wake(); } catch (e) { log(`factory: wake handler: ${(e as Error).message}`); } }
  return null;
}

// Keeps the helper running while `wanted()` says some factory needs it; restarts it if it exits.
export function powerWatcher(o: { factoryHome: string; handlers: Handlers; wanted: () => boolean; log: (s: string) => void;
  spawn?: (bin: string) => { stdout: ReadableStream<Uint8Array>; write: (s: string) => void; kill: () => void; exited: Promise<unknown> } }) {
  let proc: ReturnType<NonNullable<typeof o.spawn>> | null = null;
  let warned = false;
  const spawn = o.spawn ?? ((bin) => {
    const p = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    return { stdout: p.stdout, write: (s) => { p.stdin.write(s); p.stdin.flush(); }, kill: () => p.kill(), exited: p.exited };
  });
  return () => {
    if (proc || !o.wanted()) return;
    const bin = helperPath(o.factoryHome);
    if (!existsSync(bin)) {
      if (!warned) o.log(`factory: cloud.on_sleep is move, but ${bin} isn't built; run factory service install (needs clang from the Xcode command line tools)`);
      warned = true;
      return;
    }
    const p = proc = spawn(bin);
    o.log("factory: listening for sleep and wake");
    void (async () => {
      let buf = "";
      const dec = new TextDecoder();
      try {
        for await (const chunk of p.stdout) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const reply = handleLine(buf.slice(0, i), o.handlers, o.log);
            buf = buf.slice(i + 1);
            if (reply) p.write(reply);
          }
        }
      } catch {}
      proc = null; // restarted on the next tick
    })();
  };
}
