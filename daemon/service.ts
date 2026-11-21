// `factory service`: keep `factory run --all` alive as a macOS LaunchAgent, so the
// daemon starts at login, restarts if it dies, and runs with your gh login and keychain.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LABEL = "dev.overkill.factory";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(o: { label: string; args: string[]; env: Record<string, string>; logDir: string }) {
  const strings = (xs: string[]) => xs.map((x) => `    <string>${esc(x)}</string>`).join("\n");
  const env = Object.entries(o.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(o.args)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${esc(join(o.logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(o.logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

// How to start this same `factory`: the compiled binary, or `bun daemon/cli.ts` in a checkout.
export function selfArgs(execPath = process.execPath, main = join(import.meta.dir, "cli.ts")) {
  return /(^|\/)bun$/.test(execPath) ? [execPath, main] : [execPath];
}

type Run = (args: string[]) => { code: number; out: string };
const launchctl: Run = (args) => {
  const r = Bun.spawnSync(["launchctl", ...args]);
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

export function service(cmd: string, o: {
  factoryHome: string; label?: string; agentsDir?: string; run?: Run; uid?: number; log?: (s: string) => void; json?: boolean;
}) {
  const label = o.label ?? LABEL;
  const run = o.run ?? launchctl;
  const log = o.log ?? console.log;
  const domain = `gui/${o.uid ?? process.getuid!()}`;
  const file = join(o.agentsDir ?? join(homedir(), "Library", "LaunchAgents"), `${label}.plist`);
  if (cmd === "install") {
    const logDir = join(o.factoryHome, "logs");
    mkdirSync(logDir, { recursive: true });
    // launchd starts jobs with a bare PATH: keep the one that finds gh, hc, git and claude now.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), FACTORY_HOME: o.factoryHome };
    writeFileSync(file, plist({ label, args: [...selfArgs(), "run", "--all"], env, logDir }));
    run(["bootout", `${domain}/${label}`]); // a no-op the first time
    const r = run(["bootstrap", domain, file]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
    log(`installed ${label}: starts at login, logs in ${logDir}`);
  } else if (cmd === "uninstall") {
    run(["bootout", `${domain}/${label}`]);
    if (existsSync(file)) rmSync(file);
    log(`removed ${label}`);
  } else if (cmd === "restart") {
    const r = run(["kickstart", "-k", `${domain}/${label}`]);
    if (r.code !== 0) throw new Error(`not running under launchd; run factory service install (${r.out.trim()})`);
    log(`restarted ${label}`);
  } else if (cmd === "status") {
    // The window reads --json: {installed, state, pid, logs}.
    const r = run(["print", `${domain}/${label}`]);
    const state = r.code !== 0 ? "absent" : r.out.match(/^\s*state = (\S+)/m)?.[1] ?? "unknown";
    const pid = Number(r.out.match(/^\s*pid = (\d+)/m)?.[1]) || null;
    const logs = join(o.factoryHome, "logs");
    if (o.json) log(JSON.stringify({ installed: state !== "absent", state, pid, logs }));
    else log(state === "absent" ? `${label}: not installed` : `${label}: ${state}${pid ? ` (pid ${pid})` : ""}`);
    return state;
  } else throw new Error("usage: factory service install|uninstall|restart|status [--json]");
}
