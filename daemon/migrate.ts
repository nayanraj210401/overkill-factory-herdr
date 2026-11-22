// `factory migrate flow-stack`: copies what flow-stack v1 learned into the factory, and
// changes nothing in flow-stack. Shapes (flow-stack's references/conventions.md):
//   ~/.flow-stack/profile.md        front matter, then "# Rules", "# Taste", "# Calibration" sections
//   <repo>/.flow/tasks/<slug>/      INTENT.md (## Goal), SLICES.md, EVIDENCE.md, TRACE.md, PLAYBOOK, DECISIONS.tsv
//   <repo>/.flow/lessons.md         mistakes worth not repeating: bullets ("- text · 2026-10-03") or ## headings
//   <repo>/.flow/ACTIVE             the task still open: not a past task
//   <repo>/.flow/features/<id>.md   the feature map: owns globs and the verify driver's scenario (daemon/features.ts)
//   <repo>/.claude/skills/verify-*/ the verify drivers the scenarios run
//
// The import (past tasks, decisions, lessons) goes into SQLite now, once each, so it is safe
// to run again. The rest is configuration, so only the maintainer writes it: with
// `--propose <request id>` the migration writes it into that request's worktree and folder
// (profile into ACCOUNT-CONFIG.yaml, calibration and the feature map into factory.yaml) and
// MIGRATION.md says what it did and what is left to do. The PR is the gate.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, setMeta } from "./db.ts";
import { addLesson, exportPatch, nearDuplicate } from "./learn.ts";
import { BLUEPRINT, proposeAccount } from "./maintainer.ts";
import { featureFiles, readFeatures, scenarioPaths } from "./features.ts";
import type { Run } from "./runner.ts";
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

// Each lesson with the area of the code it names: the first path in its text, as a
// folder (src/auth/login.ts → src/auth/), else "**", which every ticket loads.
export function readLessons(repo: string): { text: string; area: string }[] | null {
  const p = join(repo, ".flow", "lessons.md");
  if (!existsSync(p)) return null;
  const md = text(p).replace(/<!--[\s\S]*?-->/g, "");
  const items = bullets(md).length ? bullets(md) : md.split("\n").filter((l) => /^##+ \S/.test(l)).map((l) => l.replace(/^#+\s*/, ""));
  return items.map((l) => l.replace(/\s+·\s+\d{4}-\d{2}-\d{2}.*$/, "").trim()).filter(Boolean).map((t) => ({ text: t, area: areaOf(t) }));
}

export function areaOf(lesson: string) {
  const path = lesson.match(/(?:^|[\s`(])((?:\.\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/?)/)?.[1]?.replace(/^\.\//, "").replace(/[.,;:]$/, "");
  if (!path || /^https?:/.test(path)) return "**";
  if (path.endsWith("/") || path.endsWith("/**")) return path;
  const last = path.split("/").at(-1)!;
  return /\.\w+$/.test(last) || last.includes("*") ? `${path.split("/").slice(0, -1).join("/")}/` : `${path}/`;
}

export const countLessons = (repo: string) => readLessons(repo)?.length ?? null;

// flow-stack's taste lines carry a date and a source: "2026-10-02 · prefer early returns · src: reflect".
export const tasteLine = (l: string) => l.replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, "").replace(/\s*·\s*src:.*$/, "").trim();

// The factory's own files for ticket folders keep their names; flow-stack's EVIDENCE.md and STATUS.md would be rewritten by the daemon.
const renamed = (f: string) => (f === "EVIDENCE.md" || f === "STATUS.md" ? f.replace(".md", "-flow.md") : f);

export function migrateFlowStack(db: Database, o: { home: string; repo: string; dir: string; blueprints: string[]; dryRun: boolean; now: string; log: (s: string) => void; propose?: number; run?: Run }) {
  const { log } = o;
  const profilePath = join(o.home, ".flow-stack", "profile.md");
  const profile = existsSync(profilePath) ? parseProfile(text(profilePath)) : null;
  const tasks = readTasks(o.repo);
  const lessons = readLessons(o.repo);
  const flowDir = existsSync(join(o.repo, ".flow"));
  if (!profile && !flowDir) { log("nothing to migrate: no ~/.flow-stack/profile.md and no .flow/ in this repo"); return { tickets: [], decisions: 0, lessons: 0 }; }
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

  // Lessons: into the lesson store, scoped by the area each names; one already there is skipped.
  let added = 0, kept = 0;
  if (lessons === null) log("lessons: none found");
  else {
    for (const l of lessons) {
      if (nearDuplicate(db, l.area, l.text)) { kept++; continue; }
      added++;
      if (!o.dryRun) addLesson(db, { area: l.area, text: l.text, source: "flow-stack", now: o.now });
    }
    log(`lessons: ${lessons.length} found; ${o.dryRun ? "would add" : "added"} ${added} to the lesson store${kept ? `, ${kept} already there` : ""}${lessons.some((l) => l.area !== "**") ? ` (scoped: ${[...new Set(lessons.filter((l) => l.area !== "**").map((l) => l.area))].join(", ")}; the rest load for every ticket)` : ""}`);
  }

  if (profile) {
    const f = profile.front;
    log(`\nproposal from your profile (${o.propose ? "written into the request below" : "nothing is written; the maintainer writes it with --propose <request id>"}):`);
    const map = [f.max_parallel_agents && `max_running: ${f.max_parallel_agents}`, f.build_model && `defaults: { harness: claude, model: ${f.build_model} }`].filter(Boolean);
    for (const l of map) log(`  ${l}`);
    if (f.handoff_at_context_pct) log(`  (handoff at ${f.handoff_at_context_pct}% of context: the factory hands off at 60% and stops at 80% already)`);
    if (profile.rules.length) log(`  rules (${profile.rules.length}), for the agent prompts:\n${profile.rules.map((r) => `    - ${r}`).join("\n")}`);
    if (profile.taste.length) log(`  taste (${profile.taste.length}), for the agent prompts:\n${profile.taste.map((r) => `    - ${tasteLine(r)}`).join("\n")}`);
    if (!map.length && !profile.rules.length && !profile.taste.length) log("  nothing in the profile to carry over");
    if (profile.calibration.length) {
      log("\ncalibration, as default budgets (proposal only):");
      for (const c of profile.calibration) log(`  ${c.type}: ${c.tasks} tasks, avg $ error ${c.dollars}`);
      const ratios = profile.calibration.map((c) => errRatio(c.dollars)).filter((r): r is number => r !== null && r > 1);
      if (ratios.length) log(`  your tasks cost up to ${Math.max(...ratios).toFixed(1)}x their estimate: consider budget.headroom: ${Math.max(...ratios).toFixed(1)} in factory.yaml`);
    } else log("\ncalibration: none recorded yet");
  }
  if (o.propose && !o.dryRun) proposeChanges(db, { ...o, id: o.propose, profile });
  if (o.dryRun) log("\ndry run: nothing was changed");
  return { tickets, decisions, lessons: added };
}

// ---- --propose <id>: the configuration, written into the maintainer's request ---------

// The profile's rules and taste merged into an account config's text: what's there stays,
// new lines are added, the rest of the file (and its comments) is untouched.
export function withProfile(yaml: string, rules: string[], taste: string[]) {
  const doc = (Bun.YAML.parse(yaml) ?? {}) as { profile?: { rules?: string[]; taste?: string[] } };
  const union = (a: string[] = [], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))];
  const r = union(doc.profile?.rules, rules), t = union(doc.profile?.taste, taste);
  if (r.length === (doc.profile?.rules?.length ?? 0) && t.length === (doc.profile?.taste?.length ?? 0)) return yaml;
  const list = (k: string, xs: string[]) => (xs.length ? [`  ${k}:`, ...xs.map((x) => `    - ${JSON.stringify(x)}`)] : []);
  const block = ["profile:   # in every stage brief (migrated from flow-stack)", ...list("rules", r), ...list("taste", t)];
  const lines = yaml.replace(/\n*$/, "").split("\n");
  const at = lines.findIndex((l) => /^profile:/.test(l));
  if (at < 0) return [...(lines.length === 1 && lines[0] === "" ? [] : lines), ...block, ""].join("\n");
  let end = at + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) end++;
  return [...lines.slice(0, at), ...block, ...lines.slice(end), ""].join("\n");
}

// One setting at a time, as `factory learn export` writes it: a path through an inline map comes back as a note.
function setKey(o: { worktree: string; folder: string; run: Run }, key: string, value: unknown): string | null {
  const { patch, notes } = exportPatch(o.worktree, [{ key, value, reason: null, at: "" }]);
  if (!patch) return notes[0] ?? `${key}: nothing to change`;
  const file = join(o.folder, ".migration.patch");
  writeFileSync(file, `${patch}\n`);
  const r = o.run(["git", "-C", o.worktree, "apply", "--unidiff-zero", file]);
  return r.code === 0 ? null : `${key}: git apply failed: ${r.out.slice(0, 120)}`;
}

const tracked = (run: Run, repo: string, path: string) => run(["git", "-C", repo, "ls-files", "--error-unmatch", path]).code === 0;

export function proposeChanges(db: Database, o: { dir: string; repo: string; id: number; profile: Profile | null; now: string; log: (s: string) => void; run?: Run }) {
  const run = o.run ?? ((argv, cwd) => { const r = Bun.spawnSync(argv, { cwd }); return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() }; });
  const t = db.query("SELECT blueprint, worktree, state FROM ticket_lead WHERE id = ?").get(o.id) as { blueprint: string; worktree: string | null; state: string } | null;
  if (!t || t.blueprint !== BLUEPRINT) throw new Error(`#${o.id} isn't a request for the maintainer`);
  if (!t.worktree || !existsSync(t.worktree)) throw new Error(`#${o.id} has no worktree; the maintainer runs --propose from its own ticket`);
  if (!existsSync(join(t.worktree, ".factory", "factory.yaml"))) throw new Error(`#${o.id}'s worktree has no .factory/factory.yaml to write into`);
  const folder = join(o.dir, "tickets", String(o.id));
  mkdirSync(folder, { recursive: true });
  const done: string[] = [], todo: string[] = [];
  const ctx = { worktree: t.worktree, folder, run };
  const set = (key: string, value: unknown, why: string) => {
    const note = setKey(ctx, key, value);
    if (note) todo.push(`Set \`${key}: ${value}\` in factory.yaml by hand (${why}): ${note}`);
    else done.push(`\`${key}: ${value}\` in factory.yaml (${why})`);
  };

  // Profile rules and taste: the account config's profile, which every stage brief reads.
  const p = o.profile;
  if (p && (p.rules.length || p.taste.length)) {
    const file = proposeAccount(o.dir, o.id);
    writeFileSync(file, withProfile(readFileSync(file, "utf8"), p.rules, p.taste.map(tasteLine)));
    done.push(`Profile: ${p.rules.length} rules and ${p.taste.length} taste lines in the account config's \`profile:\`, which every stage brief reads (ACCOUNT-CONFIG.yaml; applied when this merges)`);
  }
  // The front matter and the calibration: factory.yaml.
  if (p?.front.max_parallel_agents && /^\d+$/.test(p.front.max_parallel_agents)) set("max_running", Number(p.front.max_parallel_agents), "the profile's max_parallel_agents");
  if (p?.front.build_model) todo.push(`The profile builds with \`${p.front.build_model}\`: set \`defaults.model\` (or the builder agent's \`model\`) if that is still what you want`);
  const ratios = (p?.calibration ?? []).map((c) => errRatio(c.dollars)).filter((r): r is number => r !== null && r > 1);
  if (ratios.length) set("budget.headroom", +Math.max(...ratios).toFixed(1), `the calibration: tasks cost up to ${Math.max(...ratios).toFixed(1)}x their estimate`);

  // The feature map and verify drivers: the verify stage runs the scenarios of the features a
  // ticket touches. Wired only when every scenario's driver is in git, so a worktree has it.
  const features = readFeatures(join(o.repo, ".flow", "features"));
  const drivers = existsSync(join(o.repo, ".claude", "skills")) ? readdirSync(join(o.repo, ".claude", "skills")).filter((d) => d.startsWith("verify-")).map((d) => `.claude/skills/${d}`) : [];
  if (features.length) {
    const missing = features.filter((f) => f.scenario).flatMap((f) => scenarioPaths(f.scenario).filter((x) => !tracked(run, o.repo, x)).map((x) => `${f.id}: ${x}`));
    const noScenario = features.filter((f) => !f.scenario).map((f) => f.id);
    const withScenario = features.filter((f) => f.scenario).length;
    if (!withScenario) todo.push(`The feature map (${features.length} features) has no scenarios yet, so verify has nothing to run: write a verify driver (flow-stack's make-verifier), then ask again`);
    else if (missing.length) todo.push(`Not wired into verify: these scenarios use files that aren't committed, so a ticket's worktree can't run them: ${missing.join(", ")}. Commit the verify driver${drivers.length ? ` (${drivers.join(", ")})` : ""}, then ask again`);
    else {
      let dir = ".flow/features";
      if (!tracked(run, o.repo, ".flow/features")) {
        // Not in git: a copy under .factory/ goes with the PR, so every worktree has it.
        dir = ".factory/features";
        mkdirSync(join(t.worktree, dir), { recursive: true });
        for (const f of featureFiles(join(o.repo, ".flow", "features"))) copyFileSync(join(o.repo, ".flow", "features", f), join(t.worktree, dir, f));
      }
      set("verify.features", dir, `${withScenario} feature scenario${withScenario === 1 ? "" : "s"}${drivers.length ? ` driven by ${drivers.join(", ")}` : ""}; a ticket runs the ones whose owns: globs it touches`);
      if (dir === ".factory/features") done.push(`Copied the feature map into .factory/features/ (.flow/features isn't in git); flow-stack's own copy is unchanged`);
      if (noScenario.length) todo.push(`Features with no scenario, so verify can't prove them yet: ${noScenario.join(", ")}`);
    }
  } else if (drivers.length) todo.push(`Verify drivers without a feature map (${drivers.join(", ")}): add their commands to quality_floor, or map the features first`);

  const imported = db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'flow_import:%'").get() as { n: number };
  const lessons = db.query("SELECT COUNT(*) AS n FROM lessons WHERE source = 'flow-stack'").get() as { n: number };
  const md = [
    "## Migrated from flow-stack", "",
    `Imported into the factory's database (already, once each): ${imported.n} past tasks as merged tickets with their decisions, and ${lessons.n} lessons in the lesson store.`, "",
    "### In this change", "", ...(done.length ? done.map((d) => `- ${d}`) : ["- Nothing to change in the configuration."]), "",
    "### Left to do", "", ...(todo.length ? todo.map((d) => `- ${d}`) : ["- Nothing."]), "",
  ].join("\n");
  writeFileSync(join(folder, "MIGRATION.md"), md);
  o.log(`\nwritten for #${o.id}:\n${done.map((d) => `  ✓ ${d}`).join("\n") || "  nothing to change"}${todo.length ? `\nleft to do (in MIGRATION.md):\n${todo.map((d) => `  - ${d}`).join("\n")}` : ""}`);
  return { done, todo };
}
