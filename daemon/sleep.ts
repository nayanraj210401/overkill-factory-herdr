// Cloud on sleep (plan: Local and cloud). `factory cloud all` / `factory local all` move
// every running ticket at once; `cloud: { on_sleep: move }` does it when the machine is about
// to sleep (notice from daemon/power.ts) and brings back, on wake, only the tickets it moved.
//
// Safety: a ticket that can't move is skipped with a reason and never fails the batch. The
// list of tickets moved for sleep lives in the factory's meta (`sleep_state`), written after
// each ticket, so a second sleep notice, a wake without a sleep, or a daemon restart all
// converge: a ticket already in the cloud is skipped, an empty list wakes nothing.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import { awayPolicy, forbiddenTouched } from "./away.ts";
import { readAccount } from "./account.ts";
import { noteCloudFailure, toCloud, toLocal } from "./cloud.ts";
import { readFactory, type Run } from "./runner.ts";

type Change = (db: Database, fn: () => void) => void;
export type Ctx = { dir: string; repo: string; run: Run; now: string; mover?: typeof toCloud; back?: typeof toLocal; change?: Change };
export type Moved = { id: number; tries: number };
export type SleepState = { moved: Moved[]; woke: boolean };
export type Batch = { done: number[]; skipped: { id: number; why: string }[]; failed: { id: number; why: string }[] };

export const MAX_BRING_BACK_TRIES = 5;
// The helper holds the machine's sleep for at most this long (daemon/power.ts); past it, work stops between tickets.
export const SLEEP_BUDGET_MS = 20_000;

export type CloudPolicy = { on_sleep: "move" | "off" };
// The factory's cloud: over the account's, key by key; off unless set.
export function cloudPolicy(repo: string): CloudPolicy {
  const v = { ...(readAccount() as any).cloud, ...(readFactory(repo) as any).cloud };
  return { on_sleep: v.on_sleep === "move" ? "move" : "off" };
}

type Row = { id: number; state: string; location: string; blueprint: string; worktree: string | null };
const lead = (db: Database, id: number) => db.query("SELECT id, state, location, blueprint, worktree, resume_at FROM ticket_lead WHERE id = ?").get(id) as Row | null;

// Why a ticket can't go to the cloud in a batch, or null. Away rules apply: a batch move runs unattended.
export function whyNotCloud(db: Database, o: Ctx, id: number): string | null {
  const t = lead(db, id);
  if (!t) return "no such ticket";
  if (t.location === "cloud") return "already in the cloud";
  if (t.state !== "running") return `is ${t.state}, not running`;
  if (!t.worktree) return "has no worktree yet";
  if (t.resume_at) return "waits for the plan limit to reset, which the cloud shares";
  const only = awayPolicy(o.repo).blueprints;
  if (only && !only.includes(t.blueprint)) return `blueprint ${t.blueprint} isn't in away.blueprints`;
  const touched = forbiddenTouched(db, { repo: o.repo, worktree: t.worktree, run: o.run, always: true });
  if (touched.length) return `touches ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? "…" : ""}, which away.never keeps off unattended runs`;
  return null;
}

const inTxn: Change = (db, fn) => db.transaction(fn)();

// Every running ticket to the cloud. `reason` ("sleep") is written in the decision log; `stop`
// ends the batch early (the sleep budget), leaving the rest local and listed as skipped.
export function moveAll(db: Database, o: Ctx & { reason?: string; stop?: () => boolean; onMoved?: (id: number) => void }): Batch {
  const out: Batch = { done: [], skipped: [], failed: [] };
  const ids = (db.query("SELECT id FROM ticket_lead WHERE state = 'running' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  for (const id of ids) {
    if (o.stop?.()) { out.skipped.push({ id, why: "no time left before sleep" }); continue; }
    const why = whyNotCloud(db, o, id);
    if (why) { out.skipped.push({ id, why }); continue; }
    try {
      (o.change ?? inTxn)(db, () => { (o.mover ?? toCloud)(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now, reason: o.reason }); });
      out.done.push(id);
      o.onMoved?.(id);
    } catch (e) { out.failed.push({ id, why: (e as Error).message }); noteCloudFailure(db, id, (e as Error).message, o.now, o.reason); }
  }
  return out;
}

// Every ticket in the cloud back here (or just `only`).
export function bringAll(db: Database, o: Ctx & { reason?: string; only?: number[]; onBack?: (id: number) => void }): Batch {
  const out: Batch = { done: [], skipped: [], failed: [] };
  const ids = (db.query("SELECT id FROM ticket_lead WHERE location = 'cloud' ORDER BY id").all() as { id: number }[]).map((r) => r.id)
    .filter((id) => !o.only || o.only.includes(id));
  for (const id of ids) {
    try {
      (o.change ?? inTxn)(db, () => { (o.back ?? toLocal)(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now, reason: o.reason }); });
      out.done.push(id);
      o.onBack?.(id);
    } catch (e) { out.failed.push({ id, why: (e as Error).message }); }
  }
  return out;
}

export const readState = (db: Database): SleepState => {
  try { const s = JSON.parse(getMeta(db, "sleep_state") ?? ""); return { moved: s.moved ?? [], woke: !!s.woke }; } catch { return { moved: [], woke: false }; }
};
const writeState = (db: Database, s: SleepState) => setMeta(db, "sleep_state", JSON.stringify(s));

const note = (db: Database, id: number | null, what: string, why: string, at: string) =>
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(id, what, why, at);

// The machine is about to sleep. Does nothing unless cloud.on_sleep is move. Safe to repeat.
export function onSleep(db: Database, o: Ctx & { deadline?: number; clock?: () => number; log?: (s: string) => void }): Batch | null {
  if (cloudPolicy(o.repo).on_sleep !== "move") return null;
  const clock = o.clock ?? Date.now;
  const until = o.deadline ?? clock() + SLEEP_BUDGET_MS;
  const state = readState(db);
  state.woke = false;
  writeState(db, state);
  const r = moveAll(db, {
    ...o, reason: "sleep", stop: () => clock() > until,
    // Written as each ticket lands, so a notice cut short still lets the wake bring those back.
    onMoved: (id) => { const s = readState(db); if (!s.moved.some((m) => m.id === id)) s.moved.push({ id, tries: 0 }); writeState(db, s); },
  });
  for (const f of r.failed) { o.log?.(`factory: #${f.id}: not moved for sleep: ${f.why}`); }
  for (const s of r.skipped) if (s.why !== "already in the cloud") o.log?.(`factory: #${s.id}: stays local for sleep: ${s.why}`);
  return r;
}

// The machine woke. Brings back the tickets sleep moved, and only those; retried by `wakeTick`
// for any that wasn't ready (the cloud session may still be pushing; the network may be down).
export function onWake(db: Database, o: Ctx & { log?: (s: string) => void }): Batch | null {
  const s = readState(db);
  if (!s.moved.length) return null; // a wake without a sleep move
  s.woke = true;
  writeState(db, s);
  return wakePass(db, o);
}
export const wakeTick = (db: Database, o: Ctx & { log?: (s: string) => void }) => {
  const s = readState(db);
  return s.woke && s.moved.length ? wakePass(db, o) : null;
};

function wakePass(db: Database, o: Ctx & { log?: (s: string) => void }): Batch {
  const s = readState(db);
  const mine = s.moved.map((m) => m.id);
  // One the person brought back (or merged away) in the meantime is no longer ours to move.
  const inCloud = new Set((db.query("SELECT id FROM ticket_lead WHERE location = 'cloud'").all() as { id: number }[]).map((r) => r.id));
  const r = bringAll(db, { ...o, reason: "wake", only: mine.filter((id) => inCloud.has(id)) });
  const failed = new Map(r.failed.map((f) => [f.id, f.why]));
  const next: Moved[] = [];
  for (const m of s.moved) {
    if (!failed.has(m.id)) continue; // back, or not in the cloud any more
    const tries = m.tries + 1;
    if (tries >= MAX_BRING_BACK_TRIES) {
      note(db, m.id, "left in the cloud after wake", `${failed.get(m.id)!.slice(0, 300)} (⇧L brings it back by hand)`, o.now);
      o.log?.(`factory: #${m.id}: left in the cloud: ${failed.get(m.id)}`);
    } else {
      if (m.tries === 0) note(db, m.id, "couldn't bring back from the cloud on wake; will retry", failed.get(m.id)!.slice(0, 300), o.now);
      next.push({ id: m.id, tries });
    }
  }
  writeState(db, { moved: next, woke: next.length > 0 });
  return r;
}

// A gap between ticks far longer than the interval means the machine slept without a notice
// (or the daemon was stopped). Tickets still local are left running; the gap is logged on each.
// A wake notice missed after a sleep move counts as the wake.
export function noteGap(db: Database, o: Ctx & { interval: number; log?: (s: string) => void }) {
  const last = getMeta(db, "tick_at");
  setMeta(db, "tick_at", o.now);
  if (!last) return null;
  const gap = Date.parse(o.now) - Date.parse(last);
  if (!(gap > Math.max(o.interval * 5, 120) * 1000)) return null;
  const s = readState(db);
  const mins = Math.round(gap / 60000);
  if (s.moved.length && !s.woke) { s.woke = true; writeState(db, s); }
  const local = (db.query("SELECT id FROM ticket_lead WHERE state = 'running' AND location = 'local'").all() as { id: number }[]).map((r) => r.id);
  if (!s.moved.length) for (const id of local) note(db, id, `the machine was away about ${mins} min with no sleep notice`, "kept running here", o.now);
  if (local.length || s.moved.length) o.log?.(`factory: no ticks for ~${mins} min (asleep?); ${local.length} running here${s.moved.length ? `, ${s.moved.length} to bring back` : ""}`);
  return { mins, local };
}
