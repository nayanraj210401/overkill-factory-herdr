// `factory migrate flow-stack`: copies what flow-stack v1 learned into the factory, and
// changes nothing in flow-stack. Shapes (flow-stack's references/conventions.md):
//   ~/.flow-stack/profile.md        front matter, then "# Rules", "# Taste", "# Calibration" sections
//   <repo>/.flow/tasks/<slug>/      INTENT.md (## Goal), SLICES.md, EVIDENCE.md, TRACE.md, PLAYBOOK, DECISIONS.tsv
//   <repo>/.flow/lessons.md         mistakes worth not repeating (the factory's lesson store imports these later)
//   <repo>/.flow/ACTIVE             the task still open: not a past task
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMeta, setMeta } from "./db.ts";
import { LOCAL_IDS } from "./intake.ts";

export type Profile = { front: Record<string, string>; rules: string[]; taste: string[]; calibration: { type: string; tasks: string; dollars: string }[] };
export type FlowTask = { slug: string; dir: string; title: string; blueprint: string | null; decisions: { at: string; who: string; what: string; why: string | null }[]; files: string[]; updated_at: string };

const text = (p: string) => readFileSync(p, "utf8");
const bullets = (s: string) => s.split("\n").filter((l) => /^\s*[-*] \S/.test(l)).map((l) => l.replace(/^\s*[-*] /, "").trim());

export function parseProfile(md: string): Profile {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const front: Record<string, string> = {};
  for (const l of (m?.[1] ?? "").split("\n")) {
    const kv = l.match(/^\s*(\w+):\s*([^#\n]*?)\s*(#.*)?$/);
    if (kv && kv[2]) front[kv[1]] = kv[2];
  }
  const body = (m?.[2] ?? md).replace(/<!--[\s\S]*?-->/g, "");
  const section = (name: string) => body.match(new RegExp(`^# ${name}\\s*\\n([\\s\\S]*?)(?=^# |$(?![\\s\\S]))`, "m"))?.[1] ?? "";
  const calibration = section("Calibration").split("\n").filter((l) => l.startsWith("|")).slice(2)
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((c) => c.length >= 3 && c[0]).map((c) => ({ type: c[0], tasks: c[1], dollars: c[2] }));
  return { front, rules: bullets(section("Rules")), taste: bullets(section("Taste")), calibration };
}

// "+60%", "1.6x" or "1.6×" as a ratio of actual to estimate; null when it can't tell.
export function errRatio(cell: string): number | null {
  const pct = cell.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (pct) return 1 + Number(pct[1]) / 100;
  const x = cell.match(/^(\d+(?:\.\d+)?)\s*[x×]$/i);
  return x ? Number(x[1]) : null;
}

export function readTasks(repo: string): FlowTask[] {
  const root = join(repo, ".flow", "tasks");
  if (!existsSync(root)) return [];
  const active = existsSync(join(repo, ".flow", "ACTIVE")) ? text(join(repo, ".flow", "ACTIVE")).split("\n")[0].trim().replace(/^@.*:/, "") : "";
  return readdirSync(root).filter((s) => s !== active && statSync(join(root, s)).isDirectory()).sort().map((slug) => {
    const dir = join(root, slug);
    const intent = existsSync(join(dir, "INTENT.md")) ? text(join(dir, "INTENT.md")).replace(/<!--[\s\S]*?-->/g, "") : "";
    const goal = intent.match(/^## Goal\s*\n+([^\n#][^\n]*)/m)?.[1].trim();
    const play = existsSync(join(dir, "PLAYBOOK")) ? text(join(dir, "PLAYBOOK")).split("\n")[0].trim() : "";
    const rows = existsSync(join(dir, "DECISIONS.tsv")) ? text(join(dir, "DECISIONS.tsv")).split("\n").slice(1) : [];
    const decisions = rows.map((r) => r.split("\t")).filter((c) => c.length >= 3 && c[0] && c[2])
      .map((c) => ({ at: c[0], who: c[1] || "agent", what: c[2], why: [c[3], c[4] && `evidence: ${c[4]}`].filter(Boolean).join(" · ") || null }));
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") || f === "DECISIONS.tsv");
    return { slug, dir, title: goal || slug, blueprint: play || null, decisions, files, updated_at: decisions.at(-1)?.at ?? statSync(dir).mtime.toISOString() };
  });
}

export function countLessons(repo: string): number | null {
  const p = join(repo, ".flow", "lessons.md");
  if (!existsSync(p)) return null;
  const md = text(p).replace(/<!--[\s\S]*?-->/g, "");
  const n = bullets(md).length;
  return n || md.split("\n").filter((l) => /^##+ \S/.test(l)).length;
}

// The factory's own files for ticket folders keep their names; flow-stack's EVIDENCE.md and STATUS.md would be rewritten by the daemon.
const renamed = (f: string) => (f === "EVIDENCE.md" || f === "STATUS.md" ? f.replace(".md", "-flow.md") : f);

export function migrateFlowStack(db: Database, o: { home: string; repo: string; dir: string; blueprints: string[]; dryRun: boolean; now: string; log: (s: string) => void }) {
  const { log } = o;
  const profilePath = join(o.home, ".flow-stack", "profile.md");
  const profile = existsSync(profilePath) ? parseProfile(text(profilePath)) : null;
  const tasks = readTasks(o.repo);
  const lessons = countLessons(o.repo);
  const flowDir = existsSync(join(o.repo, ".flow"));
  if (!profile && !flowDir) { log("nothing to migrate: no ~/.flow-stack/profile.md and no .flow/ in this repo"); return { tickets: [], decisions: 0 }; }
  log(`found: ${profile ? "~/.flow-stack/profile.md" : "no profile"}, ${flowDir ? `.flow/ with ${tasks.length} past task${tasks.length === 1 ? "" : "s"}` : "no .flow/"}`);

  // Past tasks: merged tickets with their .md files, and their decisions.
  const tickets: { id: number; slug: string }[] = [];
  let decisions = 0;
  let next = ((db.query("SELECT MAX(id) AS m FROM tickets WHERE id >= ?").get(LOCAL_IDS) as { m: number | null }).m ?? LOCAL_IDS - 1) + 1;
  for (const t of tasks) {
    const known = getMeta(db, `flow_import:${t.slug}`);
    if (known) { log(`  ${t.slug}: already imported as #${known}`); continue; }
    const id = next++;
    log(`  ${o.dryRun ? "would import" : "imported"} ${t.slug} as merged #${id}: ${t.title} (${t.decisions.length} decisions, ${t.files.length} files)`);
    tickets.push({ id, slug: t.slug });
    decisions += t.decisions.length;
    if (o.dryRun) continue;
    const blueprint = t.blueprint && o.blueprints.includes(t.blueprint) ? t.blueprint : "feature";
    const at = Number.isNaN(Date.parse(t.updated_at)) ? o.now : new Date(t.updated_at).toISOString();
    db.query("INSERT INTO tickets (id, title, state, blueprint, updated_at) VALUES (?, ?, 'merged', ?, ?)").run(id, t.title, blueprint, at);
    for (const d of t.decisions)
      db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(id, d.who, d.what, d.why, Number.isNaN(Date.parse(d.at)) ? o.now : new Date(d.at).toISOString());
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'daemon', ?, ?)").run(id, `imported from flow-stack task ${t.slug}`, o.now);
    const folder = join(o.dir, "tickets", String(id));
    mkdirSync(folder, { recursive: true });
    for (const f of t.files) copyFileSync(join(t.dir, f), join(folder, renamed(f)));
    setMeta(db, `flow_import:${t.slug}`, String(id));
  }

  if (lessons === null) log("lessons: none found");
  else log(`lessons: ${lessons} found, imported once the lesson store lands`);

  if (profile) {
    const f = profile.front;
    log("\nproposal from your profile (nothing is written to factory.yaml; copy what you want):");
    const map = [f.max_parallel_agents && `max_running: ${f.max_parallel_agents}`, f.build_model && `defaults: { harness: claude, model: ${f.build_model} }`].filter(Boolean);
    for (const l of map) log(`  ${l}`);
    if (f.handoff_at_context_pct) log(`  (handoff at ${f.handoff_at_context_pct}% of context: the factory hands off at 60% and stops at 80% already)`);
    if (profile.rules.length) log(`  rules (${profile.rules.length}), for the agent prompts:\n${profile.rules.map((r) => `    - ${r}`).join("\n")}`);
    if (profile.taste.length) log(`  taste (${profile.taste.length}), for the agent prompts:\n${profile.taste.map((r) => `    - ${r}`).join("\n")}`);
    if (!map.length && !profile.rules.length && !profile.taste.length) log("  nothing in the profile to carry over");
    if (profile.calibration.length) {
      log("\ncalibration, as default budgets (proposal only):");
      for (const c of profile.calibration) log(`  ${c.type}: ${c.tasks} tasks, avg $ error ${c.dollars}`);
      const ratios = profile.calibration.map((c) => errRatio(c.dollars)).filter((r): r is number => r !== null && r > 1);
      if (ratios.length) log(`  your tasks cost up to ${Math.max(...ratios).toFixed(1)}x their estimate: consider budget.headroom: ${Math.max(...ratios).toFixed(1)} in factory.yaml`);
    } else log("\ncalibration: none recorded yet");
  }
  if (o.dryRun) log("\ndry run: nothing was changed");
  return { tickets, decisions };
}
