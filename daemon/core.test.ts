import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, paths } from "./cli.ts";
import { validateStatus } from "../lib/status.js";
import { groupTickets } from "../lib/model.js";

function factory() {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const run = (...a: string[]) => main([...a, "--name", "acme-api"], () => {});
  run("init", "--repo", "acme/api");
  return { run, status: () => JSON.parse(readFileSync(paths("acme-api").status, "utf8")) };
}

test("every command leaves a status.json that meets the contract", () => {
  const { run, status } = factory();
  run("ticket", "add", "412", "Rate-limit", "login");
  run("ticket", "add", "409", "Bump", "dependencies", "--blueprint", "chore");
  run("ticket", "set", "412", "state=running", "stage=implement", "detail=slice 2 of 3", "tokens_in=1200000", "usd=1.8");
  run("ticket", "set", "409", "state=ready", "pr=511", "pr_watched=true");
  const s = status();
  expect(validateStatus(s)).toEqual([]);
  expect(s.source).toBe("daemon");
  expect(s.factory).toMatchObject({ name: "acme-api", repo: "acme/api", daemon: false });
  expect(s.tickets.find((t: any) => t.id === 409)).toMatchObject({ title: "Bump dependencies", blueprint: "chore", pr: { number: 511, watched: true } });
  const g = groupTickets(s.tickets);
  expect(g.running.map((t: any) => t.id)).toEqual([412]);
  expect(g.ready.map((t: any) => t.id)).toEqual([409]);
});

test("a change that would break the contract is refused and rolled back", () => {
  const { run, status } = factory();
  run("ticket", "add", "425", "Export", "API");
  expect(() => run("ticket", "set", "425", "state=parked")).toThrow(/state parked needs needs.kind "parked"/);
  expect(() => run("ticket", "set", "425", "state=doing")).toThrow(/is not one of/);
  expect(status().tickets[0].state).toBe("queued");
  run("ticket", "set", "425", "state=parked", "needs=parked", "needs_text=retries used up");
  expect(status().tickets[0].needs).toEqual({ kind: "parked", text: "retries used up" });
});

test("bad input names the problem", () => {
  const { run } = factory();
  expect(() => run("ticket", "set", "1", "colour=red")).toThrow(/unknown field/);
  expect(() => run("ticket", "set", "1", "state=running")).toThrow(/no ticket 1/);
  expect(() => run("ticket", "add", "x")).toThrow(/usage/);
  expect(() => run("frobnicate")).toThrow(/unknown command/);
});

test("only init creates a factory; other commands refuse a missing one", () => {
  const { run } = factory();
  expect(() => main(["merge", "7", "--name", "typo"], () => {})).toThrow('no factory "typo"');
  expect(existsSync(paths("typo").dir)).toBe(false);
  run("ticket", "add", "7", "Still", "fine");
});

test("b sets a ticket's budget from what you type, and refuses nonsense or a finished ticket", () => {
  const { run, status } = factory();
  run("ticket", "add", "412", "Rate-limit", "login");
  run("budget", "412", "3M/200k");
  expect(status().tickets[0].budget).toEqual({ input: 3_000_000, output: 200_000 });
  run("budget", "412", "1.5m");
  expect(status().tickets[0].budget).toEqual({ input: 1_500_000, output: 200_000 });
  expect(() => run("budget", "412", "lots")).toThrow(`"lots" isn't a budget`);
  expect(() => run("budget", "412", "3M/")).toThrow("isn't a budget");
  run("ticket", "set", "412", "state=merged");
  expect(() => run("budget", "412", "5M")).toThrow("#412 is merged");
});

test("refresh rewrites status.json and the ticket files, and a failing PR check doesn't stop it", () => {
  const { run } = factory();
  run("ticket", "add", "409", "Bump", "dependencies");
  run("ticket", "set", "409", "state=ready", "pr=511", "pr_watched=true");
  const p = paths("acme-api");
  const md = join(p.dir, "tickets", "409", "STATUS.md");
  require("node:fs").rmSync(p.status);
  require("node:fs").rmSync(md, { force: true });
  const out: string[] = [];
  main(["refresh", "409", "--name", "acme-api"], (s: string) => out.push(s));
  expect(existsSync(p.status)).toBe(true);
  expect(existsSync(md)).toBe(true);
  expect(out.at(-1)).toBe("#409 refreshed");
});
