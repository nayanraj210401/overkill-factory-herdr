// The maintainer (plan: Changing the factory) owns every change to the factory itself. A
// request, from you in Overwatch or from the learner, is a ticket on the shipped `factory`
// blueprint, and it is one of five kinds:
//
//   config     .factory/ in any of the factory's repos (budgets, gates, rules, prompts), and the
//              account config, ~/.factory/config.yaml
//   blueprint  a new blueprint from a description, or an edit to one, with a dry run
//   agents     a repo agent in any of the factory's repos, or a factory agent (~/.factory/agents/)
//   cleanup    housekeeping: old tickets' worktrees, spaces and merged branches, orphaned
//              worktrees, old backups, a VACUUM (cleanup.ts)
//   look       the factory's pages and colours: a PR against the factory app's own repo
//
// The maintainer works in its own worktree of the request's repo. Files no repo holds (the
// account config, the factory agents) are edited as proposed copies in the ticket's folder.
// The factory check proves the change, and it comes back as a PR you merge (maintainer.gate);
// what lives outside a repo (proposals, a cleanup) is applied by the daemon only then.
// A request skips grooming: whoever asked already agreed, or brought the evidence.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { accountFile, factoryAgentsDir } from "./account.ts";
import { listRepos, setMeta, type Repo } from "./db.ts";
import { newTicket } from "./intake.ts";
import type { Run } from "./runner.ts";
import { KINDS as SCHEMA, validateAccount, validateFile } from "./validate.ts";
import { cleanupPending, performCleanup } from "./cleanup.ts";

export const BLUEPRINT = "factory";

// Who asked: you (in Overwatch, or `factory request`), or the learner with its evidence.
export type From = "you" | "learner";
const TRIGGER: Record<From, string> = { you: "maintainer", learner: "learner" };
export const requestedBy = (trigger: string | null | undefined): From => (trigger === TRIGGER.learner ? "learner" : "you");

export const REQUEST_KINDS = ["config", "blueprint", "agents", "cleanup", "look"] as const;
export type Kind = (typeof REQUEST_KINDS)[number];
export const isKind = (k: unknown): k is Kind => REQUEST_KINDS.includes(k as Kind);

// The kind a request's words suggest, when whoever asked didn't name one (--kind). The
// kinds share one check for .factory/, so a near miss between config, blueprint and agents
// only changes the guidance REQUEST.md gives; cleanup and look are asked for in plain words.
export function guessKind(text: string): Kind {
  if (/\b(clean ?up|housekeep\w*|prune|stale worktrees?|orphan\w*|vacuum|compact the database)\b/i.test(text)) return "cleanup";
  if (/\b(colou?rs?|accent|theme|palette|fonts?|contrast|hard to read|layout|ui|warmer|cooler|darker|lighter)\b/i.test(text)) return "look";
  if (/\b(blueprints?|lanes?|stages?)\b/i.test(text)) return "blueprint";
  if (/\b(agents?|reviewer|builder|planner|checker|triager|spec[- ]writer|prompts?)\b/i.test(text)) return "agents";
  return "config";
}

export const requestKind = (db: Database, id: number): Kind => {
  const k = (db.query("SELECT request_kind FROM tickets WHERE id = ?").get(id) as { request_kind: string | null } | null)?.request_kind;
  return isKind(k) ? k : "config"; // requests from before kinds were .factory/ changes
};

const folderOf = (dir: string, id: number) => join(dir, "tickets", String(id));

// ---- the factory app's own repo --------------------------------------------------------
// The checkout this daemon runs from (the service's) is the factory app: its mods, themes,
// lib/ and layouts. A look request is a PR there, to `develop`. It never syncs into
// ~/.config/herdr-app: deploying stays your step. FACTORY_APP_REPO points elsewhere (tests).
export const APP_BRANCH = "develop";
export const APP_PATHS = ["mods/", "themes/", "lib/", "layouts/", "tests/", "keys.json", "scripts/gen.mjs", "preview.png"];
export const appPath = (f: string) => APP_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));

export function appRepo(db: Database, run: Run): Repo {
  const from = process.env.FACTORY_APP_REPO ?? resolve(import.meta.dir, "..");
  const top = run(["git", "-C", from, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error(`the factory app's checkout (${from}) isn't a git repo, so a look request has nowhere to work: ${top.out.slice(0, 200)}`);
  const path = top.out.trim();
  const url = run(["git", "-C", path, "remote", "get-url", "origin"]).out.trim();
  const slug = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?$/)?.[1] ?? "factory-app";
  setMeta(db, "app_repo", path);
  const known = db.query("SELECT slug, path, lead, app FROM repos WHERE slug = ?").get(slug) as { slug: string; path: string; lead: number; app: number } | null;
  // The factory also works on its own app: that checkout is the one tickets already use.
  if (known && !known.app) return { slug, path: known.path, lead: known.lead === 1 };
  db.query("INSERT INTO repos (slug, path, lead, app) VALUES (?, ?, 0, 1) ON CONFLICT(slug) DO UPDATE SET path = excluded.path").run(slug, path);
  return { slug, path, lead: false, app: true };
}

// The repo a request works in: one of the factory's (`--repo`), else the lead.
function targetRepo(db: Database, slug: string): Repo {
  const repos = listRepos(db);
  const r = repos.find((x) => x.slug.toLowerCase() === slug.toLowerCase());
  if (!r) throw new Error(`${slug} isn't one of this factory's repos (${repos.map((x) => x.slug).join(", ") || "none"}); add it with factory repo add`);
  return r;
}

// What REQUEST.md tells the maintainer for each kind, on top of its prompt.
const STAGE_KEYS = Object.keys((SCHEMA.blueprint as any).object.stages.map.object).join(", ");
export const KIND_GUIDE: Record<Kind, string> = {
  config: [
    "Edit `.factory/factory.yaml` (or the file the setting lives in) in this worktree. For what belongs to the",
    "person in every factory (plan, the account's budget.per_day, away, cloud, profile), run",
    "`factory account propose <this ticket's id>` and edit the copy it makes. `factory validate .factory` until it passes.",
  ].join("\n"),
  blueprint: [
    "Draft or edit `.factory/blueprints/<name>.yaml`. A blueprint is `name`, `start` (a stage) and `stages`, a map",
    `of stage ids to one of: an agent stage, a check stage or a gate. A stage's keys: ${STAGE_KEYS}.`,
    "- agent: names `.factory/agents/<agent>.md`; add any new agent it needs in the same PR.",
    "- check: `tests` (the quality floor), `lint`, `evidence`, or `factory`; give it `on_fail` (the stage that fixes it) and `max_retries`.",
    "- gate: `human` (waits for a person) or `auto`. A gate before a risky step is a stage like `approve: { gate: human, next: [migrate] }`.",
    "- `next` lists where it goes (`end` finishes); more than one makes the blueprint's `orchestrator` agent choose.",
    "- the last stages are `pr: { requires: ready, output: PR.md, template: pr-readable, next: [merge] }` and `merge: { gate: human, next: [end] }`.",
    "Copy the shape of the repo's own blueprints (`.factory/blueprints/*.yaml`). For example, a lane for database migrations",
    "with a person's go-ahead before the migration runs:",
    "",
    "```yaml",
    "name: db-migration",
    "start: plan",
    "stages:",
    "  plan:      { agent: planner, output: PLAN.md, next: [implement] }",
    "  implement: { agent: builder, next: [verify] }",
    "  verify:    { check: tests, next: [approve], on_fail: implement, max_retries: 2 }",
    "  approve:   { gate: human, next: [migrate] }",
    "  migrate:   { agent: migrator, next: [pr] }",
    "  pr:        { requires: ready, output: PR.md, template: pr-readable, next: [merge] }",
    "  merge:     { gate: human, next: [end] }",
    "```",
    "",
    "A new blueprint joins `grooming.blueprints` in factory.yaml in the same PR (unless a trigger starts it), so grooming",
    "can pick it once this merges; the factory check fails a new one that nothing can start. Run",
    "`factory dry-run .factory/blueprints/<name>.yaml` to replay the last finished tickets through it; the factory",
    "check runs it again and puts DRYRUN.md on the PR. Say in PR.md which path a typical ticket takes.",
  ].join("\n"),
  agents: [
    "A repo agent is `.factory/agents/<name>.md` in this worktree (the request's repo): a YAML header (`role`, and",
    "`model`, `effort`, `context`, `tools` as needed) between `---` lines, then the prompt. Make a stricter or",
    "different agent by editing its prompt or model in place; a new one needs a blueprint stage that names it.",
    "A factory agent (Overwatch, babysitter, maintainer, learner) isn't in any repo: run",
    "`factory agents propose <this ticket's id> <name>`, which copies `~/.factory/agents/<name>.md` (or the shipped",
    "default) into this ticket's folder as FACTORY-AGENTS/<name>.md, and edit that copy. The factory check validates",
    "it and puts the diff on the PR; the daemon writes it, with a backup, only once the request merges.",
  ].join("\n"),
  cleanup: [
    "Change no file. Run `factory cleanup --propose <this ticket's id>` (add `--days N` for another age than 14,",
    "and `--folders` only if the request asks to remove ticket folders). It lists what it would remove in",
    "CLEANUP.md and CLEANUP.json in this ticket's folder: closed or merged tickets' worktrees, Herdr spaces and",
    "terminals, their merged factory branches (local and on origin), orphaned factory worktrees, old",
    "config.yaml.bak-* files, and a database VACUUM. It never lists an unmerged branch, a worktree with",
    "uncommitted changes, or anything of a ticket still open. To narrow it to what was asked, delete entries",
    "from CLEANUP.json. Nothing is removed until the person merges this request; then the daemon does it.",
  ].join("\n"),
  look: [
    "This worktree is the factory app's own repo, and the change is a PR to its `develop` branch. You may change",
    `only ${APP_PATHS.join(", ")}.`,
    "- Colours are tokens in `themes/factory.json` (`colors.accent`, `working`, `blocked`, `done`, and the ansi",
    "  palette); a mod uses the tokens, never a hex value of its own.",
    "- Each page is a mod in `mods/factory-<page>/` (its `mod.json` and `main.js`); shared code is in `lib/`.",
    "- The page stack, keys and menu come from `lib/pages.js`: run `node scripts/gen.mjs` after changing it, which",
    "  rewrites `layouts/factory.json` and `keys.json`.",
    "- `herdr-app check mods/<mod>` checks one mod; the factory check runs `scripts/check.sh` (every test, the",
    "  generated files, and `herdr-app check` on each mod in a throwaway Herdr home).",
    "Never run scripts/sync.sh or copy anything into ~/.config/herdr-app: the person deploys after merging.",
  ].join("\n"),
};

export function request(db: Database, o: { text: string; repo: string; run: Run; now: string; from?: From; evidence?: string; dir?: string; kind?: Kind; target?: string }) {
  const text = o.text.trim().replace(/\s+/g, " ");
  if (!text) throw new Error('say what to change: factory request "<the change, and why>"');
  // A link or #number would make it a GitHub issue ticket: a request is the person's words.
  if (/^#?\d+$|^https?:\/\//.test(text)) throw new Error("a request is a sentence about the change, not an issue link; use factory new for issues");
  if (o.kind !== undefined && !isKind(o.kind)) throw new Error(`a request's kind is one of ${REQUEST_KINDS.join(", ")}`);
  const kind = o.kind ?? guessKind(text);
  if (kind === "look" && o.target) throw new Error("a look request works in the factory app's own repo; it takes no --repo");
  const from = o.from ?? "you";
  // Where the maintainer's worktree goes: the app for a look, the named repo, else the lead.
  const target = kind === "look" ? appRepo(db, o.run) : o.target ? targetRepo(db, o.target) : null;
  // A look PR goes to the app's develop branch, so its worktree starts there.
  let base: string | null = null;
  if (target?.app || kind === "look") {
    o.run(["git", "-C", target!.path, "fetch", "-q", "origin", APP_BRANCH]);
    if (o.run(["git", "-C", target!.path, "rev-parse", "--verify", "-q", `origin/${APP_BRANCH}`]).code === 0) base = `origin/${APP_BRANCH}`;
  }
  const r = newTicket(db, { text, repo: o.repo, blueprint: BLUEPRINT, run: o.run, now: o.now, trigger: TRIGGER[from] });
  db.query("UPDATE tickets SET groomed_at = ?, request_kind = ?, base = ? WHERE id = ?").run(o.now, kind, base, r.id);
  if (target && !target.lead) db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (?, ?, 1)").run(r.id, target.slug);
  if (from === "learner") db.query("UPDATE decisions SET who = 'learner' WHERE ticket = ? AND who = 'you'").run(r.id);
  if (o.evidence) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, 'evidence for the request', ?, ?)").run(r.id, from, o.evidence, o.now);
  // REQUEST.md: what the maintainer reads first, with who asked and why.
  if (o.dir) {
    const where = target ? `${target.slug}${target.app ? ", the factory app's own repo" : ""} (${target.path})` : `${o.repo}, the factory's lead repo`;
    mkdirSync(folderOf(o.dir, r.id), { recursive: true });
    writeFileSync(join(folderOf(o.dir, r.id), "REQUEST.md"), [
      `# Request #${r.id}`, "", `From: ${from === "learner" ? "the learner (self-learning found this)" : "you, in Overwatch"}`,
      `Kind: ${kind}`, `Repo: ${where}`, "", text, "",
      ...(o.evidence ? ["## Evidence", "", o.evidence.trim(), ""] : []),
      `## What a ${kind} request needs`, "", KIND_GUIDE[kind], "",
    ].join("\n"));
  }
  return { ...r, kind, repo: target?.slug ?? o.repo };
}

// A blueprint the request adds must be one something can start: grooming.blueprints lists
// it (a factory.yaml without the list lets grooming pick any), or a trigger names it.
// `added`: the blueprint names this branch adds; it returns the ones nothing starts.
export function unreachableBlueprints(factoryDir: string, added: string[]): string[] {
  if (!added.length) return [];
  const parse = (p: string) => { try { return Bun.YAML.parse(readFileSync(p, "utf8")) as any; } catch { return null; } };
  const groomed = parse(join(factoryDir, "factory.yaml"))?.grooming?.blueprints;
  if (!Array.isArray(groomed)) return [];
  const triggers = existsSync(join(factoryDir, "triggers"))
    ? readdirSync(join(factoryDir, "triggers")).filter((f) => /\.ya?ml$/.test(f)).map((f) => parse(join(factoryDir, "triggers", f))?.blueprint)
    : [];
  return added.filter((b) => b !== BLUEPRINT && !groomed.includes(b) && !triggers.includes(b));
}

// ---- files no repo holds: the account config and the factory agents ------------------
// The maintainer writes the whole proposed file in the ticket's folder. The factory check
// validates it, keeps the copy it checked and the file it was checked against, and writes
// the diff the PR carries. Merged, the daemon applies the checked copy, keeping a backup;
// if the file changed in between, it applies nothing and says so.
export const ACCOUNT_PROPOSAL = "ACCOUNT-CONFIG.yaml";
export const ACCOUNT_DIFF = "ACCOUNT-CONFIG.md";
export const AGENTS_PROPOSAL = "FACTORY-AGENTS";
export const AGENTS_DIFF = "FACTORY-AGENTS.md";
const SHIPPED_AGENTS = join(import.meta.dir, "../fixtures/acme-api/.factory/agents");
export const FACTORY_AGENTS = ["overwatch", "babysitter", "maintainer", "learner"];

type Outside = { label: string; target: string; proposal: string; checked: string; base: string; applied: string; stale: string; validate: (text: string) => string[] };

const accountOf = (folder: string, file: string): Outside => ({
  label: "the account config", target: file, proposal: join(folder, ACCOUNT_PROPOSAL), checked: join(folder, ".account-checked.yaml"),
  base: join(folder, ".account-base.yaml"), applied: join(folder, "ACCOUNT-CONFIG.applied.yaml"), stale: join(folder, ".account-stale.yaml"), validate: validateAccount,
});

// Every factory agent the request proposes, or has a checked copy of.
function agentsOf(folder: string, dir: string): Outside[] {
  const names = new Set<string>();
  for (const d of [join(folder, AGENTS_PROPOSAL), join(folder, ".agents-checked")])
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".md")) names.add(f);
  return [...names].sort().map((f) => ({
    label: `the factory agent ${f.slice(0, -3)}`, target: join(dir, f), proposal: join(folder, AGENTS_PROPOSAL, f),
    checked: join(folder, ".agents-checked", f), base: join(folder, ".agents-base", f), applied: join(folder, "FACTORY-AGENTS.applied", f),
    stale: join(folder, ".agents-stale", f), validate: (text) => validateFile(`agents/${f}`, text),
  }));
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const write = (p: string, text: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

function unifiedDiff(base: string, next: string, label: string) {
  const a = base.split("\n"), b = next.split("\n");
  // Longest common subsequence, line by line: config files are small.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [`--- ${label}`, `+++ ${label} (proposed)`];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+${b[j++]}`);
    else out.push(`-${a[i++]}`);
  }
  return out.join("\n");
}

// One proposal checked: null when there is none; a diff when there's something to apply.
function checkOutside(f: Outside): { ok: boolean; detail: string; diff?: string } | null {
  const clear = () => { for (const p of [f.checked, f.base]) rmSync(p, { force: true }); };
  if (!existsSync(f.proposal)) { clear(); return null; }
  const text = readFileSync(f.proposal, "utf8");
  const errors = f.validate(text);
  if (errors.length) { clear(); return { ok: false, detail: `${basename(f.proposal)}: ${errors[0]}`.slice(0, 200) }; }
  const current = read(f.target);
  if (current === text) { clear(); return { ok: true, detail: `the proposal matches ${f.label}: nothing to apply` }; }
  write(f.base, current);
  write(f.checked, text);
  return { ok: true, detail: `${basename(f.proposal)} passes`, diff: unifiedDiff(current, text, f.target) };
}

// Merged: write the checked copy over the file, keeping a backup.
function applyOutside(db: Database, f: Outside, id: number, now: string): { applied: boolean; detail: string } | null {
  if (!existsSync(f.checked)) return null;
  const note = (what: string, why: string | null) => db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(id, what, why, now);
  const text = readFileSync(f.checked, "utf8");
  if (read(f.target) !== read(f.base)) {
    // Someone changed it after the check: applying would lose their edit.
    mkdirSync(dirname(f.stale), { recursive: true });
    renameSync(f.checked, f.stale);
    const detail = `${f.target} changed after the check; nothing was applied. Ask again so the maintainer starts from the file as it is now`;
    note(`${f.label.replace(/^the /, "")} not applied`, detail);
    return { applied: false, detail };
  }
  mkdirSync(dirname(f.target), { recursive: true });
  const backup = existsSync(f.target) ? `${f.target}.bak-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${id}` : null;
  if (backup) copyFileSync(f.target, backup);
  const tmp = `${f.target}.factory-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, f.target); // whole or not at all: every factory reads this file
  mkdirSync(dirname(f.applied), { recursive: true });
  renameSync(f.checked, f.applied);
  rmSync(f.base, { force: true });
  rmSync(f.proposal, { force: true });
  const detail = backup ? `the old file is ${backup}` : `there was no ${basename(f.target)} before`;
  note(`applied ${f.label}`, detail);
  return { applied: true, detail };
}

// `factory account propose <id>`: the maintainer starts from the file as it is.
export function proposeAccount(dir: string, id: number, file = accountFile()) {
  const out = join(folderOf(dir, id), ACCOUNT_PROPOSAL);
  if (existsSync(out)) return out;
  write(out, existsSync(file) ? readFileSync(file, "utf8") : "# ~/.factory/config.yaml: what belongs to you in every factory (plan, budget, away, cloud, profile)\n");
  return out;
}

// `factory agents propose <id> <name>`: the factory agent as it is (or as shipped), to edit.
export function proposeFactoryAgent(dir: string, id: number, name: string, agents = factoryAgentsDir()) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" isn't an agent name (lowercase letters, digits and dashes)`);
  const out = join(folderOf(dir, id), AGENTS_PROPOSAL, `${name}.md`);
  if (existsSync(out)) return out;
  const own = join(agents, `${name}.md`), shipped = join(SHIPPED_AGENTS, `${name}.md`);
  write(out, existsSync(own) ? readFileSync(own, "utf8") : existsSync(shipped) ? readFileSync(shipped, "utf8") : `---\nrole: maintain\n---\nThe ${name} agent's prompt.\n`);
  return out;
}

// The factory check's account part; null when the request doesn't touch the account config.
export function checkAccount(dir: string, id: number, file = accountFile()): { ok: boolean; detail: string } | null {
  const folder = folderOf(dir, id);
  const r = checkOutside(accountOf(folder, file));
  if (!r?.diff) rmSync(join(folder, ACCOUNT_DIFF), { force: true });
  if (!r?.diff) return r;
  writeFileSync(join(folder, ACCOUNT_DIFF), [
    "## The account config (~/.factory/config.yaml)", "",
    `Applied to \`${file}\` only after this merges, with a backup beside it. Not part of the repo.`, "",
    "```diff", r.diff, "```", "",
  ].join("\n"));
  return { ok: true, detail: `${ACCOUNT_PROPOSAL} passes; its diff goes on the PR and it applies when the PR merges` };
}

// The factory check's factory-agents part; null when the request proposes none.
export function checkFactoryAgents(dir: string, id: number, agents = factoryAgentsDir()): { ok: boolean; detail: string } | null {
  const folder = folderOf(dir, id);
  const results = agentsOf(folder, agents).map((f) => ({ f, r: checkOutside(f) })).filter((x) => x.r);
  const diffs = results.filter((x) => x.r!.diff);
  if (!diffs.length) rmSync(join(folder, AGENTS_DIFF), { force: true });
  if (!results.length) return null;
  const bad = results.find((x) => !x.r!.ok);
  if (bad) return { ok: false, detail: bad.r!.detail };
  if (diffs.length) writeFileSync(join(folder, AGENTS_DIFF), [
    "## The factory agents (~/.factory/agents/)", "",
    `Applied to \`${agents}\` only after this merges, each with a backup beside it. Not part of the repo.`, "",
    ...diffs.flatMap((x) => ["```diff", x.r!.diff!, "```", ""]),
  ].join("\n"));
  return { ok: true, detail: diffs.length ? `${diffs.map((x) => basename(x.f.target, ".md")).join(", ")} pass; the diff goes on the PR and applies when it merges` : "the proposals match the factory agents: nothing to apply" };
}

// A checked change outside the repo waits to be applied: a request with nothing else
// to merge needs no PR (the account config, the factory agents, a cleanup).
export const accountPending = (dir: string, id: number) => existsSync(accountOf(folderOf(dir, id), accountFile()).checked);
export const outsidePending = (dir: string, id: number) =>
  accountPending(dir, id) || agentsOf(folderOf(dir, id), factoryAgentsDir()).some((f) => existsSync(f.checked)) || cleanupPending(dir, id);

// Merged: write the checked copy over the account config, keeping a backup.
export function applyAccount(db: Database, o: { dir: string; id: number; now: string; file?: string }) {
  return applyOutside(db, accountOf(folderOf(o.dir, o.id), o.file ?? accountFile()), o.id, o.now);
}

// Every tick: what a merged request changes outside its repo is applied, once each (the
// checked copy moves aside): the account config, the factory agents, then a cleanup.
// `vacuum`: a cleanup asked for one, which the caller runs outside its transaction.
export function applyMerged(db: Database, o: { dir: string; now: string; run: Run; file?: string; agents?: string; log?: (s: string) => void }) {
  const ids = (db.query("SELECT id FROM tickets WHERE blueprint = ? AND state = 'merged' ORDER BY id").all(BLUEPRINT) as { id: number }[]).map((r) => r.id);
  let vacuum = false;
  for (const id of ids.filter((i) => outsidePending(o.dir, i))) {
    const folder = folderOf(o.dir, id);
    for (const f of [accountOf(folder, o.file ?? accountFile()), ...agentsOf(folder, o.agents ?? factoryAgentsDir())]) {
      const r = applyOutside(db, f, id, o.now);
      if (r) o.log?.(`factory: #${id}: ${r.applied ? `applied ${f.label} (${r.detail})` : r.detail}`);
    }
    if (cleanupPending(o.dir, id)) {
      const c = performCleanup(db, { dir: o.dir, id, run: o.run, now: o.now });
      vacuum ||= c.vacuum;
      o.log?.(`factory: #${id}: cleanup: ${c.summary}`);
    }
  }
  return { vacuum };
}
