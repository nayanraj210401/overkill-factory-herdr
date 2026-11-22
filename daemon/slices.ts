// `per: slice` (plan: blueprint.yaml): a stage that runs once per slice in SLICES.md, a
// fresh session for each. SLICES.md is the plan agent's; the daemon only reads it. A
// slice is done when a session built it (its stage ended without failing) or when
// SLICES.md marks it ([x], ✓, done). With no slices, the stage runs once for the ticket;
// sent back once every slice is done (a failed check), it runs once for the whole ticket.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Slice = { key: string; title: string; text: string; marked: boolean };

const DONE = /\[x\]|✓|\bdone\b|\bshipped\b/i;
const strip = (l: string) => l.replace(/^\s*(#{1,6}|\d+[.)]|[-*+])\s+/, "").replace(/\[[ xX]\]\s*/, "").replace(/\*\*/g, "").trim();

// Sections headed ## or ###, else the top-level numbered list items, in order.
export function slicesOf(md: string): Slice[] {
  const headed = md.split(/^(?=#{2,3}[ \t])/m).slice(1);
  const items = headed.length ? headed : md.split(/^(?=\d+[.)][ \t])/m).filter((p) => /^\d+[.)][ \t]/.test(p));
  return items.map((p, i) => {
    const [first, ...rest] = p.trimEnd().split("\n");
    const status = rest.find((l) => /^\s*[-*]?\s*\**status\**\s*:/i.test(l)) ?? "";
    const title = strip(first).slice(0, 120);
    return { key: title.match(/\bS(\d+)\b/)?.[0] ?? `#${i + 1}`, title, text: p.trim().slice(0, 3000), marked: DONE.test(first) || DONE.test(status) };
  });
}

export const readSlices = (dir: string, id: number) => {
  const file = join(dir, "tickets", String(id), "SLICES.md");
  return existsSync(file) ? slicesOf(readFileSync(file, "utf8")) : [];
};

const doneKeys = (db: Database, id: number, stage: string) =>
  new Set((db.query("SELECT key FROM slices WHERE ticket = ? AND stage = ? AND done_at IS NOT NULL").all(id, stage) as { key: string }[]).map((r) => r.key));

// The slice a new session of this stage builds: the first not done. null: the whole ticket.
export function sliceInHand(db: Database, o: { dir: string; id: number; stage: string }) {
  const done = doneKeys(db, o.id, o.stage);
  return readSlices(o.dir, o.id).find((s) => !s.marked && !done.has(s.key)) ?? null;
}

// The stage's session ended well: its slice is done. Returns the slice left to build next, if any.
export function finishSlice(db: Database, o: { dir: string; id: number; stage: string; now: string }) {
  const s = db.query("SELECT id, slice FROM sessions WHERE ticket = ? AND stage = ? ORDER BY id DESC LIMIT 1").get(o.id, o.stage) as { id: number; slice: string | null } | null;
  if (!s?.slice) return null; // a whole-ticket run: the stage is over
  const title = readSlices(o.dir, o.id).find((x) => x.key === s.slice)?.title ?? s.slice;
  db.query(`INSERT INTO slices (ticket, stage, key, title, session, done_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (ticket, stage, key) DO UPDATE SET session = excluded.session, done_at = excluded.done_at`).run(o.id, o.stage, s.slice, title, s.id, o.now);
  return sliceInHand(db, o);
}
