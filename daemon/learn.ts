// The learning loop's foundation: overrides (tuned settings kept in SQLite, outside
// .factory/), the snapshot a ticket takes of them when it starts, and the lesson store.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./runner.ts";
import { isFactoryAgent } from "./agents.ts";

// ---- overrides ---------------------------------------------------------------------

export type Override = { key: string; value: unknown; reason: string | null; at: string };

// Prompts, gates, blueprints, ready rules and hard stops are never tunable (plan: Learning loop).
const FORBIDDEN_ROOTS = ["ready", "hard_stops", "blueprint", "blueprints", "gate", "gates", "merge", "quality_floor", "secrets", "prompt", "prompts"];
const FORBIDDEN_PARTS = ["prompt", "gate", "stages"];
const KEY = /^[a-z_]+(\.[A-Za-z0-9_-]+)*$/;

// Why a key can't be listed in learn.tunable, or null when it may.
export function whyNotTunable(key: string): string | null {
  if (!KEY.test(key)) return "isn't a dotted path like agents.builder.model";
  const parts = key.split(".");
  if (FORBIDDEN_ROOTS.includes(parts[0]) || parts.some((p) => FORBIDDEN_PARTS.includes(p)))
    return "is a prompt, gate, blueprint, ready rule or hard stop, which the learner never changes";
  return null;
}

// "60%" stays text; JSON numbers and booleans become themselves.
export const parseValue = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

export function setOverride(db: Database, o: { key: string; value: unknown; reason?: string | null; tunable: string[] | undefined; now: string }) {
  if (!(o.tunable ?? []).includes(o.key)) throw new Error(`${o.key} isn't in factory.yaml's learn.tunable${o.tunable?.length ? ` (${o.tunable.join(", ")})` : ""}`);
  const bad = whyNotTunable(o.key);
  if (bad) throw new Error(`${o.key} ${bad}`);
  db.transaction(() => {
    db.query("UPDATE overrides SET undone_at = ? WHERE key = ? AND undone_at IS NULL").run(o.now, o.key);
    db.query("INSERT INTO overrides (key, value, reason, created_at) VALUES (?, ?, ?, ?)").run(o.key, JSON.stringify(o.value), o.reason ?? null, o.now);
  })();
}

export function undoOverride(db: Database, key: string, now: string) {
  const r = db.query("UPDATE overrides SET undone_at = ? WHERE key = ? AND undone_at IS NULL").run(now, key);
  if (r.changes === 0) throw new Error(`${key} has no override to undo`);
}

export const activeOverrides = (db: Database): Override[] =>
  (db.query("SELECT key, value, reason, created_at FROM overrides WHERE undone_at IS NULL ORDER BY key").all() as any[])
    .map((r) => ({ key: r.key, value: JSON.parse(r.value), reason: r.reason, at: r.created_at }));

// A ticket's settings are fixed when it starts: the active overrides that are still tunable.
export function snapshotSettings(db: Database, id: number, tunable: string[] | undefined) {
  const on = Object.fromEntries(activeOverrides(db).filter((o) => (tunable ?? []).includes(o.key)).map((o) => [o.key, o.value]));
  db.query("UPDATE tickets SET settings = ? WHERE id = ?").run(JSON.stringify(on), id);
}

// The value a ticket runs with: its snapshot's override, else the file's value.
export function settingOf<T>(t: { settings?: string | null }, key: string, fileValue: T): T {
  try {
    const on = JSON.parse(t.settings ?? "{}");
    return key in on ? on[key] : fileValue;
  } catch { return fileValue; }
}

// The file's value for a key: agents.<name>.<field> is the agent's header (then
// defaults.<field>), anything else is a path into factory.yaml.
export function fileValue(key: string, factory: any, agent: (name: string) => any): unknown {
  const [root, name, field] = key.split(".");
  if (root === "agents" && field) return agent(name)?.[field] ?? factory?.defaults?.[field] ?? null;
  return key.split(".").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), factory) ?? null;
}

// `factory learn export`: the edits that would make the overrides permanent, as a patch
// (git apply --unidiff-zero). Pure: it reads .factory/ and never writes it.
const yamlValue = (v: unknown) => (typeof v === "string" && !/^[\w.%-]+$/.test(v) ? JSON.stringify(v) : String(v));

// One zero-context hunk for a key's path in a file's text; a path that runs through an
// inline map ({ a: 1 }) can't be patched line by line and comes back as a note.
function hunk(text: string, path: string[], value: unknown, headerOnly: boolean): { hunk?: string; note?: string } {
  const lines = text.split("\n");
  const end = headerOnly ? lines.findIndex((l, i) => i > 0 && l === "---") : lines.length;
  let at = -1, found = 0;
  for (const seg of path) {
    const i = lines.findIndex((l, n) => n > at && n < end && new RegExp(`^ {${found * 2}}${seg}:`).test(l));
    if (i < 0) break;
    at = i; found++;
    const inline = lines[i].slice(lines[i].indexOf(":") + 1).trim();
    if (inline && found < path.length) return { note: `${path.join(".")}: ${path.slice(0, found).join(".")} is an inline map; set ${yamlValue(value)} by hand` };
  }
  const pad = (n: number) => " ".repeat(n);
  if (found === path.length) {
    const old = lines[at];
    const next = `${pad(found * 2 - 2)}${path.at(-1)}: ${yamlValue(value)}`;
    if (!old.slice(old.indexOf(":") + 1).trim()) return { note: `${path.join(".")}: a block value; set ${yamlValue(value)} by hand` };
    return { hunk: `@@ -${at + 1} +${at + 1} @@\n-${old}\n+${next}` };
  }
  // Missing from here down: add the rest of the path right below the deepest line that exists.
  const add = path.slice(found).map((seg, i) => `${pad((found + i) * 2)}${seg}:${i === path.length - found - 1 ? ` ${yamlValue(value)}` : ""}`);
  const after = found ? at + 1 : headerOnly ? 1 : lines.length - (lines.at(-1) === "" ? 1 : 0);
  return { hunk: `@@ -${after},0 +${after + 1},${add.length} @@\n${add.map((l) => `+${l}`).join("\n")}` };
}

export function exportPatch(repo: string, overrides: Override[]) {
  const factoryNotes: string[] = [];
  const byFile = new Map<string, { path: string[]; value: unknown }[]>();
  for (const o of overrides) {
    const [root, name, ...rest] = o.key.split(".");
    const agent = root === "agents" && rest.length > 0;
    // A factory agent's file isn't in the repo: the maintainer changes ~/.factory/agents/ itself.
    if (agent && isFactoryAgent(name)) { factoryNotes.push(`${o.key}: ${name} is a factory agent; ~/.factory/agents/${name}.md holds it, not .factory/`); continue; }
    const file = agent ? `agents/${name}.md` : "factory.yaml";
    byFile.set(file, [...(byFile.get(file) ?? []), { path: agent ? rest : o.key.split("."), value: o.value }]);
  }
  const patch: string[] = [], notes: string[] = [...factoryNotes];
  for (const [file, edits] of byFile) {
    const p = join(repo, ".factory", file);
    if (!existsSync(p)) { notes.push(`.factory/${file} doesn't exist: ${edits.map((e) => e.path.join(".")).join(", ")} can't be exported`); continue; }
    const text = readFileSync(p, "utf8");
    const parts = edits.map((e) => hunk(text, e.path, e.value, file.endsWith(".md")));
    notes.push(...parts.flatMap((x) => (x.note ? [`.factory/${file} ${x.note}`] : [])));
    const hunks = parts.flatMap((x) => (x.hunk ? [x.hunk] : []));
    if (hunks.length) patch.push(`--- a/.factory/${file}`, `+++ b/.factory/${file}`, ...hunks.reverse()); // bottom first, so line numbers hold
  }
  return { patch: patch.join("\n"), notes };
}

// ---- lessons -----------------------------------------------------------------------

export type Lesson = {
  id: number; area: string; text: string; source: string; hits: number; created_at: string; retired_at: string | null; dup_of: number | null;
  hit_at: string | null; moved_hits: number; restored_at: string | null;
};

// Lowercase words only, so wording and punctuation don't hide a repeat.
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SAME_WORDS = 0.75;

// Two lessons say the same thing: the same words in order, one's text holds the other's, or
// (four words or more each) they share at least three quarters of their distinct words.
export function similar(a: string, b: string): boolean {
  const m = normal(a), n = normal(b);
  if (m === n || (Math.min(m.length, n.length) >= 20 && (m.includes(n) || n.includes(m)))) return true;
  const x = new Set(m.split(" ")), y = new Set(n.split(" "));
  if (x.size < 4 || y.size < 4) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= SAME_WORDS;
}

// An active lesson in the same area that says the same thing.
export function nearDuplicate(db: Database, area: string, text: string): Lesson | null {
  const rows = db.query("SELECT * FROM lessons WHERE area = ? AND retired_at IS NULL AND dup_of IS NULL ORDER BY id").all(area) as Lesson[];
  return rows.find((l) => similar(l.text, text)) ?? null;
}

export function addLesson(db: Database, o: { area: string; text: string; source?: string; now: string }) {
  const dup = nearDuplicate(db, o.area, o.text);
  const r = db.query("INSERT INTO lessons (area, text, source, created_at, dup_of) VALUES (?, ?, ?, ?, ?)")
    .run(o.area, o.text, o.source ?? "you", o.now, dup?.id ?? null);
  return { id: Number(r.lastInsertRowid), dup_of: dup?.id ?? null };
}

export function retireLesson(db: Database, id: number, now: string) {
  const r = db.query("UPDATE lessons SET retired_at = ? WHERE id = ? AND retired_at IS NULL").run(now, id);
  if (r.changes === 0) throw new Error(`no active lesson ${id}`);
}

// ---- lesson upkeep -----------------------------------------------------------------

export const RETIRE_AFTER = 30; // days, learn.retire_after
export const UPKEEP_EVERY = 86_400_000;
const note = (db: Database, who: string, what: string, why: string, at: string) =>
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (NULL, ?, ?, ?, ?)").run(who, what, why, at);
const latest = (...at: (string | null)[]) => at.filter((x): x is string => !!x).sort().at(-1)!;

export type Upkeep = { at: string; merged: { id: number; into: number; hits: number }[]; retired: number[] };

// The daily lesson upkeep. Near-duplicates in an area merge into the one kept (the most hits,
// then the oldest): the repeat gets dup_of and its hits move to the kept one. A lesson no brief
// has carried for retireAfter days (since it was added, last hit or restored) retires. Each
// merge and retirement is a decision row; `factory learn restore <id>` undoes one, and a
// restored lesson is out of merging for good, either way (it can still retire after another
// quiet stretch).
export function upkeepLessons(db: Database, o: { now: string; retireAfter?: number }): Upkeep {
  const days = o.retireAfter ?? RETIRE_AFTER;
  const out: Upkeep = { at: o.now, merged: [], retired: [] };
  const rows = db.query("SELECT * FROM lessons WHERE retired_at IS NULL AND dup_of IS NULL ORDER BY area, hits DESC, id").all() as Lesson[];
  const kept = new Map<string, Lesson[]>();
  for (const l of rows) {
    const area = kept.get(l.area) ?? [];
    const into = l.restored_at ? undefined : area.find((k) => !k.restored_at && similar(k.text, l.text));
    if (!into) { kept.set(l.area, [...area, l]); continue; }
    db.query("UPDATE lessons SET dup_of = ?, moved_hits = hits WHERE id = ?").run(into.id, l.id);
    into.hits += l.hits;
    into.hit_at = l.hit_at && (!into.hit_at || l.hit_at > into.hit_at) ? l.hit_at : into.hit_at;
    db.query("UPDATE lessons SET hits = ?, hit_at = ? WHERE id = ?").run(into.hits, into.hit_at, into.id);
    note(db, "daemon", `merged lesson ${l.id} into ${into.id}`, `a near-duplicate in ${l.area}; ${l.hits} hit${l.hits === 1 ? "" : "s"} moved. factory learn restore ${l.id} undoes it`, o.now);
    out.merged.push({ id: l.id, into: into.id, hits: l.hits });
  }
  const cutoff = new Date(Date.parse(o.now) - days * 86_400_000).toISOString();
  for (const l of [...kept.values()].flat()) {
    const last = latest(l.created_at, l.hit_at, l.restored_at);
    if (last >= cutoff) continue;
    db.query("UPDATE lessons SET retired_at = ? WHERE id = ?").run(o.now, l.id);
    note(db, "daemon", `retired lesson ${l.id}`, `no brief has carried it since ${last.slice(0, 10)} (learn.retire_after: ${days} days). factory learn restore ${l.id} undoes it`, o.now);
    out.retired.push(l.id);
  }
  return out;
}

// Undo a merge (the moved hits go back) or a retirement, by hand or by upkeep.
export function restoreLesson(db: Database, id: number, now: string): Lesson {
  const l = db.query("SELECT * FROM lessons WHERE id = ?").get(id) as Lesson | null;
  if (!l || (l.dup_of == null && l.retired_at == null)) throw new Error(`lesson ${id} isn't merged or retired`);
  if (l.dup_of != null) db.query("UPDATE lessons SET hits = MAX(0, hits - ?) WHERE id = ?").run(l.moved_hits, l.dup_of);
  db.query("UPDATE lessons SET dup_of = NULL, retired_at = NULL, moved_hits = 0, restored_at = ? WHERE id = ?").run(now, id);
  note(db, "you", `restored lesson ${id}`, l.dup_of != null ? `was merged into ${l.dup_of}; ${l.moved_hits} hit${l.moved_hits === 1 ? "" : "s"} went back` : `was retired ${l.retired_at!.slice(0, 10)}`, now);
  return l;
}

// Newest first, active before retired; a query matches the text and area through FTS5.
export function listLessons(db: Database, query?: string): Lesson[] {
  if (!query) return db.query("SELECT * FROM lessons ORDER BY retired_at IS NOT NULL, id DESC").all() as Lesson[];
  const q = query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
  return db.query("SELECT l.* FROM lessons_fts f JOIN lessons l ON l.id = f.rowid WHERE lessons_fts MATCH ? ORDER BY l.id DESC").all(q) as Lesson[];
}

const areaGlob = (area: string) => new Bun.Glob(area.endsWith("/") ? `${area}**` : area);
const BRIEF_LESSONS = 5;

// The lessons a ticket's brief carries: active, not a repeat, whose area matches a file it has
// touched or a path INTENT.md names; the most used first, a handful at most, each hit counted.
export function lessonsFor(db: Database, paths: string[], now: string): Lesson[] {
  if (!paths.length) return [];
  const rows = db.query("SELECT * FROM lessons WHERE retired_at IS NULL AND dup_of IS NULL ORDER BY hits DESC, id").all() as Lesson[];
  const hit = rows.filter((l) => { const g = areaGlob(l.area); return paths.some((p) => g.match(p)); }).slice(0, BRIEF_LESSONS);
  for (const l of hit) db.query("UPDATE lessons SET hits = hits + 1, hit_at = ? WHERE id = ?").run(now, l.id);
  return hit;
}

// Files a ticket has changed in each worktree (committed or not), and paths INTENT.md mentions.
export function ticketPaths(o: { repos: { path: string; worktree: string | null }[]; intent: string; run: Run }): string[] {
  const files = o.repos.flatMap((r) => {
    if (!r.worktree) return [];
    const base = o.run(["git", "-C", r.path, "symbolic-ref", "--short", "HEAD"]).out;
    const from = o.run(["git", "-C", r.worktree, "merge-base", base, "HEAD"]).out;
    return [...o.run(["git", "-C", r.worktree, "diff", "--name-only", from]).out.split("\n"), ...o.run(["git", "-C", r.worktree, "ls-files", "--others", "--exclude-standard"]).out.split("\n")];
  });
  const named = o.intent.match(/[\w@.-]+(?:\/[\w@.-]+)+/g) ?? [];
  return [...new Set([...files, ...named.map((p) => p.replace(/^\.\//, "").replace(/[.,]$/, ""))])].filter(Boolean);
}
