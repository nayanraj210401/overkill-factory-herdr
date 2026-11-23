// The plan limit (plan: Budgets, "Your plan limits are a guard of their own"). plan.pause_at
// stops new work before the 5-hour window fills; this is what happens to a session that is
// running when it does fill, or the weekly one does. The session is stopped: its work in
// progress is committed and it ends. The ticket stays running, waiting, with the time it
// resumes (tickets.resume_at). After the reset a fresh session starts in the same stage and
// slice, from a short brief: going on with the old one would resend its whole conversation at
// full price, its prompt cache long expired. Waiting tickets restart one at a time, oldest
// first, within max_running, and not while the window still reads over plan.pause_at.
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import { planFile, readPlan, usedNow, type Reading } from "./planline.ts";
import { planMeters } from "./metrics.ts";
import { estimatedReset, pauseAt } from "./budget.ts";
import { resumeAtReset, stopAtLimit } from "./handoff.ts";
import { readFactory, type Run } from "./runner.ts";

export type Window = "five_hour" | "seven_day";
export type Hit = { window: Window; via: "reading" | "terminal" | "both"; line: string | null };
type Wait = { window: Window; via: Hit["via"]; reset: string; estimated: boolean; at: string; session: number };

export const FULL = 0.99; // a window this full reads as at its limit
export const GRACE_MS = 60_000; // resume a minute after the reset
export const STAGGER_MS = 2 * 60_000; // between two resumes
const SCREEN_EVERY_MS = 30_000; // how often an idle session's screen is read
const HOUR = 3_600_000;
const LABEL: Record<Window, string> = { five_hour: "5-hour", seven_day: "weekly" };

// Claude Code's own words when the plan stops a session. 2.1: "You've hit your session limit ·
// resets 3pm", "You've hit your weekly limit · resets Nov 25, 9am", "You've hit your Opus
// limit"; older ones: "Claude usage limit reached. Your limit will reset at 5pm", "5-hour limit
// reached ∙ resets 5pm". Specific phrases only, so a ticket about rate limits doesn't read as
// one; and not the monthly spend limit or usage credits, which no window reset ends.
const LIMIT = /you(?:'|’)?ve (?:hit|reached) your (?:(session|5-hour|weekly|opus|sonnet|fable) )?limit\b|\busage limit reached\b|\b(5-hour|session|weekly|opus|sonnet) limit reached\b/i;
const SCREEN_LINES = 15; // the limit message sits at the bottom of the screen

// The limit message on the bottom of a terminal's screen, and the window it names (null: it doesn't say).
export function limitOnScreen(screen: string): { window: Window | null; line: string } | null {
  const lines = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-SCREEN_LINES);
  for (const line of lines.reverse()) {
    const m = line.match(LIMIT);
    if (!m) continue;
    const word = (m[1] ?? m[2] ?? "").toLowerCase();
    return { window: !word ? null : word === "session" || word === "5-hour" ? "five_hour" : "seven_day", line };
  }
  return null;
}

// The windows Claude Code's last reading has at their limit, now.
export function fullWindows(r: Reading | null, now: Date): Window[] {
  return (["five_hour", "seven_day"] as const).filter((w) => (usedNow(r?.[w], now) ?? 0) >= FULL);
}

// Is the session stopped by the plan limit? Its screen says so, or the reading has a window
// full and the agent isn't working (at 100% nothing it sends goes through, working or not).
// Of two full windows, the one that resets last is the one to wait for.
export function limitHit(o: { reading: Reading | null; screen: string; working: boolean; now: Date }): Hit | null {
  const full = fullWindows(o.reading, o.now);
  const seen = limitOnScreen(o.screen);
  const latest = (ws: Window[]) => [...ws].sort((a, b) => (Date.parse(o.reading?.[a]?.resets_at ?? "") || 0) - (Date.parse(o.reading?.[b]?.resets_at ?? "") || 0)).at(-1)!;
  if (seen) return { window: latest([...new Set([...full, seen.window ?? "five_hour"])]), via: full.length ? "both" : "terminal", line: seen.line };
  const stalled = !o.working || full.some((w) => (usedNow(o.reading?.[w], o.now) ?? 0) >= 1);
  return full.length && stalled ? { window: latest(full), via: "reading", line: null } : null;
}

// When the window resets: the reading's resets_at; without one, the estimate's next 5-hour
// boundary (five hours after the window's first message), else five hours from now.
export function resetOf(db: Database, o: { reading: Reading | null; window: Window; now: Date }) {
  const at = o.reading?.[o.window]?.resets_at;
  if (at && Date.parse(at) > o.now.getTime()) return { at, estimated: false };
  const est = estimatedReset(db, o.now);
  return { at: (est && est > o.now ? est : new Date(o.now.getTime() + 5 * HOUR)).toISOString(), estimated: true };
}

// 14:05 today, "Nov 25 09:01" further out: the waiting ticket's detail line.
export function whenText(iso: string, now: Date) {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getTime() - now.getTime() < 20 * HOUR ? hm : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hm}`;
}

const waitKey = (id: number) => `plan_wait:${id}`;
const waitOf = (db: Database, id: number): Wait | null => { try { return JSON.parse(getMeta(db, waitKey(id)) ?? ""); } catch { return null; } };
const pct = (x: number) => `${Math.round(x * 100)}%`;

type Session = { id: number; ticket: number; terminal: string; argv: string; started_at: string };
const lastRead = new WeakMap<Database, Map<number, number>>(); // per factory: when each session's screen was read

// One live session, each tick, before its attention and exit are looked at: true when the plan
// limit stopped it (and it is ended now). `info` is Herdr's view of its terminal (hc get).
export function watchLimit(db: Database, o: { dir: string; repo: string; run: Run; now: string; s: Session; info: { status?: { state?: string } | null } | null; log?: (s: string) => void; reading?: Reading | null }) {
  const { s } = o;
  if (JSON.parse(s.argv)[0] !== "claude") return false;
  const t = db.query("SELECT state, location, resume_at FROM tickets WHERE id = ?").get(s.ticket) as { state: string; location: string; resume_at: string | null } | null;
  if (!t || t.state !== "running" || t.location === "cloud" || t.resume_at) return false;
  const now = new Date(o.now);
  const reading = o.reading !== undefined ? o.reading : readPlan(planFile());
  const working = o.info?.status?.state === "working";
  const full = fullWindows(reading, now).length > 0;
  // The screen is read when the agent sits still (a limit stops it there), at most every 30s.
  let screen = "";
  if (full || !working) {
    const seen = lastRead.get(db) ?? lastRead.set(db, new Map()).get(db)!;
    if (full || now.getTime() - (seen.get(s.id) ?? 0) >= SCREEN_EVERY_MS) {
      seen.set(s.id, now.getTime());
      const r = o.run(["hc", "read", s.terminal]);
      screen = r.code === 0 ? r.out : "";
    }
  }
  const hit = limitHit({ reading, screen, working, now });
  if (!hit) return false;
  lastRead.get(db)?.delete(s.id);
  waitForReset(db, { ...o, hit, reading });
  return true;
}

// Stops the session the limit stopped and marks its ticket waiting for the reset. It stays
// running (its stage open, its slot under max_running kept), never in Needs you.
export function waitForReset(db: Database, o: { dir: string; repo: string; run: Run; now: string; s: Session; hit: Hit; reading: Reading | null; log?: (s: string) => void }) {
  const { s, hit } = o;
  const now = new Date(o.now);
  const reset = resetOf(db, { reading: o.reading, window: hit.window, now });
  const resumeAt = new Date(Date.parse(reset.at) + GRACE_MS).toISOString();
  stopAtLimit(db, { run: o.run, now: o.now, s });
  const detail = `waiting for ${hit.window === "seven_day" ? "the weekly " : ""}plan reset · resumes ${whenText(resumeAt, now)}`;
  // A limit menu Herdr saw as a question isn't one: the attention flag goes with the session.
  db.query("UPDATE tickets SET resume_at = ?, detail = ?, needs_kind = CASE WHEN needs_kind = 'attention' THEN NULL ELSE needs_kind END, needs_text = CASE WHEN needs_kind = 'attention' THEN NULL ELSE needs_text END, updated_at = ? WHERE id = ?")
    .run(resumeAt, detail, o.now, s.ticket);
  db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, s.ticket);
  setMeta(db, waitKey(s.ticket), JSON.stringify({ window: hit.window, via: hit.via, reset: reset.at, estimated: reset.estimated, at: o.now, session: s.id } satisfies Wait));
  const used = (w: Window) => usedNow(o.reading?.[w], now);
  const evidence = [
    hit.via !== "terminal" ? `Claude Code's reading has the ${LABEL[hit.window]} window at ${pct(used(hit.window) ?? 1)}` : null,
    hit.line ? `its terminal says "${hit.line.slice(0, 120)}"` : null,
  ].filter(Boolean).join("; ");
  const when = reset.estimated ? `no reset time in the reading, so the next 5-hour boundary is estimated: ${reset.at}` : `the window resets at ${reset.at}`;
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(s.ticket, `stopped at the ${LABEL[hit.window]} plan limit; resumes at ${resumeAt} in a fresh session`, `${evidence}; ${when}; its work in progress is committed`, o.now);
  o.log?.(`factory: #${s.ticket} hit the ${LABEL[hit.window]} plan limit; its work is committed and it resumes ${whenText(resumeAt, now)}${reset.estimated ? " (no reset time in Claude Code's reading: estimated from the 5-hour window)" : ""}`);
}

// Why a waiting ticket can't resume yet, or null. A reading taken before the reset it waited for,
// with no resets_at to say its window ended, says nothing about the new window and is skipped.
export function stillOver(db: Database, o: { repo: string; now: Date; since: string }) {
  const r = readPlan(planFile());
  const m = planMeters(db, o.now);
  const fresh = (w: Window) => {
    const x = r?.[w];
    if (!x) return w === "five_hour" ? (m.source === "estimate" ? m.window_5h : 0) : m.week;
    return x.resets_at || Date.parse(r!.at) >= Date.parse(o.since) ? usedNow(x, o.now) ?? 0 : 0;
  };
  const five = fresh("five_hour");
  const week = fresh("seven_day");
  const at = pauseAt(o.repo);
  if (week >= FULL) return `the weekly window still reads ${pct(week)}`;
  if (five >= FULL || (at != null && five >= at)) return `the 5-hour window still reads ${pct(five)}${at != null ? `, over plan.pause_at (${pct(at)})` : ""}`;
  return null;
}

// Each tick: the waiting ticket that has waited longest and whose time has come gets its fresh
// session; one per tick, STAGGER_MS apart, while fewer than max_running tickets have a live
// agent. Everything it goes on is in the database, so a daemon restarted mid-wait, or a Mac
// that slept through the reset, picks up where it was.
export function resumeWaiting(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const due = db.query("SELECT id, resume_at FROM tickets WHERE state = 'running' AND resume_at IS NOT NULL AND resume_at <= ? AND location != 'cloud' ORDER BY resume_at, id").all(o.now) as { id: number; resume_at: string }[];
  if (!due.length) return null;
  const now = new Date(o.now);
  const last = Date.parse(getMeta(db, "plan_resumed_at") ?? "") || 0;
  if (now.getTime() - last < STAGGER_MS) return null;
  const max = readFactory(o.repo).max_running ?? 3;
  const live = (db.query("SELECT COUNT(*) AS n FROM tickets WHERE state = 'running' AND resume_at IS NULL").get() as { n: number }).n;
  if (live >= max) return null;
  const { id, resume_at } = due[0];
  const wait = waitOf(db, id);
  const held = stillOver(db, { repo: o.repo, now, since: wait?.reset ?? new Date(Date.parse(resume_at) - GRACE_MS).toISOString() });
  if (held) {
    const detail = `waiting for plan reset · ${held}`;
    const changed = db.query("UPDATE tickets SET detail = ? WHERE id = ? AND detail IS NOT ?").run(detail, id, detail).changes;
    if (changed) {
      db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, id);
      o.log?.(`factory: #${id} waits on: ${held}`);
    }
    return null;
  }
  const window = wait?.window ?? "five_hour";
  const stopped = wait ? ` at ${whenText(wait.at, now)}` : "";
  const n = resumeAtReset(db, { ...o, id, limit: `was stopped by the plan's ${LABEL[window]} limit${stopped}, and this session starts after the window reset` });
  db.query("UPDATE tickets SET resume_at = NULL WHERE id = ?").run(id);
  db.query("DELETE FROM meta WHERE key = ?").run(waitKey(id));
  setMeta(db, "plan_resumed_at", o.now);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(id, `resumed after the plan reset in session ${n}`, `the ${LABEL[window]} window reset; a fresh session from the last commit, the diff and the old transcript's end, not the old conversation`, o.now);
  o.log?.(`factory: #${id} resumed after the ${LABEL[window]} plan reset (session ${n})`);
  return id;
}
