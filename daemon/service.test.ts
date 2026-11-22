import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plist, selfArgs, service, servicePid, atLoginOf, APP_NAME } from "./service.ts";
import { factories } from "./cli.ts";

test("the plist runs the daemon at login, keeps it alive, and carries PATH", () => {
  const xml = plist({ label: "x.test", args: ["/opt/factory", "run", "--all"], env: { PATH: "/a:/b&c" }, logDir: "/logs" });
  expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(xml).toContain("<string>/opt/factory</string>\n    <string>run</string>\n    <string>--all</string>");
  expect(xml).toContain("<string>/a:/b&amp;c</string>");
  expect(xml).toContain("<string>/logs/daemon.err.log</string>");
});

test("selfArgs starts the compiled binary, or bun with the script in a checkout", () => {
  expect(selfArgs("/usr/local/bin/factory", "/x/cli.ts")).toEqual(["/usr/local/bin/factory"]);
  expect(selfArgs("/Users/me/.bun/bin/bun", "/repo/daemon/cli.ts")).toEqual(["/Users/me/.bun/bin/bun", "/repo/daemon/cli.ts"]);
  // Not Bun.main: under launchd that would be whatever script installed the service.
  expect(selfArgs("/Users/me/.bun/bin/bun")[1]).toEndWith("/daemon/cli.ts");
});

test("install writes the plist and bootstraps it; uninstall removes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  const calls: string[][] = [];
  const run = (a: string[]) => (calls.push(a), { code: 0, out: "state = running\npid = 42\n" });
  const o = { factoryHome: mkdtempSync(join(tmpdir(), "fh-")), label: "x.test", agentsDir: dir, run, uid: 501, log: () => {} };
  service("install", o);
  const file = join(dir, "x.test.plist");
  expect(readFileSync(file, "utf8")).toContain("<string>--all</string>");
  expect(calls.at(-1)).toEqual(["bootstrap", "gui/501", file]);
  expect(service("status", o)).toBe("running");
  service("uninstall", o);
  expect(existsSync(file)).toBe(false);
  expect(calls.at(-1)).toEqual(["bootout", "gui/501/x.test"]);
});

test("a failed bootstrap is reported, and status says absent when not loaded", () => {
  const o = { factoryHome: mkdtempSync(join(tmpdir(), "fh-")), label: "x.test", agentsDir: mkdtempSync(join(tmpdir(), "a-")), uid: 501, log: () => {} };
  expect(() => service("install", { ...o, run: (a) => ({ code: a[0] === "bootstrap" ? 5 : 0, out: "Input/output error" }) })).toThrow(/bootstrap failed: Input\/output error/);
  expect(service("status", { ...o, run: () => ({ code: 113, out: "" }) })).toBe("absent");
});

test("run --all serves every folder that has a factory.db", () => {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  expect(factories(home)).toEqual([]);
  Bun.spawnSync(["bun", join(import.meta.dir, "cli.ts"), "init", "--name", "one"], { env: { ...process.env, FACTORY_HOME: home } });
  expect(factories(home)).toEqual(["one"]);
});

test("status --json is what the window reads; restart kickstarts the job", () => {
  const out: string[] = [];
  const calls: string[][] = [];
  const o = { factoryHome: "/fh", label: "x.test", uid: 501, log: (s: string) => out.push(s), json: true };
  service("status", { ...o, run: () => ({ code: 0, out: "\tstate = running\n\tpid = 42\n" }) });
  service("status", { ...o, run: () => ({ code: 113, out: "" }) });
  expect(out.map((s) => JSON.parse(s))).toEqual([
    { installed: true, state: "running", pid: 42, logs: "/fh/logs", at_login: false },
    { installed: false, state: "absent", pid: null, logs: "/fh/logs", at_login: false },
  ]);
  service("restart", { ...o, run: (a) => (calls.push(a), { code: 0, out: "" }) });
  expect(calls[0]).toEqual(["kickstart", "-k", "gui/501/x.test"]);
  expect(() => service("restart", { ...o, run: () => ({ code: 113, out: "Could not find service" }) })).toThrow(/factory service install/);
});

test("servicePid: the running service's pid when it serves this FACTORY_HOME, else null", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  let out = "state = running\npid = 42\n";
  const run = () => ({ code: 0, out });
  const o = { factoryHome: home, label: "x.test", agentsDir: dir, run, uid: 501 };
  expect(servicePid(o)).toBe(null); // not installed
  service("install", { ...o, log: () => {} });
  expect(servicePid(o)).toBe(42);
  expect(servicePid({ ...o, factoryHome: mkdtempSync(join(tmpdir(), "other-")) })).toBe(null); // another home, e.g. tests
  out = "state = not running\n";
  expect(servicePid(o)).toBe(null);
});

test("the job runs an app bundle named for the factory, so Login Items doesn't show bun's signer", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  const signed: string[] = [];
  service("install", { factoryHome: home, label: "x.test", agentsDir: dir, uid: 501, log: () => {}, run: () => ({ code: 0, out: "" }), sign: (a) => signed.push(a) });
  const app = join(home, `${APP_NAME}.app`);
  const xml = readFileSync(join(dir, "x.test.plist"), "utf8");
  expect(xml).toContain(`<string>${app}/Contents/MacOS/factory-daemon</string>\n    <string>run</string>`);
  expect(xml).toContain("<key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>x.test</string>");
  const info = readFileSync(join(app, "Contents/Info.plist"), "utf8");
  expect(info).toContain(`<key>CFBundleName</key>\n  <string>${APP_NAME}</string>`);
  expect(info).toContain("<key>CFBundleIdentifier</key>\n  <string>x.test</string>");
  expect(readFileSync(join(app, "Contents/MacOS/factory-daemon"), "utf8")).toMatch(/^#!\/bin\/sh\n[\s\S]*exec '.*' "\$@"\n$/);
  expect(signed).toEqual([app]);
  service("uninstall", { factoryHome: home, label: "x.test", agentsDir: dir, uid: 501, log: () => {}, run: () => ({ code: 0, out: "" }) });
  expect(existsSync(app)).toBe(false);
});

test("login off: loaded but not started at login, restarted only after a crash; on puts it back; install keeps the choice", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  const calls: string[][] = [];
  const out: string[] = [];
  const o = { factoryHome: mkdtempSync(join(tmpdir(), "fh-")), label: "x.test", agentsDir: dir, uid: 501, log: (s: string) => out.push(s), sign: () => {},
    run: (a: string[]) => (calls.push(a), { code: 0, out: "state = running\npid = 7\n" }) };
  const file = join(dir, "x.test.plist");
  expect(() => service("login", { ...o, arg: "off" })).toThrow("not installed");
  service("install", o);
  expect(atLoginOf(file)).toBe(true);
  service("login", { ...o, arg: "off" });
  const xml = readFileSync(file, "utf8");
  expect(xml).toContain("<key>RunAtLoad</key>\n  <false/>");
  expect(xml).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>Crashed</key>\n    <true/>");
  expect(calls.slice(-3)).toEqual([["bootout", "gui/501/x.test"], ["bootstrap", "gui/501", file], ["kickstart", "gui/501/x.test"]]); // still running now
  service("install", o); // a reinstall (sync, an upgrade) keeps "off"
  expect(atLoginOf(file)).toBe(false);
  service("status", { ...o, json: true });
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ at_login: false, state: "running" });
  service("login", { ...o, arg: "on" });
  expect(atLoginOf(file)).toBe(true);
  expect(calls.at(-1)).toEqual(["bootstrap", "gui/501", file]); // RunAtLoad starts it
  service("start", o);
  expect(calls.at(-1)).toEqual(["kickstart", "gui/501/x.test"]);
});
