// The graph runner's first half: a ticket gets its own worktree (a Herdr worktree
// space when the app runs), enters its blueprint's first stage, and that stage's
// agent starts in a tab there, or in a free-floating herdr-core terminal.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDir, validateFile } from "./validate.ts";
import { enterStage } from "./ticket.ts";
import { closesIssue, openPr, prBody, prText, readyRules, rulesPass, VERDICT_OF_ROLE, type VerdictKind } from "./ready.ts";
import { closeSpace, openAgent, openTab, toolPath, withFactory, worktreePath } from "./herdr.ts";
import { answerQuestions, finishGrooming } from "./groom.ts";
import { commentGate } from "./comments.ts";
import { mergeOrder, repoOf, setWork, ticketRepos } from "./db.ts";
import { budgetCap, forbiddenTouched } from "./away.ts";
import { STOPS, guardSettings, hardStopLog, takeHardStop } from "./guard.ts";
import { withHandoffHook } from "./handoff-hook.ts";
import { budgetUse, roundUse, startHold } from "./budget.ts";
import { profileText } from "./account.ts";
import { DEFAULT_MODEL, pinModel } from "./models.ts";
import { lessonsFor, settingOf, snapshotSettings, ticketPaths } from "./learn.ts";
import { closeRound, latestBrief } from "./round.ts";
import { loadPrompt, render } from "./prompts.ts";
import { finishSlice, readSlices, sliceInHand } from "./slices.ts";
import { childrenOf, decideSplit, pendingParts, splitGate } from "./split.ts";
import { chooseNext } from "./orchestrate.ts";
import { dryRun, dryRunMarkdown, loadDraft } from "./dryrun.ts";
import { accountPending, BLUEPRINT as FACTORY_BLUEPRINT, checkAccount } from "./maintainer.ts";
import { readFeatures, touched } from "./features.ts";
import { resolveClaude } from "./claude-bin.ts";
import { artifactPolicy, publishGap, publishStep, sharedLine, sharedLinks } from "./artifacts.ts";
import { loadAgent } from "./agents.ts";

export type Run = (argv: string[], cwd?: string) => { code: number; out: string };
export const sh: Run = (argv, cwd) => {
  // Tests stub claude; one that forgot must never start the user's real Claude.
  // Tests never reach real agents or GitHub: a stub that falls through to sh gets a failure.
  if (["claude", "codex", "gh"].includes(argv[0]) && process.env.FACTORY_TEST_SANDBOX) return { code: 1, out: `${argv[0]} is stubbed in tests` };
  const r = Bun.spawnSync(resolveClaude(argv), { cwd }); // the one claude every session runs (claude-bin.ts)
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

type Stage = { agent?: string; check?: string; next?: string[]; output?: string; prompt?: string; per?: "ticket" | "slice" };
type Blueprint = { name: string; orchestrator?: string; start: string; stages: Record<string, Stage> };

// The maintainer's blueprint ships with the factory (setup copies it too): a factory
// without its own uses it, so every factory can take requests (maintainer.ts). The
// maintainer agent itself is a factory agent, one for every repo (agents.ts).
const BUILT_IN = join(import.meta.dir, "../fixtures/acme-api/.factory");
const SHIPPED = ["blueprints/factory.yaml"];

function readYaml(repo: string, path: string) {
  const own = join(repo, ".factory", path);
  const file = existsSync(own) ? own : SHIPPED.includes(path) ? join(BUILT_IN, path) : null;
  if (!file) return null;
  const text = readFileSync(file, "utf8");
  const errors = validateFile(path, text);
  if (errors.length) throw new Error(`.factory/${path}: ${errors[0]}`);
  return text;
}

export function loadBlueprint(repo: string, name: string): Blueprint {
  const text = readYaml(repo, `blueprints/${name}.yaml`) ?? (name === "default" ? readYaml(repo, "blueprint.yaml") : null);
  if (!text) throw new Error(`no blueprint "${name}" in ${repo}/.factory/blueprints/`);
  const b = Bun.YAML.parse(text) as Blueprint;
  // A maintainer's PR merges as factory.yaml's maintainer.gate says: human unless you chose auto.
  const gate = name === "factory" ? readFactory(repo).maintainer?.gate : undefined;
  if (gate && b.stages.merge) (b.stages.merge as BlueprintStage).gate = gate;
  return b;
}

// The path the blueprint would take with no surprises: the first `next` each time.
export function plannedPath(b: Blueprint, from: string) {
  const path: string[] = [];
  for (let at = b.stages[from]?.next?.[0]; at && at !== "end" && !path.includes(at); at = b.stages[at]?.next?.[0]) path.push(at);
  return path;
}

export const title = (id: string) => (id.length <= 2 ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1)); // pr → PR
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// A session starts from files, not chat: the brief names them (plan: Worktrees and sessions).
// `share`: the claude.ai links and the publish step for the stage's output (artifacts.ts); "" when sharing is off.
export function brief(t: { id: number; title: string }, stage: string, prompt: string | null, folder: string, role?: string, repos: { repo: string; worktree: string | null }[] = [], lessons: string[] = [], template = loadPrompt(null, "stage"), slice = "", share: { shared?: string; publish?: string } = {}) {
  const verdict = role ? VERDICT_OF_ROLE[role] : undefined;
  return render(template, {
    "ticket.id": String(t.id),
    "ticket.title": t.title,
    stage,
    folder,
    "agent.prompt": prompt,
    repos: repos.length > 1 ? repos.map((r, i) => `${r.repo} in ${r.worktree}${i ? "" : " (here)"}`).join(", ") : "",
    repo_count: repos.length > 1 ? String(repos.length) : "",
    verdict:
      verdict === "holdout" ? `Write hidden checks the builder never sees: keep them in ${folder}/holdout/, never in the worktree. Run them against the worktree, then record the result: factory verdict ${t.id} holdout pass, or factory verdict ${t.id} holdout fail <what fails, without the check's code>.`
      : verdict === "review" ? `Record your verdict before you finish: factory verdict ${t.id} review pass, or factory verdict ${t.id} review fail <each blocker>. Only a blocker fails; put suggestions in a pass's detail.`
      : "",
    profile: profileText(),
    lessons: lessons.map((l) => `- ${l}`).join("\n"),
    fix_brief: latestBrief(folder),
    slice,
    shared: share.shared,
    publish: share.publish,
  });
}

// The agent's harness, model and effort for one ticket: its snapshot's override
// (learn.ts), else the agent file's value, else the defaults.
export function agentSettings(t: { settings?: string | null }, name: string, agent: Record<string, any> | null, defaults: Record<string, any>) {
  const pick = (f: string) => settingOf(t, `agents.${name}.${f}`, agent?.[f] ?? defaults[f]);
  return { harness: pick("harness") as string, model: pick("model") as string | undefined, effort: pick("effort") as string | undefined };
}

// `settings` is the hard-stop guard's JSON; only Claude sessions take it (Codex has no hooks).
export function argvFor(agent: { harness?: string; model?: string } | null, defaults: { harness: string; model?: string }, text: string, settings?: string | null) {
  const harness = agent?.harness ?? defaults.harness;
  const model = agent?.model ?? defaults.model;
  if (harness === "claude") return ["claude", ...(model ? ["--model", pinModel(model)!] : []), ...(settings ? ["--settings", settings] : []), text];
  if (harness === "codex") return ["codex", ...(model ? ["--model", model] : []), text];
  return [harness, text]; // any other program gets the brief as its last argument
}

export function startTicket(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!["queued", "grooming"].includes(t.state) || t.needs_kind) throw new Error(`#${o.id} is ${t.state}${t.needs_kind ? " with open questions" : ""}; only a groomed or queued ticket starts`);
  const hold = startHold(db, o.repo, new Date(now));
  if (hold) throw new Error(`#${o.id} waits: ${hold}`);
  const b = loadBlueprint(o.repo, t.blueprint);
  const branch = `factory/${o.id}-${slug(t.title)}`;
  // Every repo the ticket works in gets a worktree on the same branch; a repo factory.yaml
  // stopped listing refuses the start.
  const listed = readFactory(o.repo).repos;
  const repos = ticketRepos(db, o.id).map((r) => ({ slug: r.repo, lead: r.lead === 1, path: repoOf(db, r.repo, listed).path }));
  for (const r of repos) {
    const worktree = worktreePath(r.path, branch);
    mkdirSync(dirname(worktree), { recursive: true });
    // Idempotent: a start that failed after this step (its rows rolled back) left the
    // branch and checkout behind; reuse them, as Herdr's New worktree does a branch.
    const here = existsSync(worktree) && run(["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).out === branch;
    if (!here) {
      const known = run(["git", "-C", r.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
      // A split's part that keeps the work starts from its parent's branch (split.ts).
      const base = r.lead && t.base ? [t.base] : [];
      const wt = run(["git", "-C", r.path, "worktree", "add", ...(known ? [worktree, branch] : ["-b", branch, worktree, ...base])]);
      if (wt.code !== 0) throw new Error(`git worktree add failed in ${r.slug}: ${wt.out}`);
    }
    setWork(db, o.id, { worktree, branch }, r.slug);
  }
  // The ticket runs on the settings in force now, whatever is tuned while it runs.
  snapshotSettings(db, o.id, readFactory(o.repo).learn?.tunable);
  db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(o.id);
  return startStage(db, { ...o, run, now, blueprint: b, stage: b.start });
}

// What a stage's brief says about shared copies on claude.ai: the links, the publish step for its
// output, and the tool the session may use for it without asking.
export function shareFor(db: Database, o: { repo: string; id: number; folder: string; output?: string }) {
  const p = artifactPolicy(readFactory(o.repo));
  const links = sharedLinks(db, o.id, p);
  return {
    policy: p, links,
    shared: sharedLine(links, o.folder),
    publish: o.output ? publishStep(p, { id: o.id, file: o.output, path: join(o.folder, o.output), links }) : "",
    allow: p.as === "artifact" ? ["Artifact"] : p.as === "doc" ? ["mcp__claude_ai_Claude_Docs"] : [],
  };
}

// At stage-done: a stage whose output is shared but wasn't published this stage gets a line in the
// decision log. Never more: the stage passes on the local file, and a broken config can't stop it.
export function notePublishGap(db: Database, o: { repo: string; id: number; now: string }) {
  try {
    const t = db.query("SELECT blueprint, stage FROM tickets WHERE id = ?").get(o.id) as { blueprint: string; stage: string | null } | null;
    if (!t?.stage) return false;
    const b = loadBlueprint(o.repo, t.blueprint);
    const key = Object.keys(b.stages).find((k) => k.toLowerCase() === t.stage); // tickets.stage is the name, lowercased
    const since = (db.query("SELECT started_at FROM stages WHERE ticket = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(o.id) as { started_at: string } | null)?.started_at ?? null;
    return publishGap(db, { id: o.id, file: key ? b.stages[key].output : undefined, since, policy: artifactPolicy(readFactory(o.repo)), now: o.now });
  } catch { return false; }
}

export function startStage(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; blueprint: Blueprint; stage: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any>;
  const s = o.blueprint.stages[o.stage];
  if (!s) throw new Error(`blueprint ${o.blueprint.name} has no stage "${o.stage}"`);
  // per: slice: this session builds the first slice not done yet (slices.ts).
  const all = s.per === "slice" ? readSlices(o.dir, o.id) : [];
  const slice = s.per === "slice" ? sliceInHand(db, { dir: o.dir, id: o.id, stage: o.stage }) : null;
  const of = slice ? ` · slice ${all.findIndex((x) => x.key === slice.key) + 1} of ${all.length}` : "";
  enterStage(db, o.id, title(o.stage), s.agent ? `${s.agent} agent${of}` : s.check ? `check: ${s.check}` : null, plannedPath(o.blueprint, o.stage).map(title), o.now);
  if (!s.agent) return null; // check and gate stages are the daemon's own (D4b)
  const agent = loadAgent(o.repo, s.agent);
  const defaults = { harness: "claude", model: DEFAULT_MODEL };
  const repos = ticketRepos(db, o.id);
  // Hard stops factory.yaml lists (all four when it lists none) are enforced by a hook on the worker's tool calls;
  // the handoff hook joins it in the same settings file (Claude Code takes one --settings).
  const guard = guardSettings({ stops: readFactory(o.repo).hard_stops ?? [...STOPS], roots: [...repos.flatMap((r) => r.worktree ?? []), join(o.dir, "tickets", String(o.id))], log: hardStopLog(o.dir, o.id) });
  const folder = join(o.dir, "tickets", String(o.id));
  const intent = existsSync(join(folder, "INTENT.md")) ? readFileSync(join(folder, "INTENT.md"), "utf8") : "";
  const lessons = lessonsFor(db, ticketPaths({ repos, intent, run: o.run })).map((l) => `(${l.area}) ${l.text}`);
  const use = agentSettings(t, s.agent, agent, defaults);
  const share = shareFor(db, { repo: o.repo, id: o.id, folder, output: s.output });
  const argv = withHandoffHook(argvFor(use, defaults, brief(t as any, o.stage, agent?.prompt ?? null, folder, agent?.role, repos, lessons, loadPrompt(o.repo, s.prompt ?? "stage"), slice?.text, share)), o.dir, o.id, guard, readFactory(o.repo).quality_floor ?? [], [folder, ...repos.flatMap((r) => r.worktree ?? [])], share.allow);
  const cmd = withFactory(argv, o.dir); // sessions keep the agent's own argv
  const name = `f${o.id}-${o.stage}`.slice(0, 32);
  const labels = [`factory.ticket=${o.id}`, `factory.stage=${o.stage}`];
  // The ticket's first worktree stage: the other repos' shell tabs join its space with it.
  const first = !db.query("SELECT 1 FROM sessions WHERE ticket = ? AND stage != 'groom' AND in_space = 1").get(o.id);
  const made = openAgent(o.run, { folder: t.worktree, space: t.space, name: o.stage, argv: cmd });
  let terminal: string;
  if (made) {
    terminal = made.terminal;
    o.run(["hc", "label", terminal, ...labels]);
    db.query("UPDATE tickets SET space = ? WHERE id = ?").run(made.space, o.id);
    // A new space, or the first stage in grooming's: each other repo's worktree gets a shell tab in it.
    if (made.space !== t.space || first) for (const r of repos.slice(1)) if (r.worktree) openTab(o.run, { space: made.space, folder: r.worktree, name: r.repo.slice(r.repo.indexOf("/") + 1) });
  } else {
    const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", t.worktree,
      ...labels.flatMap((l) => ["--label", l]), ...cmd]);
    if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
    terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  }
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd, slice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(o.id, o.stage, s.agent, terminal, JSON.stringify(argv), o.now, made ? 1 : 0, t.worktree, slice?.key ?? null);
  return terminal;
}

export type Factory = { tickets?: string | { source?: string; split?: "human" | "auto" }; learn?: { target?: string; tunable?: string[]; warmup_tickets?: number; pause_above?: number | string; promote_after?: number; review_every?: number }; hard_stops?: string[]; repos?: string[]; cross_check?: string; review?: { pushbacks?: number }; merge_method?: "squash" | "merge" | "rebase"; quality_floor?: string[]; ready?: string[]; max_running?: number; budget?: Record<string, unknown>; plan?: Record<string, unknown>; queue?: { github_project?: string; column?: string; assignee?: string }; grooming?: { agent?: string; blueprints?: string[]; questions?: string[]; product_owner?: string }; maintainer?: { gate?: "human" | "auto" }; verify?: { features?: string }; cloud?: { on_sleep?: "move" | "off" } };
const DEFAULT_READY = ["evidence", "holdout", "quality_floor", "review", "template", "budget"];
export const readFactory = (repo: string): Factory => {
  const text = readYaml(repo, "factory.yaml");
  return text ? (Bun.YAML.parse(text) as Factory) : {};
};

// The verdict an agent stage owes: its agent's role decides (verify → holdout, review → review).
const verdictOf = (repo: string, s: Stage | undefined): VerdictKind | undefined => {
  const role = s?.agent ? loadAgent(repo, s.agent)?.role : undefined;
  return role ? VERDICT_OF_ROLE[role] : undefined;
};

// The ready rules as the pr stage sees them: factory.yaml's list, and the verdicts
// the ticket's blueprint has stages for.
export function checkReady(db: Database, o: { dir: string; repo: string; id: number; run: Run }) {
  const t = db.query("SELECT worktree, blueprint FROM ticket_lead WHERE id = ?").get(o.id) as { worktree: string | null; blueprint: string } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!t.worktree) throw new Error(`#${o.id} has no worktree yet; factory start ${o.id}`);
  const b = loadBlueprint(o.repo, t.blueprint);
  const expects = Object.values(b.stages).map((s) => verdictOf(o.repo, s)).filter((k): k is VerdictKind => !!k);
  const repos = ticketRepos(db, o.id);
  const rules = readFactory(o.repo).ready ?? DEFAULT_READY;
  // A cross-repo ticket is ready only when its branches pass the cross check together.
  return readyRules(db, { id: o.id, dir: o.dir, worktrees: repos.flatMap((r) => r.worktree ?? []), rules: repos.length > 1 ? [...rules, "cross_check"] : rules,
    run: o.run, expects, cap: budgetCap(db, o.repo) });
}

// A check stage the daemon runs itself. Returns whether it passed, after recording evidence.
export function runCheck(db: Database, o: { id: number; repo: string; worktree: string; check: string; run: Run; now: string; dir?: string }) {
  const record = (name: string, ok: boolean, detail: string) =>
    db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (?, ?, ?, ?, ?)").run(o.id, name, ok ? "PASS" : "FAIL", detail, o.now);
  if (o.check === "tests" || o.check === "lint") {
    const commands = readFactory(o.repo).quality_floor ?? [];
    if (!commands.length) { record(o.check, false, "factory.yaml has no quality_floor commands"); return false; }
    let ok = true;
    for (const c of commands) {
      const r = o.run(["env", `PATH=${toolPath()}`, "sh", "-c", c], o.worktree);
      // Agents see the first failing lines; full logs stay out of the prompt (PRD 6.10).
      const tail = r.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 200);
      record(c, r.code === 0, r.code === 0 ? "passed" : `exit ${r.code}: ${tail}`);
      ok &&= r.code === 0;
    }
    const features = o.check === "tests" ? featureScenarios({ ...o, record }) : true;
    return crossCheck(db, { ...o, record }) && features && ok;
  }
  if (o.check === "evidence") {
    // The quality floor runs now, on the work as it stands, so a PASS is always newer than
    // the last edit (flow-stack's evidence.sh). Then every check's latest result must be a
    // PASS, and there must be at least one. The evidence check's own rows don't count.
    runCheck(db, { ...o, check: "tests" });
    const latest = db.query(`SELECT check_name, result FROM evidence e WHERE ticket = ? AND check_name != 'evidence' AND id = (SELECT MAX(id) FROM evidence WHERE ticket = e.ticket AND check_name = e.check_name)`).all(o.id) as { result: string }[];
    const ok = latest.length > 0 && latest.every((r) => r.result === "PASS");
    record("evidence", ok, ok ? `${latest.length} checks pass` : latest.length ? `${latest.filter((r) => r.result !== "PASS").length} failing` : "no checks recorded");
    return ok;
  }
  if (o.check === "factory") {
    // A maintainer's change: every .factory/ file passes the schema check, and nothing
    // outside .factory/ changed (the maintainer looks after the factory, not the code).
    const bad = validateDir(join(o.worktree, ".factory")).filter((r) => r.errors.length);
    record("factory validate", !bad.length, bad.length ? bad.map((r) => `${r.path}: ${r.errors[0]}`).join("; ").slice(0, 200) : "every .factory/ file passes");
    const outside = changedFiles(o.run, o.repo, o.worktree).filter((f) => !f.startsWith(".factory/"));
    record("only .factory/", !outside.length, outside.length ? `changed outside .factory/: ${outside.slice(0, 5).join(", ")}` : "every change is in .factory/");
    const dry = bad.length || !o.dir ? true : dryRunChanged(db, { ...o, dir: o.dir, record });
    // The account config isn't in the repo: its proposal sits in the ticket's folder (maintainer.ts).
    const account = o.dir ? checkAccount(o.dir, o.id) : null;
    if (account) record("account config", account.ok, account.detail);
    return !bad.length && !outside.length && dry && (account?.ok ?? true);
  }
  throw new Error(`unknown check "${o.check}"`);
}

// verify.features (flow-stack's feature map): the scenario of each feature the ticket's
// changes touch runs in its worktree, as `feat:<id>` (features.ts).
function featureScenarios(o: { repo: string; worktree: string; run: Run; record: (name: string, ok: boolean, detail: string) => void }) {
  const dir = readFactory(o.repo).verify?.features;
  if (!dir) return true;
  const files = changedFiles(o.run, o.repo, o.worktree);
  let ok = true;
  for (const f of readFeatures(join(o.worktree, dir)).filter((x) => x.scenario && touched(x, files))) {
    const r = o.run(["env", `PATH=${toolPath()}`, "sh", "-c", f.scenario], o.worktree);
    const tail = r.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 200);
    o.record(`feat:${f.id}`, r.code === 0, r.code === 0 ? `${f.scenario}: passed` : `${f.scenario}: exit ${r.code}: ${tail}`);
    ok &&= r.code === 0;
  }
  return ok;
}

// A changed blueprint gets a dry run: DRYRUN.md in the ticket's folder, which the PR body
// carries (ready.ts). A draft whose graph names a stage that isn't there fails the check.
function dryRunChanged(db: Database, o: { id: number; repo: string; worktree: string; run: Run; dir: string; record: (name: string, ok: boolean, detail: string) => void }) {
  const out = join(o.dir, "tickets", String(o.id), "DRYRUN.md");
  const files = changedFiles(o.run, o.repo, o.worktree).filter((f) => f === ".factory/blueprint.yaml" || /^\.factory\/blueprints\/[^/]+\.yaml$/.test(f));
  const drafts = files.filter((f) => existsSync(join(o.worktree, f)));
  if (!drafts.length) { if (existsSync(out)) unlinkSync(out); return true; }
  try {
    const parts = drafts.map((f) => dryRunMarkdown(dryRun(db, loadDraft(readFileSync(join(o.worktree, f), "utf8"), f.slice(".factory/".length)), 5)));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, parts.join("\n"));
    o.record("blueprint dry run", true, `${drafts.length} blueprint${drafts.length === 1 ? "" : "s"} replayed; DRYRUN.md goes on the PR`);
    return true;
  } catch (e) {
    o.record("blueprint dry run", false, (e as Error).message.replace(/\s+/g, " ").slice(0, 200));
    return false;
  }
}

// Files the ticket's branch changed since it left the repo's checkout, committed or not.
function changedFiles(run: Run, repo: string, worktree: string) {
  const head = run(["git", "-C", repo, "rev-parse", "HEAD"]).out.trim();
  const fork = run(["git", "-C", worktree, "merge-base", "HEAD", head]);
  const committed = fork.code === 0 ? run(["git", "-C", worktree, "diff", "--name-only", fork.out.trim(), "HEAD"]).out.split("\n") : [];
  const loose = [["diff", "--name-only", "HEAD"], ["ls-files", "--others", "--exclude-standard"]].flatMap((a) => run(["git", "-C", worktree, ...a]).out.split("\n"));
  return [...new Set([...committed, ...loose].map((f) => f.trim()).filter(Boolean))];
}

// A cross-repo ticket's tests check also runs factory.yaml's cross_check, in the lead's
// worktree, with each repo's worktree in FACTORY_REPO_<NAME> (acme/web → FACTORY_REPO_WEB).
function crossCheck(db: Database, o: { id: number; repo: string; worktree: string; run: Run; record: (name: string, ok: boolean, detail: string) => void }) {
  const repos = ticketRepos(db, o.id);
  if (repos.length < 2) return true;
  const cmd = readFactory(o.repo).cross_check;
  if (!cmd) { o.record("cross_check", false, "factory.yaml has no cross_check command for cross-repo tickets"); return false; }
  const env = repos.map((r) => `FACTORY_REPO_${r.repo.slice(r.repo.indexOf("/") + 1).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}=${r.worktree}`);
  const r = o.run(["env", ...env, "sh", "-c", cmd], o.worktree);
  const tail = r.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 200);
  o.record("cross_check", r.code === 0, r.code === 0 ? `passed across ${repos.map((x) => x.repo).join(", ")}` : `exit ${r.code}: ${tail}`);
  return r.code === 0;
}

type BlueprintStage = Stage & { on_fail?: string; max_retries?: number; gate?: string; requires?: string };

// The current stage's work is over (an agent said so, its terminal exited, or a
// check ran): close its session, then follow the blueprint until something waits.
export function advance(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string; failed?: string; opened?: boolean }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (t?.state === "grooming") return finishGrooming(db, { dir: o.dir, repo: o.repo, id: o.id, run, now });
  if (!t || t.state !== "running") throw new Error(`#${o.id} isn't running`);
  const b = loadBlueprint(o.repo, t.blueprint);
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  const at = t.stage as string;
  // Review comments the stage handled: each needs a verdict; an escalation stops for you.
  const gate = o.failed ? null : commentGate(db, o.id, now);
  // While you're away, a ticket that touched a path away.never names stops for you.
  const touched = t.worktree ? forbiddenTouched(db, { repo: o.repo, worktree: t.worktree, run }) : [];
  // A worker the guard stopped (daemon/guard.ts) parks the ticket, whatever else it did.
  const hit = takeHardStop(hardStopLog(o.dir, o.id));
  if (hit) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'guard', 'hard stop hit', ?, ?)").run(o.id, hit, now);
  // A ticket at its budget stops here, at the stage boundary, not mid-edit.
  const use = budgetUse(t as any, budgetCap(db, o.repo));
  const round = gate ? null : roundUse(db, o.repo, t as any);
  const stop = hit ? `Hard stop hit: ${hit}` : round && round.frac >= 1 ? `Review round ${round.round} used its token cap (${round.text}; review.round_budget). Raise it, or take over`
    : use.frac >= 1 ? `Budget used up (${use.text}). Raise the budget or drop the ticket`
    : gate && "park" in gate ? gate.park : touched.length ? `Touched ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? "…" : ""}, which never runs while you're away` : null;
  if (stop) {
    db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?").run(stop, now, o.id);
    db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
    return { parked: true, stage: at };
  }
  // The stage's agent proposed a split: it stops for you, or the parts are made now.
  const split = o.failed ? null : splitGate(db, { dir: o.dir, repo: o.repo, id: o.id, run, now });
  if (split) return { ...split, stage: at };
  // Past the stop, a gate can only have failed the stage: a park returned above.
  const gateFailed = gate && "failed" in gate ? gate.failed : null;
  const verdict = o.failed || gate ? null : stageVerdict(db, { dir: o.dir, repo: o.repo, id: o.id, stage: at, s: b.stages[at], now });
  // per: slice: a slice is built; the next one gets a fresh session in the same stage.
  if (!o.failed && !gateFailed && !verdict?.failed && b.stages[at]?.per === "slice" && finishSlice(db, { dir: o.dir, id: o.id, stage: at, now }))
    return { terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, blueprint: b, stage: at }), stage: at };
  return withNote(verdict?.undo ?? (() => {}), () => follow(db, { ...o, run, now, b, t, at, failed: o.failed ?? gateFailed ?? verdict?.failed ?? null }));
}

function follow(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; b: Blueprint; t: Record<string, any>; at: string; failed: string | null; opened?: boolean }) {
  const { run, now, b, t } = o;
  let at = o.at;
  let failed = o.failed;
  for (let hops = 0; hops < 50; hops++) {
    const stage = b.stages[at] as BlueprintStage;
    let to: string | undefined;
    if (failed) {
      // A verdict stage counts its own failed sessions since a person last restarted the
      // ticket: the verify check between review and implement resets the shared counter.
      const retries = verdictOf(o.repo, stage) ? verdictFailures(db, o.id, at)
        : (db.query("SELECT retries FROM ticket_lead WHERE id = ?").get(o.id) as any).retries + 1;
      if (!stage.on_fail || retries > (stage.max_retries ?? 3)) {
        db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?")
          .run(`${title(at)} failed ${retries} times: ${failed}`, now, o.id);
        db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
        return { parked: true, stage: at };
      }
      db.query("UPDATE tickets SET retries = ? WHERE id = ?").run(retries, o.id);
      to = stage.on_fail;
    } else if (stage.requires === "ready" && stage.agent && at === o.at && !o.opened) {
      // The pr stage's agent wrote PR.md: the ready rules decide whether the PR opens now
      // (tryPr moves on once it has), or the stage waits and the daemon retries each tick.
      return tryPr(db, { dir: o.dir, repo: o.repo, id: o.id, run, now });
    } else {
      // Retries count failures of one check; only that check passing clears them.
      if (stage.check) db.query("UPDATE tickets SET retries = 0 WHERE id = ?").run(o.id);
      // More than one way on: the blueprint's orchestrator picks (orchestrate.ts); first is the default.
      const options = stage.next ?? [];
      to = options.length > 1 ? chooseNext(db, { dir: o.dir, repo: o.repo, id: o.id, b, at, options, run, now }) : options[0];
    }
    if (!to || to === "end") {
      db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
      db.query("UPDATE tickets SET state = 'ready', updated_at = ? WHERE id = ?").run(now, o.id);
      return { ready: true, stage: at };
    }
    const next = b.stages[to] as BlueprintStage;
    if (next.check) {
      enterStage(db, o.id, title(to), `check: ${next.check}`, plannedPath(b, to).map(title), now);
      at = to;
      failed = runCheck(db, { id: o.id, repo: o.repo, worktree: t.worktree, check: next.check, run, now, dir: o.dir }) ? null : `${next.check} check failed`;
      continue;
    }
    if (next.gate === "human") {
      enterStage(db, o.id, title(to), "waiting on you", plannedPath(b, to).map(title), now);
      db.query("UPDATE tickets SET state = 'ready', updated_at = ? WHERE id = ?").run(now, o.id);
      return { ready: true, stage: to };
    }
    if (!next.agent) {
      enterStage(db, o.id, title(to), null, plannedPath(b, to).map(title), now);
      if (next.requires === "ready") return tryPr(db, { dir: o.dir, repo: o.repo, id: o.id, run, now });
      return { waiting: true, stage: to };
    }
    const terminal = startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, blueprint: b, stage: to });
    return { terminal, stage: to };
  }
  throw new Error("blueprint loops without an agent or a gate");
}

// A checker or reviewer stage is over: its session must have given a verdict. A
// FAIL (or none) fails the stage, so on_fail reruns the stage that fixes it, and
// the blockers go into REVIEW.md, which that stage's brief says to act on.
function stageVerdict(db: Database, o: { dir: string; repo: string; id: number; stage: string; s: Stage | undefined; now: string }) {
  const kind = verdictOf(o.repo, o.s);
  if (!kind) return null;
  const rows = db.query(`SELECT result, detail FROM verdicts WHERE kind = ? AND session = (SELECT MAX(id) FROM sessions WHERE ticket = ? AND stage = ?)`)
    .all(kind, o.id, o.stage) as { result: string; detail: string | null }[];
  if (!rows.length) return { failed: `the ${o.s!.agent} agent ended without a verdict (factory verdict ${o.id} ${kind} pass|fail)` };
  const fails = rows.filter((r) => r.result !== "PASS");
  if (!fails.length) return null;
  const heading = kind === "holdout" ? "Hidden checks failed" : "Blocked in review";
  const undo = note(o.dir, o.id, "REVIEW.md", `${heading} · ${o.now.slice(0, 16).replace("T", " ")} · ${o.s!.agent} agent`, fails.map((f) => `- ${f.detail ?? "no detail given"}`).join("\n"));
  return { failed: `${kind}: ${fails.map((f) => f.detail ?? "failed").join("; ")}`, undo };
}

function verdictFailures(db: Database, id: number, stage: string) {
  return (db.query(`SELECT COUNT(*) AS n FROM sessions s WHERE ticket = ? AND stage = ?
      AND started_at >= COALESCE((SELECT MAX(at) FROM decisions WHERE ticket = s.ticket AND who = 'you'), '')
      AND (NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.session = s.id) OR EXISTS (SELECT 1 FROM verdicts v WHERE v.session = s.id AND v.result = 'FAIL'))`)
    .get(id, stage) as { n: number }).n;
}

// The pr stage: check the ready rules; when they all pass, open the PR and move on
// to the next stage (merge, a human gate by default). Called on entry and every tick.
export function tryPr(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any>;
  const rules = checkReady(db, { dir: o.dir, repo: o.repo, id: o.id, run });
  if (!rulesPass(rules)) {
    const failing = rules.filter((r) => r.result === "fail");
    const detail = `${rules.length - failing.length} of ${rules.length} ready rules · ${failing[0].rule}: ${failing[0].detail}`;
    db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, o.id);
    db.query("UPDATE tickets SET detail = ? WHERE id = ?").run(detail, o.id);
    return { waiting: true, stage: t.stage, failing: failing.length };
  }
  // One draft PR per repo. A cross-repo change's bodies then name each other's PRs.
  const repos = ticketRepos(db, o.id);
  // A request that changes only the account config has no commits to open a PR from: it
  // waits for you at the merge gate, and `m` applies it.
  if (t.blueprint === FACTORY_BLUEPRINT && t.pr_number == null && accountPending(o.dir, o.id) && !changedFiles(run, o.repo, t.worktree).length) {
    db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', 'no PR: only the account config changes', ?, ?)")
      .run(o.id, `${rules.map((r) => `${r.rule} ${r.result}`).join(", ")}; ACCOUNT-CONFIG.md in the ticket's folder shows the diff`, now);
    return advance(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, opened: true });
  }
  const prs = repos.map((r) => {
    const number = openPr(db, { id: o.id, dir: o.dir, worktree: r.worktree!, branch: r.branch!, rules, run, existing: r.pr_number,
      others: repos.filter((x) => x !== r).map((x) => ({ repo: x.repo, pr: x.pr_number })), closes: closesIssue(db, o.id, r, repos.length > 1) });
    setWork(db, o.id, { pr_number: number, pr_watched: 1, pr_checked_at: now }, r.repo);
    return { ...r, pr_number: number };
  });
  if (prs.length > 1 && prs.some((p, i) => repos[i].pr_number == null)) linkPrs(db, o, prs, rules, run);
  // A review round's fixes are pushed: its replies and summary go on the PRs.
  closeRound(db, { ticket: o.id, run, now });
  const others = prs.slice(1).map((p) => `${p.repo}#${p.pr_number}`).join(", ");
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(o.id, `${t.pr_number == null ? "opened" : "updated"} PR #${prs[0].pr_number}`, `${rules.map((r) => `${r.rule} ${r.result}`).join(", ")}${others ? `; with ${others}` : ""}`, now);
  return { ...advance(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, opened: true }), pr: prs[0].pr_number };
}

// New PRs of a cross-repo change didn't know each other's numbers: every body gets them.
function linkPrs(db: Database, o: { dir: string; id: number }, prs: { repo: string; lead: number; worktree: string | null; pr_number: number }[], rules: ReturnType<typeof checkReady>, run: Run) {
  const md = prText(o.dir, o.id);
  const bodyFile = join(o.dir, "tickets", String(o.id), ".pr-body.md");
  for (const p of prs) {
    writeFileSync(bodyFile, prBody(md, rules, prs.filter((x) => x !== p).map((x) => ({ repo: x.repo, pr: x.pr_number })), closesIssue(db, o.id, p, true)));
    const edit = run(["gh", "pr", "edit", String(p.pr_number), "--body-file", bodyFile], p.worktree!);
    if (edit.code !== 0) throw new Error(`gh pr edit failed in ${p.repo}: ${edit.out}`);
  }
}

// `m` on a ready ticket: the human merge gate. The PR was opened as a draft, so it's
// marked ready first (gh refuses to merge a draft), then merged on GitHub the way
// factory.yaml's merge_method says (squash unless it names merge or rebase).
export function mergeTicket(db: Database, o: { repo: string; id: number; run?: Run; now?: string; dir?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT state, pr_number, blueprint FROM ticket_lead WHERE id = ?").get(o.id) as { state: string; pr_number: number | null; blueprint: string } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  // An account-only request: your `m` is the gate; the caller applies the change (applyMergedAccounts).
  if (t.state === "ready" && t.pr_number == null && t.blueprint === FACTORY_BLUEPRINT && o.dir && accountPending(o.dir, o.id)) {
    finishPr(db, { repo: o.repo, id: o.id, run, now, state: "merged", why: "the account config change" });
    return { pr: null, merged: [] as string[] };
  }
  if (t.state !== "ready" || t.pr_number == null) throw new Error(`#${o.id} is ${t.state}${t.pr_number == null ? " with no PR" : ""}; only a ready ticket's PR merges`);
  const method = readFactory(o.repo).merge_method ?? "squash";
  // Every repo's PR, in merge order; it stops at the first that fails. The ones merged
  // stay merged (GitHub can't take them back), so `m` again goes on from the failure.
  const repos = ticketRepos(db, o.id);
  if (repos.some((r) => r.pr_number == null)) throw new Error(`#${o.id} has no PR in ${repos.filter((r) => r.pr_number == null).map((r) => r.repo).join(", ")}`);
  const merged: string[] = [];
  for (const r of mergeOrder(repos).filter((x) => !x.merged_at)) {
    const pr = String(r.pr_number);
    for (const argv of [["gh", "pr", "ready", pr], ["gh", "pr", "merge", pr, `--${method}`]]) {
      const g = run(argv, r.path);
      // `gh pr ready` on a PR that is already ready says so and changes nothing.
      if (g.code !== 0 && !(argv[2] === "ready" && /already .*ready/i.test(g.out))) {
        const failed = `${argv.slice(0, 3).join(" ")} failed${repos.length > 1 ? ` in ${r.repo}` : ""}: ${g.out}`;
        if (!merged.length) throw new Error(failed);
        db.query("UPDATE tickets SET detail = ?, updated_at = ? WHERE id = ?").run(`merged ${merged.join(", ")}; ${failed}`, now, o.id);
        return { pr: t.pr_number, merged, failed };
      }
    }
    setWork(db, o.id, { merged_at: now }, r.repo);
    merged.push(`${r.repo}#${r.pr_number}`);
  }
  finishPr(db, { repo: o.repo, id: o.id, run, now, state: "merged", why: method });
  return { pr: t.pr_number, merged };
}

// `factory merge-order <id> a/b c/d`: the plan's (or your) merge order, every repo once.
export function setMergeOrder(db: Database, o: { id: number; slugs: string[]; now: string }) {
  const t = db.query("SELECT state FROM tickets WHERE id = ?").get(o.id) as { state: string } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state === "merged" || t.state === "closed") throw new Error(`#${o.id} is ${t.state}`);
  const repos = ticketRepos(db, o.id).map((r) => r.repo);
  if (o.slugs.length !== repos.length || !repos.every((r) => o.slugs.includes(r)))
    throw new Error(`name each of #${o.id}'s repos once: ${repos.join(", ")}`);
  o.slugs.forEach((s, i) => setWork(db, o.id, { merge_pos: i }, s));
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(o.id, "you", `merge order: ${o.slugs.join(", ")}`, o.now);
}

// A ticket's PR is over: merged (by `m`, or on GitHub) or closed unmerged. The gate
// ends and, as the plan says, the worktree goes; the branch and the .md files stay.
// A worktree with uncommitted work is left for a person to look at.
export function finishPr(db: Database, o: { repo: string; id: number; run: Run; now: string; state: "merged" | "closed"; why: string | null; who?: string }) {
  const pr = (db.query("SELECT pr_number FROM ticket_lead WHERE id = ?").get(o.id) as { pr_number: number }).pr_number;
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  db.query("DELETE FROM planned WHERE ticket = ?").run(o.id);
  db.query("UPDATE tickets SET state = ?, detail = NULL, needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(o.state, o.now, o.id);
  setWork(db, o.id, { pr_watched: 0, merged_at: o.state === "merged" ? o.now : null });
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(o.id, o.who ?? "you", pr == null ? `${o.state} with no PR` : `${o.state} PR #${pr}`, o.why, o.now);
  // Every repo's worktree goes; one with uncommitted work stays (and so does the space's id).
  const repos = ticketRepos(db, o.id).filter((r) => r.worktree);
  if (repos.length) closeSpace(o.run, (db.query("SELECT space FROM tickets WHERE id = ?").get(o.id) as { space: string | null }).space);
  let left = 0;
  for (const r of repos) {
    if (o.run(["git", "-C", r.path, "worktree", "remove", r.worktree!]).code === 0) setWork(db, o.id, { worktree: null }, r.repo);
    else left++;
  }
  if (repos.length && !left) db.query("UPDATE tickets SET space = NULL WHERE id = ?").run(o.id);
}

// Where a person's note restarts work: an agent stage. A check or gate can't act on a
// note, so a check hands over to its on_fail stage, and anything else to the start.
export function restartStage(b: Blueprint, at: string | null) {
  const s = at ? (b.stages[at] as BlueprintStage | undefined) : undefined;
  if (s?.agent) return at!;
  if (s?.check && s.on_fail && b.stages[s.on_fail]?.agent) return s.on_fail;
  return b.start;
}

// The stage that fixes what review found: the on_fail of the last stage before the pr
// stage that has one (implement in the shipped blueprints), else the start.
export function fixStage(b: Blueprint) {
  const path = [b.start, ...plannedPath(b, b.start)];
  const pr = path.findIndex((n) => (b.stages[n] as BlueprintStage).requires === "ready");
  const before = path.slice(0, pr < 0 ? path.length : pr).reverse().find((n) => (b.stages[n] as BlueprintStage).on_fail);
  return restartStage(b, before ? (b.stages[before] as BlueprintStage).on_fail! : b.start);
}

// Appends a note and returns how to take it back: the file isn't in the transaction,
// so a restart that fails must not leave its note behind to be written twice.
function note(dir: string, id: number, file: string, heading: string, text: string) {
  const folder = join(dir, "tickets", String(id));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, file);
  const had = existsSync(path) ? statSync(path).size : null;
  appendFileSync(path, `${had != null ? "\n" : `# ${file.replace(".md", "")}\n\n`}## ${heading}\n\n${text.trim()}\n`);
  return () => (had == null ? unlinkSync(path) : truncateSync(path, had));
}

function withNote<T>(undo: () => void, fn: () => T): T {
  try { return fn(); } catch (e) { undo(); throw e; }
}

function restart(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; stage: string; b: Blueprint; who: string; why: string; by?: string }) {
  db.query("UPDATE tickets SET state = 'running', needs_kind = NULL, needs_text = NULL, retries = 0, updated_at = ? WHERE id = ?").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(o.id, o.by ?? "you", o.who, o.why, o.now);
  return { stage: o.stage, terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run: o.run, now: o.now, blueprint: o.b, stage: o.stage }) };
}

// `x`: a ready PR goes back with a note. The open PR stays; the pr stage updates it.
export function sendBack(db: Database, o: { dir: string; repo: string; id: number; note: string; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "ready" || t.pr_number == null) throw new Error(`#${o.id} is ${t.state}${t.pr_number == null ? " with no PR" : ""}; only a ready PR goes back`);
  if (!o.note.trim()) throw new Error("say what to change: factory send-back <id> <note…>");
  const b = loadBlueprint(o.repo, t.blueprint);
  const undo = note(o.dir, o.id, "REVIEW.md", `Sent back by you · ${now.slice(0, 16).replace("T", " ")} · PR #${t.pr_number}`, o.note);
  return withNote(undo, () => restart(db, { ...o, run, now, b, stage: fixStage(b), who: `sent PR #${t.pr_number} back`, why: o.note.trim() }));
}

// The PR watcher: reviewers' comments on a ready PR send it back like `x` does, by the daemon.
export function reviewBack(db: Database, o: { dir: string; repo: string; id: number; heading: string; text: string; run: Run; now: string; park?: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any>;
  const b = loadBlueprint(o.repo, t.blueprint);
  const undo = note(o.dir, o.id, "REVIEW.md", o.heading, o.text);
  // Out of unattended review rounds: the comments wait in REVIEW.md, and `u` runs the fix stage.
  if (o.park) {
    db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
    db.query("UPDATE tickets SET state = 'parked', stage = ?, needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?").run(fixStage(b), o.park, o.now, o.id);
    return { parked: true };
  }
  return withNote(undo, () => restart(db, { ...o, b, stage: fixStage(b), who: `review comments on PR #${t.pr_number}`, why: o.heading, by: "daemon" }));
}

// `u`: answer a parked ticket and run the stage it stopped at again.
export function answer(db: Database, o: { dir: string; repo: string; id: number; text: string; run?: Run; now?: string }): Record<string, any> {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  // A proposed split: yes makes the parts, no goes on as one ticket.
  if (t.needs_kind === "question" && pendingParts(db, o.id).length) {
    const yes = /^\s*(y|yes|approve|ok|split)\b/i.test(o.text), no = /^\s*(n|no|reject|keep)\b/i.test(o.text);
    if (yes === no) throw new Error(`#${o.id} has a split proposed: answer approve (make the parts) or reject (one ticket)`);
    return { stage: t.stage, ...decideSplit(db, { dir: o.dir, repo: o.repo, id: o.id, approve: yes, run, now }) };
  }
  if (t.state === "grooming" && t.needs_kind === "question")
    return { stage: "groom", ...answerQuestions(db, { dir: o.dir, repo: o.repo, id: o.id, text: o.text, by: "you", where: "herdr", run, now }) };
  if (t.state !== "parked") throw new Error(`#${o.id} is ${t.state}; only a parked ticket waits for an answer`);
  if (!o.text.trim()) throw new Error("type an answer: factory answer <id> <text…>");
  if (!t.worktree) throw new Error(`#${o.id} has no worktree; factory start ${o.id}`);
  const b = loadBlueprint(o.repo, t.blueprint);
  const undo = note(o.dir, o.id, "GATES.md", `Parked · ${now.slice(0, 16).replace("T", " ")}`, `${t.needs_text ?? "Stopped."}\n\n**Your answer:** ${o.text.trim()}`);
  return withNote(undo, () => restart(db, { ...o, run, now, b, stage: restartStage(b, t.stage), who: "answered and restarted", why: o.text.trim() }));
}

// `p` on a running ticket: its agent stops now; the stage it was in is remembered.
export function pause(db: Database, o: { id: number; run?: Run; now?: string; who?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT state, stage FROM ticket_lead WHERE id = ?").get(o.id) as { state: string; stage: string | null } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "running") throw new Error(`#${o.id} is ${t.state}; only a running ticket pauses`);
  if ((db.query("SELECT location FROM ticket_lead WHERE id = ?").get(o.id) as any).location === "cloud") throw new Error(`#${o.id} is in the cloud; bring it back first (⇧L)`);
  const open_ = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  db.query("UPDATE stages SET ended_at = ?, detail = 'paused' WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  db.query("UPDATE tickets SET state = 'paused', detail = NULL, updated_at = ? WHERE id = ?").run(now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, ?, ?, ?)").run(o.id, o.who ?? "you", `paused at ${t.stage ?? "start"}`, now);
  // Last, so a failed kill (the terminal already gone) leaves the pause recorded.
  for (const s of open_) run(["hc", "kill", s.terminal]);
  return { stage: t.stage, killed: open_.map((s) => s.terminal) };
}

// `p` again: a fresh session for the stage it paused in. The pr stage has no agent;
// it goes back to waiting on the ready rules, which the daemon checks every tick.
export function resume(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "paused") throw new Error(`#${o.id} is ${t.state}; only a paused ticket resumes`);
  if (pendingParts(db, o.id).length) throw new Error(`#${o.id} has a split proposed: factory split ${o.id} approve|reject`);
  if (childrenOf(db, o.id).length) throw new Error(`#${o.id} is split into ${childrenOf(db, o.id).map((c) => `#${c.id}`).join(", ")}; it closes when they're done`);
  // Paused before it ever started (pulled back while queued): "keep" puts it back in the queue.
  if (!t.worktree) {
    db.query("UPDATE tickets SET state = 'queued', needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(now, o.id);
    db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', 'kept it; back in the queue', ?)").run(o.id, now);
    return { stage: null, terminal: null };
  }
  const b = loadBlueprint(o.repo, t.blueprint);
  db.query("UPDATE tickets SET state = 'running', needs_kind = NULL, needs_text = NULL, updated_at = ? WHERE id = ?").run(now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', 'resumed', ?)").run(o.id, now);
  // A pr stage with no agent only waits for its rules; one with an agent (it writes PR.md) reruns.
  if ((b.stages[t.stage] as BlueprintStage | undefined)?.requires === "ready" && !b.stages[t.stage]?.agent) {
    enterStage(db, o.id, title(t.stage), null, plannedPath(b, t.stage).map(title), now);
    return { stage: t.stage, terminal: null };
  }
  const stage = restartStage(b, t.stage);
  return { stage, terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, blueprint: b, stage }) };
}

// `d`: what the ticket changed, as `git diff` text: its worktree (uncommitted work
// too) against where its branch left the repo's current branch. A cross-repo ticket's
// repos come one after another, each path under its repo's name (web/src/app.ts).
export function ticketDiff(db: Database, o: { repo: string; id: number; run?: Run }) {
  const run = o.run ?? sh;
  if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(o.id)) throw new Error(`no ticket ${o.id}`);
  const repos = ticketRepos(db, o.id);
  if (!repos[0].worktree) throw new Error(`#${o.id} has no worktree: it hasn't started, or it merged and its worktree was removed`);
  return repos.filter((r) => r.worktree).map((r) => {
    const base = run(["git", "-C", r.path, "symbolic-ref", "--short", "HEAD"]);
    if (base.code !== 0) throw new Error(`can't tell ${r.repo}'s branch: ${base.out}`);
    const from = run(["git", "-C", r.worktree!, "merge-base", base.out, "HEAD"]);
    if (from.code !== 0) throw new Error(`git merge-base failed: ${from.out}`);
    const prefix = repos.length > 1 ? ["--src-prefix", `a/${r.repo.slice(r.repo.indexOf("/") + 1)}/`, "--dst-prefix", `b/${r.repo.slice(r.repo.indexOf("/") + 1)}/`] : [];
    const diff = run(["git", "-C", r.worktree!, "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", ...prefix, from.out]);
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.out}`);
    return diff.out;
  }).filter(Boolean).join("\n");
}
