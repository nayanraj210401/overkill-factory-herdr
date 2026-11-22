import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plist, selfArgs, service, servicePid } from "./service.ts";
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
    { installed: true, state: "running", pid: 42, logs: "/fh/logs" },
    { installed: false, state: "absent", pid: null, logs: "/fh/logs" },
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
