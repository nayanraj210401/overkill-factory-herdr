// Housekeeping (plan: Changing the factory). `factory cleanup --dry-run` lists what the
// factory would remove. When the person asks for a cleanup, the maintainer writes the list
// (`--propose`: <factory>/cleanup/CLEANUP.md to read, CLEANUP.json to narrow), and runs it
// (`--run`), which removes what the list holds, each entry re-checked as safe right then.
// What it may remove:
//
//   - tickets closed or merged more than N days ago (14 by default): their worktrees, their
//     Herdr spaces and finished terminals (hc), their factory branches already merged,
//     local and on origin, and with --folders their ticket folders;
//   - factory worktrees under the worktree root that no ticket owns;
//   - backups older than N days (<FACTORY_HOME>/backups/, and the config.yaml.bak-* and
//     agents' *.md.bak-* left from before), the newest of each file always kept;
//   - a VACUUM of the database.
//
// What it never removes: a branch that isn't merged, a worktree with uncommitted changes,
// anything a ticket that is still open (queued, running, parked, ready…) owns, a worktree
// on a branch the factory didn't make, and ticket folders unless asked. It is idempotent:
// running re-checks every entry, and one already gone is simply done.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { accountFile } from "./account.ts";
import { factoryAgentsDir } from "./agents.ts";
import { backupsByFile } from "./maintainer.ts";
import { closeSpace, worktreeRoot } from "./herdr.ts";
import type { Run } from "./runner.ts";

export type Item =
  | { kind: "terminal"; ticket: number; terminal: string }
  | { kind: "space"; ticket: number; space: string }
  | { kind: "worktree"; ticket: number | null; repo: string; repoPath: string; path: string }
  | { kind: "branch"; ticket: number; repo: string; repoPath: string; name: string; sha: string; merged: string }
  | { kind: "remote-branch"; ticket: number; repo: string; repoPath: string; name: string; sha: string; merged: string }
  | { kind: "folder"; ticket: number; path: string }
  | { kind: "backup"; path: string }
  | { kind: "vacuum" };
export type Kept = { key: string; what: string; why: string };
export type Plan = { days: number; folders: boolean; items: Item[]; kept: Kept[] };

export const CLEANUP_MD = "CLEANUP.md";
export const CLEANUP_JSON = "CLEANUP.json";
export const DEFAULT_DAYS = 14;
export const cleanupDir = (dir: string) => join(dir, "cleanup");
// The order things go in: a branch can't be deleted while a worktree has it checked out.
const ORDER: Item["kind"][] = ["terminal", "space", "worktree", "branch", "remote-branch", "folder", "backup", "vacuum"];

const folderOf = (dir: string, id: number) => join(dir, "tickets", String(id));

export function keyOf(i: Item) {
  switch (i.kind) {
    case "terminal": return `terminal:${i.terminal}`;
    case "space": return `space:${i.space}`;
    case "worktree": return `worktree:${i.path}`;
    case "branch": return `branch:${i.repo}:${i.name}`;
    case "remote-branch": return `remote-branch:${i.repo}:${i.name}`;
    case "folder": return `folder:${i.path}`;
    case "backup": return `backup:${i.path}`;
    case "vacuum": return "vacuum";
  }
}

export function describe(i: Item) {
  const of = "ticket" in i && i.ticket != null ? ` (#${i.ticket})` : "";
  switch (i.kind) {
    case "terminal": return `the finished terminal ${i.terminal}${of}`;
    case "space": return `the Herdr space ${i.space}${of}`;
    case "worktree": return `the worktree ${i.path} in ${i.repo}${i.ticket == null ? ", which no ticket owns" : of}`;
    case "branch": return `the branch ${i.name} in ${i.repo}${of}: ${i.merged}`;
    case "remote-branch": return `the branch ${i.name} on ${i.repo}'s origin${of}: ${i.merged}`;
    case "folder": return `the ticket folder ${i.path}${of}`;
    case "backup": return `the backup ${i.path}`;
    case "vacuum": return "a VACUUM of the database (compacts it; removes nothing)";
  }
}

type Row = { id: number; state: string; updated_at: string; space: string | null };
type Work = { ticket: number; repo: string; path: string; worktree: string | null; branch: string | null; pr_number: number | null; merged_at: string | null };

// git prints real paths (/private/var/… on macOS); the database has the ones the factory made.
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const git = (run: Run, path: string, ...args: string[]) => run(["git", "-C", path, ...args]);
const dirty = (run: Run, wt: string) => {
  const r = git(run, wt, "status", "--porcelain");
  return r.code !== 0 || r.out.trim() !== "";
};

// The branch tickets merge into: origin's HEAD, else the checkout's own branch.
function mainOf(run: Run, path: string) {
  const r = git(run, path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (r.code === 0 && r.out.trim()) return r.out.trim();
  return git(run, path, "symbolic-ref", "--short", "HEAD").out.trim() || "HEAD";
}

// Why this commit of the ticket's branch is merged, or null. Squash merges leave no
// ancestry, so a PR GitHub reports merged at exactly this head counts too.
function mergedWhy(run: Run, w: Work, sha: string, cache: Map<string, { state: string; head: string } | null>): string | null {
  const main = mainOf(run, w.path);
  if (git(run, w.path, "merge-base", "--is-ancestor", sha, main).code === 0) return `merged into ${main}`;
  if (w.pr_number == null) return null;
  const k = `${w.repo}#${w.pr_number}`;
  if (!cache.has(k)) {
    const r = run(["gh", "pr", "view", String(w.pr_number), "--json", "state,headRefOid"], w.path);
    let v: { state: string; head: string } | null = null;
    try { const j = JSON.parse(r.out); v = r.code === 0 ? { state: j.state, head: j.headRefOid } : null; } catch {}
    cache.set(k, v);
  }
  const pr = cache.get(k);
  return pr?.state === "MERGED" && pr.head === sha ? `PR #${w.pr_number} merged at this commit` : null;
}

// Every backup of a file the maintainer changed: older than the cutoff, never the newest.
function backups(cutoff: number) {
  const out: string[] = [];
  const groups = new Map<string, { path: string; at: number }[]>();
  for (const [file, g] of backupsByFile()) groups.set(file, g.map((b) => ({ path: b.path, at: statSync(b.path).mtimeMs })));
  // Beside the file: how the account config and factory agents were backed up before.
  for (const [folder, re] of [[dirname(accountFile()), /^(config\.yaml)\.bak-/], [factoryAgentsDir(), /^(.+\.md)\.bak-/]] as const) {
    if (!existsSync(folder)) continue;
    for (const f of readdirSync(folder)) {
      const m = f.match(re);
      if (!m) continue;
      const path = join(folder, f);
      const g = groups.get(join(folder, m[1])) ?? [];
      g.push({ path, at: statSync(path).mtimeMs });
      groups.set(join(folder, m[1]), g);
    }
  }
  for (const g of groups.values()) {
    g.sort((a, b) => b.at - a.at);
    out.push(...g.slice(1).filter((b) => b.at < cutoff).map((b) => b.path));
  }
  return out.sort();
}

// What a cleanup would remove now, and what it keeps and why. Reads only.
export function cleanupPlan(db: Database, o: { dir: string; run: Run; now: string; days?: number; folders?: boolean }): Plan {
  const days = o.days ?? DEFAULT_DAYS;
  if (!Number.isFinite(days) || days < 0) throw new Error("--days takes a number of days, like --days 14");
  const cutoff = Date.parse(o.now) - days * 86_400_000;
  const items: Item[] = [];
  const kept: Kept[] = [];
  const keep = (key: string, what: string, why: string) => kept.push({ key, what, why });
  const tickets = db.query("SELECT id, state, updated_at, space FROM tickets").all() as Row[];
  const work = db.query("SELECT tr.ticket, tr.repo, r.path, tr.worktree, tr.branch, tr.pr_number, tr.merged_at FROM ticket_repos tr JOIN repos r ON r.slug = tr.repo").all() as Work[];
  const finished = new Set(tickets.filter((t) => t.state === "merged" || t.state === "closed").map((t) => t.id));
  const old = tickets.filter((t) => finished.has(t.id) && Date.parse(t.updated_at) < cutoff);
  // What an open ticket owns is never touched, whatever else claims it.
  const open = work.filter((w) => !finished.has(w.ticket));
  const openWorktrees = new Set(open.flatMap((w) => (w.worktree ? [real(w.worktree)] : [])));
  const openBranches = new Map(open.flatMap((w) => (w.branch ? [[`${w.repo}:${w.branch}`, w.ticket] as const] : [])));
  const openSpaces = new Set(tickets.filter((t) => !finished.has(t.id) && t.space).map((t) => t.space!));
  const cache = new Map<string, { state: string; head: string } | null>();

  for (const t of old) {
    const live = new Set((db.query("SELECT terminal FROM sessions WHERE ticket = ? AND terminal IS NOT NULL AND ended_at IS NULL").all(t.id) as { terminal: string }[]).map((s) => s.terminal));
    for (const { terminal } of db.query("SELECT DISTINCT terminal FROM sessions WHERE ticket = ? AND terminal IS NOT NULL").all(t.id) as { terminal: string }[]) {
      if (live.has(terminal)) keep(`terminal:${terminal}`, `the terminal ${terminal} (#${t.id})`, "its session never ended");
      else items.push({ kind: "terminal", ticket: t.id, terminal });
    }
    if (t.space && !openSpaces.has(t.space)) items.push({ kind: "space", ticket: t.id, space: t.space });
    for (const w of work.filter((x) => x.ticket === t.id)) {
      let stays = false; // a worktree that stays keeps its branch, here and on origin
      if (w.worktree && existsSync(w.worktree)) {
        stays = true;
        if (openWorktrees.has(real(w.worktree))) keep(`worktree:${w.worktree}`, `the worktree ${w.worktree}`, "an open ticket works in it");
        else if (dirty(o.run, w.worktree)) keep(`worktree:${w.worktree}`, `the worktree ${w.worktree} (#${t.id})`, "it has uncommitted changes");
        else { items.push({ kind: "worktree", ticket: t.id, repo: w.repo, repoPath: w.path, path: w.worktree }); stays = false; }
      }
      // Only the branches the factory made (factory/<id>-…), and only once they're merged.
      if (!w.branch?.startsWith("factory/")) continue;
      if (stays) {
        keep(`branch:${w.repo}:${w.branch}`, `the branch ${w.branch} in ${w.repo} (#${t.id})`, "its worktree stays");
        continue;
      }
      const owner = openBranches.get(`${w.repo}:${w.branch}`);
      const local = git(o.run, w.path, "rev-parse", "--verify", "-q", `refs/heads/${w.branch}`);
      if (local.code === 0) {
        const sha = local.out.trim();
        const why = owner == null ? mergedWhy(o.run, w, sha, cache) : null;
        if (owner != null) keep(`branch:${w.repo}:${w.branch}`, `the branch ${w.branch} in ${w.repo}`, `#${owner} is still open on it`);
        else if (!why) keep(`branch:${w.repo}:${w.branch}`, `the branch ${w.branch} in ${w.repo} (#${t.id})`, "it isn't merged");
        else items.push({ kind: "branch", ticket: t.id, repo: w.repo, repoPath: w.path, name: w.branch, sha, merged: why });
      }
      const remote = git(o.run, w.path, "ls-remote", "--heads", "origin", w.branch);
      const rsha = remote.code === 0 ? remote.out.trim().split(/\s+/)[0] : "";
      if (rsha) {
        const why = owner == null ? mergedWhy(o.run, w, rsha, cache) : null;
        if (owner != null) keep(`remote-branch:${w.repo}:${w.branch}`, `the branch ${w.branch} on ${w.repo}'s origin`, `#${owner} is still open on it`);
        else if (!why) keep(`remote-branch:${w.repo}:${w.branch}`, `the branch ${w.branch} on ${w.repo}'s origin (#${t.id})`, "it isn't merged");
        else items.push({ kind: "remote-branch", ticket: t.id, repo: w.repo, repoPath: w.path, name: w.branch, sha: rsha, merged: why });
      }
    }
    if (o.folders && existsSync(folderOf(o.dir, t.id))) items.push({ kind: "folder", ticket: t.id, path: folderOf(o.dir, t.id) });
  }

  // Factory worktrees no ticket owns: a start that failed, a ticket deleted by hand.
  const root = real(worktreeRoot());
  const owned = new Set(work.flatMap((w) => (w.worktree ? [real(w.worktree)] : [])));
  const listed = new Set(items.flatMap((i) => (i.kind === "worktree" ? [real(i.path)] : [])));
  for (const r of db.query("SELECT slug, path FROM repos").all() as { slug: string; path: string }[]) {
    const out = git(o.run, r.path, "worktree", "list", "--porcelain");
    if (out.code !== 0) continue;
    for (const block of out.out.split(/\n\s*\n/)) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
      if (!path || !(real(path) + sep).startsWith(root + sep) || real(path) === root || owned.has(real(path)) || listed.has(real(path))) continue;
      if (!branch?.startsWith("factory/")) { keep(`worktree:${path}`, `the worktree ${path}`, "the factory didn't make its branch"); continue; }
      const owner = openBranches.get(`${r.slug}:${branch}`);
      if (owner != null) keep(`worktree:${path}`, `the worktree ${path}`, `#${owner} is still open on its branch`);
      else if (existsSync(path) && dirty(o.run, path)) keep(`worktree:${path}`, `the worktree ${path}`, "it has uncommitted changes");
      else items.push({ kind: "worktree", ticket: null, repo: r.slug, repoPath: r.path, path });
    }
  }
  for (const path of backups(cutoff)) items.push({ kind: "backup", path });
  items.push({ kind: "vacuum" });
  items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { days, folders: !!o.folders, items, kept };
}

export function planMarkdown(p: Plan, heading = "Cleanup") {
  return [
    `# ${heading}`, "",
    `What the cleanup removes when it runs (factory cleanup --run): tickets closed or merged more than ${p.days} day${p.days === 1 ? "" : "s"} ago, factory worktrees no ticket owns, old backups.${p.folders ? " Ticket folders too, as asked." : " Ticket folders and their .md files stay."}`, "",
    "## Removes", "", ...(p.items.length ? p.items.map((i) => `- ${describe(i)}`) : ["Nothing."]), "",
    "## Keeps", "", ...(p.kept.length ? p.kept.map((k) => `- ${k.what}: ${k.why}`) : ["Nothing it looked at needed keeping."]), "",
  ].join("\n");
}

// `factory cleanup --propose`: the list, in the factory's cleanup/ folder. Delete entries from
// CLEANUP.json to narrow it to what was asked.
export function proposeCleanup(db: Database, o: { dir: string; run: Run; now: string; days?: number; folders?: boolean }) {
  const p = cleanupPlan(db, o);
  const folder = cleanupDir(o.dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, CLEANUP_JSON), JSON.stringify(p, null, 2) + "\n");
  writeFileSync(join(folder, CLEANUP_MD), planMarkdown(p));
  return p;
}

const readPlan = (file: string): Plan | null => {
  try { return JSON.parse(readFileSync(file, "utf8")) as Plan; } catch { return null; }
};

// `factory cleanup --run`: removes what the proposed list holds, each entry re-checked now; one
// no longer safe to remove is kept and said. The list is then set aside, so a second run
// needs a new list.
export function performCleanup(db: Database, o: { dir: string; run: Run; now: string; who?: string }) {
  const folder = cleanupDir(o.dir);
  const file = join(folder, CLEANUP_JSON);
  if (!existsSync(file)) throw new Error("no cleanup list: run factory cleanup --propose first, then narrow CLEANUP.json to what was asked");
  const asked = readPlan(file);
  if (!asked || !Array.isArray(asked.items)) throw new Error(`${file} isn't a cleanup list; run factory cleanup --propose again`);
  const fresh = cleanupPlan(db, { dir: o.dir, run: o.run, now: o.now, days: asked.days, folders: asked.folders });
  const byKey = new Map(fresh.items.map((i) => [keyOf(i), i]));
  const done: string[] = [], skipped: string[] = [], gone: string[] = [];
  let vacuum = false;
  for (const a of asked.items) {
    const i = byKey.get(keyOf(a));
    if (!i) {
      const k = fresh.kept.find((x) => x.key === keyOf(a));
      (k ? skipped : gone).push(k ? `${describe(a)}: kept, ${k.why}` : describe(a));
      continue;
    }
    // A branch that moved since the list was written isn't the one listed.
    if ((i.kind === "branch" || i.kind === "remote-branch") && a.kind === i.kind && a.sha !== i.sha) { skipped.push(`${describe(i)}: kept, it moved after the list was written`); continue; }
    const r = remove(db, o.run, i);
    (r ? skipped : done).push(r ? `${describe(i)}: ${r}` : describe(i));
    if (!r && i.kind === "vacuum") vacuum = true;
  }
  const summary = `${done.length} removed${skipped.length ? `, ${skipped.length} kept` : ""}${gone.length ? `, ${gone.length} already gone` : ""}`;
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (NULL, ?, 'cleaned up', ?, ?)").run(o.who ?? "you", summary, o.now);
  const md = existsSync(join(folder, CLEANUP_MD)) ? readFileSync(join(folder, CLEANUP_MD), "utf8").trimEnd() : planMarkdown(asked);
  writeFileSync(join(folder, CLEANUP_MD), [md, "",
    `## Done · ${o.now.slice(0, 16).replace("T", " ")}`, "", summary + ".", "",
    ...done.map((d) => `- removed ${d}`), ...skipped.map((s) => `- ${s}`), ...gone.map((g) => `- already gone: ${g}`), ""].join("\n"));
  renameSync(file, join(folder, `CLEANUP.done-${o.now.replace(/[^0-9]/g, "").slice(0, 14)}.json`));
  return { done, skipped, vacuum, summary };
}

// One entry; null when it's gone, else why it stayed.
function remove(db: Database, run: Run, i: Item): string | null {
  const fail = (r: { code: number; out: string }) => (r.code === 0 ? null : `kept, ${r.out.split("\n")[0].slice(0, 120) || `exit ${r.code}`}`);
  switch (i.kind) {
    case "terminal": {
      // hc rm removes only a finished terminal; one that's gone already is done.
      const r = run(["hc", "rm", i.terminal]);
      return r.code === 0 || /no such|not found|unknown/i.test(r.out) ? null : fail(r);
    }
    case "space":
      closeSpace(run, i.space);
      db.query("UPDATE tickets SET space = NULL WHERE id = ? AND space = ?").run(i.ticket, i.space);
      return null;
    case "worktree": {
      // No --force: git refuses a worktree with changes, a second guard on the check above.
      const r = existsSync(i.path) ? git(run, i.repoPath, "worktree", "remove", i.path) : git(run, i.repoPath, "worktree", "prune");
      if (r.code === 0) for (const w of db.query("SELECT ticket, repo, worktree FROM ticket_repos WHERE worktree IS NOT NULL").all() as { ticket: number; repo: string; worktree: string }[])
        if (real(w.worktree) === real(i.path) || w.worktree === i.path) db.query("UPDATE ticket_repos SET worktree = NULL WHERE ticket = ? AND repo = ?").run(w.ticket, w.repo);
      return fail(r);
    }
    case "branch": return fail(git(run, i.repoPath, "branch", "-D", i.name)); // -D: a squash merge isn't an ancestor; merged was checked
    case "remote-branch": return fail(git(run, i.repoPath, "push", "origin", "--delete", i.name));
    case "folder": rmSync(i.path, { recursive: true, force: true }); return null;
    case "backup": rmSync(i.path, { force: true }); return null;
    case "vacuum": return null; // the caller runs it, outside any transaction
  }
}
