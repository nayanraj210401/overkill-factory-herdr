import { test, expect, beforeEach } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, open, setRepo } from "./db.ts";
import { sh, type Run } from "./runner.ts";
import { bringAll, cloudPolicy, moveAll, noteGap, onSleep, onWake, readState, wakeTick, type Ctx } from "./sleep.ts";
import { buildHelper, handleLine, helperPath, powerWatcher } from "./power.ts";

beforeEach(() => { process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "fh-")); });

function setup(yaml: string) {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\n${yaml}\n`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const add = (id: number, o: { state?: string; location?: string; blueprint?: string; worktree?: string | null } = {}) => {
    db.query("INSERT INTO tickets (id, title, blueprint, state, location, updated_at) VALUES (?, 'x', ?, ?, ?, '2026-11-22T10:00:00Z')")
      .run(id, o.blueprint ?? "feature", o.state ?? "running", o.location ?? "local");
    db.query("INSERT INTO ticket_repos (ticket, repo, lead, worktree, branch) VALUES (?, 'acme/api', 1, ?, ?)").run(id, o.worktree === undefined ? repo : o.worktree, `factory/${id}`);
  };
  // Stubs: the real toCloud pushes and starts claude --cloud, which a test never does.
  const calls: string[] = [];
  const mover: Ctx["mover"] = (db_, o) => {
    if (o.id === 3) throw new Error("git push failed: offline");
    calls.push(`cloud ${o.id} ${o.reason ?? ""}`);
    db_.query("UPDATE tickets SET location = 'cloud' WHERE id = ?").run(o.id);
    db_.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, 'moved to the cloud', ?, ?)").run(o.id, o.reason ? "daemon" : "you", o.reason ?? "branch", o.now);
    return { terminal: "t", stage: "spec" };
  };
  let backFail = new Set<number>();
  const back: Ctx["back"] = (db_, o) => {
    if (backFail.has(o.id)) throw new Error("not a fast-forward");
    calls.push(`local ${o.id} ${o.reason ?? ""}`);
    db_.query("UPDATE tickets SET location = 'local' WHERE id = ?").run(o.id);
    db_.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, 'brought back', ?, ?)").run(o.id, o.reason ? "daemon" : "you", o.reason ?? "", o.now);
    return { stage: "spec", terminal: null };
  };
  const ctx = (extra: Partial<Ctx> = {}): Ctx => ({ dir, repo, run: sh as Run, now: "2026-11-22T11:00:00Z", mover, back, ...extra });
  const loc = (id: number) => (db.query("SELECT location FROM tickets WHERE id = ?").get(id) as any).location;
  const decisions = (id: number) => db.query("SELECT who, what, why FROM decisions WHERE ticket = ? ORDER BY id").all(id) as any[];
  return { db, repo, dir, add, ctx, calls, loc, decisions, failBack: (...ids: number[]) => { backFail = new Set(ids); } };
}

test("a batch moves what can move and says why for the rest; one failure doesn't stop the others", () => {
  const { db, add, ctx, calls, loc } = setup("away: { blueprints: [feature], never: [\"src/auth/**\"] }");
  add(1); add(2, { state: "parked" }); add(3); add(4, { blueprint: "chore" }); add(5, { location: "cloud" }); add(6, { worktree: null });
  const r = moveAll(db, ctx());
  expect(r.done).toEqual([1]);
  expect(r.failed).toEqual([{ id: 3, why: "git push failed: offline" }]);
  const why = Object.fromEntries(r.skipped.map((s) => [s.id, s.why]));
  expect(why).toEqual({ 4: "blueprint chore isn't in away.blueprints", 5: "already in the cloud", 6: "has no worktree yet" }); // 2 isn't running, so it isn't listed
  expect(calls).toEqual(["cloud 1 "]);
  expect([loc(1), loc(3), loc(4)]).toEqual(["cloud", "local", "local"]);
});

test("away.never: a ticket whose worktree touches a forbidden path stays local", () => {
  const { db, repo, add, ctx, loc } = setup("away: { never: [\"src/auth/**\"] }");
  sh(["git", "-C", repo, "checkout", "-q", "-b", "work"]);
  add(1);
  expect(moveAll(db, ctx()).done).toEqual([1]);
  sh(["mkdir", "-p", join(repo, "src/auth")]);
  writeFileSync(join(repo, "src/auth/login.ts"), "x");
  db.query("UPDATE tickets SET location = 'local' WHERE id = 1").run();
  const r = moveAll(db, ctx());
  expect(r.done).toEqual([]);
  expect(r.skipped[0].why).toContain("touches src/auth/login.ts");
  expect(loc(1)).toBe("local");
});

test("bringAll returns every ticket in the cloud, and says what failed", () => {
  const { db, add, ctx, loc, failBack } = setup("");
  add(1, { location: "cloud" }); add(2, { location: "cloud" }); add(3);
  failBack(2);
  const r = bringAll(db, ctx());
  expect(r.done).toEqual([1]);
  expect(r.failed).toEqual([{ id: 2, why: "not a fast-forward" }]);
  expect([loc(1), loc(2), loc(3)]).toEqual(["local", "cloud", "local"]);
});

test("cloud.on_sleep defaults to off; the factory's setting wins over the account's", () => {
  const off = setup("");
  expect(cloudPolicy(off.repo).on_sleep).toBe("off");
  writeFileSync(join(process.env.FACTORY_HOME!, "config.yaml"), "cloud: { on_sleep: move }\n");
  expect(cloudPolicy(off.repo).on_sleep).toBe("move");
  const own = setup("cloud: { on_sleep: off }");
  expect(cloudPolicy(own.repo).on_sleep).toBe("off");
});

test("sleep with the setting off does nothing", () => {
  const { db, add, ctx, calls } = setup("");
  add(1);
  expect(onSleep(db, ctx())).toBeNull();
  expect(calls).toEqual([]);
});

test("sleep moves running tickets with reason sleep; wake brings back only those, with reason wake", () => {
  const { db, add, ctx, calls, loc, decisions } = setup("cloud: { on_sleep: move }");
  add(1); add(2); add(9, { location: "cloud" }); // 9 was moved by hand earlier
  const s = onSleep(db, ctx())!;
  expect(s.done).toEqual([1, 2]);
  expect(readState(db).moved.map((m) => m.id)).toEqual([1, 2]);
  expect(decisions(1)).toEqual([{ who: "daemon", what: "moved to the cloud", why: "sleep" }]);
  const w = onWake(db, ctx())!;
  expect(w.done).toEqual([1, 2]);
  expect(calls).toEqual(["cloud 1 sleep", "cloud 2 sleep", "local 1 wake", "local 2 wake"]);
  expect(decisions(2).at(-1)).toMatchObject({ who: "daemon", why: "wake" });
  expect([loc(1), loc(2), loc(9)]).toEqual(["local", "local", "cloud"]); // 9 is yours; wake never touches it
  expect(readState(db)).toEqual({ moved: [], woke: false });
});

test("idempotent: two sleep notices move each ticket once; a wake without a sleep does nothing; two wakes bring back once", () => {
  const { db, add, ctx, calls } = setup("cloud: { on_sleep: move }");
  expect(onWake(db, ctx())).toBeNull(); // wake without a sleep
  add(1);
  onSleep(db, ctx());
  const again = onSleep(db, ctx())!;
  expect(again.done).toEqual([]);
  expect(again.skipped).toEqual([{ id: 1, why: "already in the cloud" }]);
  expect(readState(db).moved).toEqual([{ id: 1, tries: 0 }]);
  onWake(db, ctx());
  expect(onWake(db, ctx())).toBeNull();
  expect(calls).toEqual(["cloud 1 sleep", "local 1 wake"]);
});

test("a sleep cut short by its time budget leaves the rest local and still wakes the ones it moved", () => {
  const { db, add, ctx, calls, loc } = setup("cloud: { on_sleep: move }");
  add(1); add(2);
  let t = 0;
  const clock = () => (t += 10); // each check costs 10 ms against a 15 ms budget
  const r = onSleep(db, { ...ctx(), deadline: 15, clock })!;
  expect(r.done).toEqual([1]);
  expect(r.skipped).toEqual([{ id: 2, why: "no time left before sleep" }]);
  expect(loc(2)).toBe("local");
  onWake(db, ctx());
  expect(calls).toEqual(["cloud 1 sleep", "local 1 wake"]);
});

test("a failed move for sleep is logged on the ticket and the ticket isn't on the wake list", () => {
  const { db, add, ctx, decisions } = setup("cloud: { on_sleep: move }");
  add(3);
  const r = onSleep(db, ctx())!;
  expect(r.failed).toHaveLength(1);
  expect(decisions(3)[0]).toMatchObject({ who: "daemon", what: "couldn't move to the cloud for sleep; the agent keeps running here" });
  expect(readState(db).moved).toEqual([]);
});

test("wake retries a bring-back that failed, then gives up and says so", () => {
  const { db, add, ctx, loc, decisions, failBack } = setup("cloud: { on_sleep: move }");
  add(1);
  onSleep(db, ctx());
  failBack(1);
  onWake(db, ctx());
  expect(readState(db)).toEqual({ moved: [{ id: 1, tries: 1 }], woke: true });
  expect(decisions(1).at(-1)!.what).toContain("will retry");
  wakeTick(db, ctx()); wakeTick(db, ctx()); wakeTick(db, ctx());
  expect(readState(db).moved).toEqual([{ id: 1, tries: 4 }]);
  wakeTick(db, ctx());
  expect(readState(db)).toEqual({ moved: [], woke: false });
  expect(loc(1)).toBe("cloud");
  expect(decisions(1).at(-1)!.what).toBe("left in the cloud after wake");
  expect(wakeTick(db, ctx())).toBeNull();
});

test("a ticket you brought back yourself while asleep is dropped from the wake list without a second bring-back", () => {
  const { db, add, ctx, calls } = setup("cloud: { on_sleep: move }");
  add(1);
  onSleep(db, ctx());
  db.query("UPDATE tickets SET location = 'local' WHERE id = 1").run();
  onWake(db, ctx());
  expect(calls).toEqual(["cloud 1 sleep"]);
  expect(readState(db).moved).toEqual([]);
});

test("a clock jump with no notice is logged on the running tickets; a missed wake counts as the wake", () => {
  const { db, add, ctx, decisions } = setup("");
  add(1);
  expect(noteGap(db, { ...ctx(), now: "2026-11-22T10:00:00Z", interval: 10 })).toBeNull(); // the first tick
  expect(noteGap(db, { ...ctx(), now: "2026-11-22T10:00:10Z", interval: 10 })).toBeNull();
  expect(noteGap(db, { ...ctx(), now: "2026-11-22T10:45:00Z", interval: 10 })).toMatchObject({ mins: 45, local: [1] });
  expect(decisions(1)[0]).toMatchObject({ who: "daemon", what: "the machine was away about 45 min with no sleep notice", why: "kept running here" });
  // Moved for sleep, wake notice lost: the gap wakes it.
  const m = setup("cloud: { on_sleep: move }");
  m.add(1);
  noteGap(m.db, { ...m.ctx(), now: "2026-11-22T10:00:00Z", interval: 10 });
  onSleep(m.db, m.ctx());
  noteGap(m.db, { ...m.ctx(), now: "2026-11-22T12:00:00Z", interval: 10 });
  expect(readState(m.db).woke).toBe(true);
  wakeTick(m.db, m.ctx());
  expect(m.loc(1)).toBe("local");
  expect(getMeta(m.db, "tick_at")).toBe("2026-11-22T12:00:00Z");
});

test("the helper's lines: sleep runs the handler and always acks; wake runs its handler; noise is ignored", () => {
  const seen: string[] = [];
  const h = { sleep: () => seen.push("sleep"), wake: () => seen.push("wake") };
  expect(handleLine("ready", h)).toBeNull();
  expect(handleLine("sleep", h)).toBe("done\n");
  expect(handleLine("wake", h)).toBeNull();
  expect(seen).toEqual(["sleep", "wake"]);
  const logs: string[] = [];
  expect(handleLine("sleep", { ...h, sleep: () => { throw new Error("boom"); } }, (s) => logs.push(s))).toBe("done\n"); // a failing handler never holds the sleep
  expect(logs[0]).toContain("boom");
});

test("the watcher reads the helper's stdout, acks each sleep, and starts nothing while no factory wants it", async () => {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  const logs: string[] = [];
  const seen: string[] = [];
  const written: string[] = [];
  const spawn = () => ({
    stdout: new Response("ready\nsle" + "ep\nwake\n").body!, // a line split across chunks is fine too
    write: (s: string) => written.push(s), kill: () => {}, exited: Promise.resolve(),
  });
  let wanted = false;
  const tick = powerWatcher({ factoryHome: home, log: (s) => logs.push(s), wanted: () => wanted, handlers: { sleep: () => seen.push("sleep"), wake: () => seen.push("wake") }, spawn });
  tick(); // not wanted
  wanted = true;
  tick(); // wanted, but the helper isn't built
  expect(logs.join("\n")).toContain("isn't built; run factory service install");
  expect(seen).toEqual([]);
  buildHelper(home, (a) => { writeFileSync(a.at(-3) === "-o" ? a.at(-2)! : helperPath(home), "#!/bin/sh\n"); return { code: 0, out: "" }; });
  tick();
  await Bun.sleep(20);
  expect(seen).toEqual(["sleep", "wake"]);
  expect(written).toEqual(["done\n"]);
});

test("a helper that fails to build says why", () => {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  expect(buildHelper(home, () => ({ code: 1, out: "xcode-select: error: no developer tools\nmore" }))).toBe("xcode-select: error: no developer tools more");
});
