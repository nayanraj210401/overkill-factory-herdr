// `factory service`: keep `factory run --all` alive as a macOS LaunchAgent, so the
// daemon starts at login, restarts if it dies, and runs with your gh login and keychain.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildHelper } from "./power.ts";

export const LABEL = "dev.overkill.factory";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(o: { label: string; args: string[]; env: Record<string, string>; logDir: string; atLogin?: boolean; bundleId?: string }) {
  const strings = (xs: string[]) => xs.map((x) => `    <string>${esc(x)}</string>`).join("\n");
  const env = Object.entries(o.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join("\n");
  // Off at login: launchd loads the job but leaves it stopped until `service start`, and
  // restarts it only after a crash (KeepAlive true would start it at once).
  const atLogin = o.atLogin ?? true;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(o.args)}
  </array>${o.bundleId ? `
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${esc(o.bundleId)}</string>
  </array>` : ""}
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  ${atLogin ? "<true/>" : "<false/>"}
  <key>KeepAlive</key>
  ${atLogin ? "<true/>" : "<dict>\n    <key>Crashed</key>\n    <true/>\n  </dict>"}
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

// The name macOS shows in Login Items. It names a signed program by its signer, so a bare
// `bun` reads as Bun's author; a small app bundle (Info.plist plus a launcher script) named
// for the factory, tied to the job by AssociatedBundleIdentifiers, reads as itself.
export const APP_NAME = "Overkill Factory";
export function writeApp(dir: string, label: string, args: string[]) {
  const app = join(dir, `${APP_NAME}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${esc(APP_NAME)}</string>
  <key>CFBundleDisplayName</key>
  <string>${esc(APP_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${esc(label)}</string>
  <key>CFBundleExecutable</key>
  <string>factory-daemon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`);
  const sq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  const exe = join(app, "Contents", "MacOS", "factory-daemon");
  writeFileSync(exe, `#!/bin/sh\n# Starts the factory daemon; see daemon/service.ts.\nexec ${args.map(sq).join(" ")} "$@"\n`, { mode: 0o755 });
  return { app, exe };
}

// Whether the installed plist starts the daemon at login; null when there is none.
export const atLoginOf = (file: string) =>
  existsSync(file) ? !/<key>RunAtLoad<\/key>\s*<false\/>/.test(readFileSync(file, "utf8")) : null;

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
  factoryHome: string; label?: string; agentsDir?: string; run?: Run; uid?: number; log?: (s: string) => void; json?: boolean; arg?: string;
  sign?: (app: string) => void; login?: string; helper?: (factoryHome: string) => string | null;
}) {
  const label = o.label ?? LABEL;
  const run = o.run ?? launchctl;
  const log = o.log ?? console.log;
  const domain = `gui/${o.uid ?? process.getuid!()}`;
  const file = join(o.agentsDir ?? join(homedir(), "Library", "LaunchAgents"), `${label}.plist`);
  // Write the plist (and the app bundle it runs), load it, and leave the daemon running now.
  const install = (atLogin: boolean) => {
    const logDir = join(o.factoryHome, "logs");
    mkdirSync(logDir, { recursive: true });
    // launchd starts jobs with a bare PATH: keep the one that finds gh, hc, git and claude now.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), FACTORY_HOME: o.factoryHome };
    const { app, exe } = writeApp(o.factoryHome, label, selfArgs());
    (o.sign ?? adhocSign)(app);
    // The sleep/wake helper for cloud.on_sleep; a failed build leaves the rest of the install alone.
    const why = (o.helper ?? ((h) => buildHelper(h)))(o.factoryHome);
    if (why) log(`sleep helper not built (cloud.on_sleep won't work until it is): ${why}`);
    writeFileSync(file, plist({ label, args: [exe, "run", "--all"], env, logDir, atLogin, bundleId: label }));
    run(["bootout", `${domain}/${label}`]); // a no-op the first time
    const r = run(["bootstrap", domain, file]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
    if (!atLogin) run(["kickstart", `${domain}/${label}`]); // not started by loading: start it now
  };
  if (cmd === "install") {
    // --login on|off (the window's "Start at login" box) decides; without it a reinstall keeps the choice.
    if (o.login !== undefined && o.login !== "on" && o.login !== "off") throw new Error("usage: factory service install [--login on|off]");
    install(o.login ? o.login === "on" : atLoginOf(file) ?? true);
    log(`installed ${label} as "${APP_NAME}": ${atLoginOf(file) ? "starts at login" : "runs now, not at login"}, logs in ${join(o.factoryHome, "logs")}`);
  } else if (cmd === "login") {
    if (o.arg !== "on" && o.arg !== "off") throw new Error("usage: factory service login on|off");
    if (atLoginOf(file) == null) throw new Error("not installed; run factory service install");
    install(o.arg === "on");
    log(o.arg === "on" ? `${label}: starts at login` : `${label}: runs now, but not at login (factory service start)`);
  } else if (cmd === "uninstall") {
    run(["bootout", `${domain}/${label}`]);
    if (existsSync(file)) rmSync(file);
    rmSync(join(o.factoryHome, `${APP_NAME}.app`), { recursive: true, force: true });
    log(`removed ${label}`);
  } else if (cmd === "start" || cmd === "restart") {
    const r = run(["kickstart", ...(cmd === "restart" ? ["-k"] : []), `${domain}/${label}`]);
    if (r.code !== 0) throw new Error(`not running under launchd; run factory service install (${r.out.trim()})`);
    log(`${cmd === "start" ? "started" : "restarted"} ${label}`);
  } else if (cmd === "status") {
    // The window reads --json: {installed, state, pid, logs, at_login}.
    const r = run(["print", `${domain}/${label}`]);
    const state = r.code !== 0 ? "absent" : r.out.match(/^\s*state = (\S+)/m)?.[1] ?? "unknown";
    const pid = Number(r.out.match(/^\s*pid = (\d+)/m)?.[1]) || null;
    const logs = join(o.factoryHome, "logs");
    const at_login = atLoginOf(file) ?? false;
    if (o.json) log(JSON.stringify({ installed: state !== "absent", state, pid, logs, at_login }));
    else log(state === "absent" ? `${label}: not installed` : `${label}: ${state}${pid ? ` (pid ${pid})` : ""}${at_login ? ", starts at login" : ", not at login"}`);
    return state;
  } else throw new Error("usage: factory service install [--login on|off]|uninstall|start|restart|status [--json] | login on|off");
}

// An ad-hoc signature, so macOS takes the bundle as one program; a failure changes nothing.
const adhocSign = (app: string) => { Bun.spawnSync(["codesign", "--force", "--sign", "-", app], { env: process.env }); };

// The pid of the launchd service when it serves this FACTORY_HOME and is running, else null.
// `factory run` checks it: a second daemon on the same factories doubles every tick and
// races the first on the database and the window's files.
export function servicePid(o: { factoryHome: string; label?: string; agentsDir?: string; run?: Run; uid?: number }) {
  const label = o.label ?? LABEL;
  const file = join(o.agentsDir ?? join(homedir(), "Library", "LaunchAgents"), `${label}.plist`);
  if (!existsSync(file)) return null;
  const home = readFileSync(file, "utf8").match(/<key>FACTORY_HOME<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  if (!home || resolve(home.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) !== resolve(o.factoryHome)) return null;
  const r = (o.run ?? launchctl)(["print", `gui/${o.uid ?? process.getuid!()}/${label}`]);
  if (r.code !== 0 || r.out.match(/^\s*state = (\S+)/m)?.[1] !== "running") return null;
  return Number(r.out.match(/^\s*pid = (\d+)/m)?.[1]) || null;
}
