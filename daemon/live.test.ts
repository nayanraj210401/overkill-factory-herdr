import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { liveFile, liveRoster, rosterText, writeLive } from "./live.ts";
import { stateFile } from "./globals.ts";
import type { Run } from "./runner.ts";

const now = "2026-11-23T10:00:00Z";

// Two factories under one home: acme-api (api lead, web) and shop (shop lead, docs with nothing running).
function home() {
  const h = mkdtempSync(join(tmpdir(), "live-home-"));
  const api = open(join(h, "acme-api", "factory.db"));
  setRepo(api, { slug: "acme/api", path: "/r/api", lead: true });
  setRepo(api, { slug: "acme/web", path: "/r/web", lead: false });
  const ticket = (db: ReturnType<typeof open>, id: number, title: string, o: Record<string, unknown> = {}) => {
    const cols = { id, title, state: "running", updated_at: now, ...o };
    db.query(`INSERT INTO tickets (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).run(...(Object.values(cols) as any[]));
  };
  const session = (db: ReturnType<typeof open>, ticket: number, stage: string, agent: string, terminal: string | null, cwd: string | null, tokens = [0, 0]) =>
    db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, cwd, tokens_in, tokens_out) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)")
      .run(ticket, stage, agent, terminal, now, cwd, tokens[0], tokens[1]);
  // #1 builds in acme/web's worktree (its PR #41 is there), in a live terminal Herdr says is working.
  ticket(api, 1, "Rate-limit login", { stage: "build", tokens_in: 900, tokens_out: 30 });
  api.query("INSERT INTO ticket_repos (ticket, repo, lead, worktree, pr_number) VALUES (1, 'acme/api', 1, '/w/api-1', 40), (1, 'acme/web', 0, '/w/web-1', 41)").run();
  session(api, 1, "build", "builder", "t1", "/w/web-1", [1200, 45]);
  // #2's verify session has no live terminal any more.
  ticket(api, 2, "Fix typo", { stage: "verify", detail: "checking" });
  session(api, 2, "verify", "checker", "t9", "/w/api-2");
  // #3 is at the daemon's own pr stage: no session at all. #4 is queued: not on the roster.
  ticket(api, 3, "Add docs", { stage: "pr", detail: "ready rules · 4 of 5" });
  api.query("INSERT INTO stages (ticket, name, started_at) VALUES (3, 'pr', ?)").run(now);
  ticket(api, 4, "Later", { state: "queued" });
  api.close();
  const shop = open(join(h, "shop", "factory.db"));
  setRepo(shop, { slug: "acme/shop", path: "/r/shop", lead: true });
  setRepo(shop, { slug: "acme/docs", path: "/r/docs", lead: false });
  // #10 is a request the maintainer works on, waiting on you in its terminal; #11 runs in the cloud.
  ticket(shop, 10, "Raise the budget", { blueprint: "factory", stage: "change" });
  session(shop, 10, "change", "maintainer", "t2", null);
  ticket(shop, 11, "Search", { stage: "build", location: "cloud" });
  session(shop, 11, "cloud", "cloud", "c1", null);
  shop.close();
  writeFileSync(stateFile(h), JSON.stringify({ terminal: "t5", started_at: "2026-11-23T09:00:00Z" }));
  return h;
}

const hc = (terminals: object[] | null): Run => (argv) =>
  argv[0] === "hc" && argv[1] === "ls" ? (terminals ? { code: 0, out: JSON.stringify({ terminals }) } : { code: 1, out: "no server" }) : { code: 1, out: "" };

const TERMS = [
  { address: "t1", agent: "claude-code", status: "working", state: "live" },
  { address: "t2", agent: "claude-code", status: "blocked", state: "live" },
  { address: "t5", agent: "claude-code", status: "idle", state: "live", name: "f-overwatch" },
];

test("the roster: every running agent of every factory, global and repo, with and without a live terminal", () => {
  const h = home();
  const r = liveRoster({ run: hc(TERMS), now, home: h });
  expect(r.herdr).toBe(true);
  expect(r.factories.map((f) => [f.name, f.repos.map((x) => [x.slug, x.path])])).toEqual([
    ["acme-api", [["acme/api", "/r/api"], ["acme/web", "/r/web"]]],
    ["shop", [["acme/shop", "/r/shop"], ["acme/docs", "/r/docs"]]], // docs has nothing running and is listed
  ]);
  const row = (f: string | null, id: number | null) => r.agents.find((a) => a.factory === f && (a.ticket?.id ?? null) === id)!;
  expect(row(null, null)).toMatchObject({ agent: "overwatch", tier: "global", status: "idle", terminal: "t5", live: true, started_at: "2026-11-23T09:00:00Z" });
  expect(row("acme-api", 1)).toEqual({
    factory: "acme-api", repo: "acme/web", agent: "builder", tier: "repo", ticket: { id: 1, title: "Rate-limit login" }, pr: 41, stage: "build",
    status: "working", why: "working", terminal: "t1", live: true, started_at: now, tokens: { input: 1200, output: 45 },
  });
  // A stage whose terminal is gone: still listed, with the stage's own state.
  expect(row("acme-api", 2)).toMatchObject({ agent: "checker", repo: "acme/api", stage: "verify", status: "idle", why: "checking", terminal: "t9", live: false });
  // A stage the daemon runs itself: no agent, no terminal.
  expect(row("acme-api", 3)).toMatchObject({ agent: null, tier: null, stage: "pr", status: "idle", terminal: null, live: false, started_at: now });
  expect(row("acme-api", 4)).toBeUndefined();
  expect(row("shop", 10)).toMatchObject({ repo: "acme/shop", agent: "maintainer", tier: "global", status: "waiting", terminal: "t2" });
  expect(row("shop", 11)).toMatchObject({ agent: "cloud", tier: null, status: "cloud" });
  expect(rosterText(r)).toContain("- working acme-api · acme/web · #1 Rate-limit login · PR #41 · build · builder (repo) · t1");
  expect(rosterText(r)).toContain("- shop: acme/shop (/r/shop, lead), acme/docs (/r/docs)");
});

test("without Herdr, statuses come from the stage state and liveness is unknown", () => {
  const h = home();
  const r = liveRoster({ run: hc(null), now, home: h });
  expect(r.herdr).toBe(false);
  expect(r.agents.some((a) => a.agent === "overwatch")).toBe(false); // its terminal can't be seen
  expect(r.agents.find((a) => a.ticket?.id === 1)).toMatchObject({ status: "idle", live: null });
  // A ticket paused, or waiting on another, is blocked whatever its terminal says.
  const db = open(join(h, "acme-api", "factory.db"));
  db.query("UPDATE tickets SET state = 'blocked', blocked_by = 3 WHERE id = 1").run();
  db.query("UPDATE tickets SET needs_kind = 'attention', needs_text = 'Waiting on you in its terminal (t9)' WHERE id = 2").run();
  const again = liveRoster({ run: hc(TERMS), now, home: h, db: (n) => (n === "acme-api" ? db : undefined) });
  expect(again.agents.find((a) => a.ticket?.id === 1)).toMatchObject({ status: "blocked", why: "waits on #3" });
  expect(again.agents.find((a) => a.factory === "acme-api" && a.ticket?.id === 2)).toMatchObject({ status: "waiting" });
  db.query("SELECT 1").get(); // the handle it was given stays open
  db.close();
});

test("the daemon's file: written whole, next to overwatch.json, and left alone when only the time changed", () => {
  const h = home();
  writeLive(liveRoster({ run: hc(TERMS), now, home: h }), h);
  expect(liveFile(h)).toBe(join(h, "agents-live.json"));
  const first = readFileSync(liveFile(h), "utf8");
  expect(JSON.parse(first).agents.length).toBe(6);
  expect(readdirSync(h).some((f) => f.endsWith(".tmp"))).toBe(false);
  writeLive(liveRoster({ run: hc(TERMS), now: "2026-11-23T10:00:05Z", home: h }), h);
  expect(readFileSync(liveFile(h), "utf8")).toBe(first);
  writeLive(liveRoster({ run: hc(TERMS.slice(1)), now: "2026-11-23T10:00:10Z", home: h }), h);
  expect(JSON.parse(readFileSync(liveFile(h), "utf8")).agents.find((a: any) => a.ticket?.id === 1).live).toBe(false);
  expect(existsSync(liveFile(h))).toBe(true);
});
