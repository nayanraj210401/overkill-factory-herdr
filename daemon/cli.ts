#!/usr/bin/env bun
// `factory`: the CLI agents and people use to change factory state, and
// `factory run`, the daemon. Every change is checked against the status.json
// contract inside its transaction, so a bad write never lands.
import { homedir } from "node:os";
import { writeIfChanged } from "./files.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { recordVerdict } from "./ready.ts";
import { basename, dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { open, setMeta } from "./db.ts";
import { capsOf, intervalOf, isDue, readTriggers, runningByTrigger } from "./triggers.ts";
import { buildStatus, writeStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { parseTokens } from "../lib/model.js";
import { service, servicePid } from "./service.ts";
import { enterStage, writeTicketFiles } from "./ticket.ts";
import { validateAccount, validateDir } from "./validate.ts";
import { accountFile } from "./account.ts";
import { login, newTicket, pollQueue } from "./intake.ts";
import { applyMergedAccounts, proposeAccount, request } from "./maintainer.ts";
import { learnerSuggest, promoteOverrides } from "./learner.ts";
import { noteAttention, waiting } from "./attention.ts";
import { watchPrs } from "./watch.ts";
import { dropTicket, followIssues, reportBlocked } from "./lifecycle.ts";
import { judge } from "./comments.ts";
import { disagreements, examples, label, pushbackGate, runAgreement } from "./agreement.ts";
import { importRoutine, LOG_BRANCH, routineDue, routineSteps, writeRoutine } from "./routine.ts";
import { isAway, setAway } from "./away.ts";
import { startHold } from "./budget.ts";
import { noteCloudFailure, toCloud, toLocal } from "./cloud.ts";
import { bringAll, cloudPolicy, moveAll, noteGap, onSleep, onWake, wakeTick } from "./sleep.ts";
import { powerWatcher } from "./power.ts";
import { sessionState } from "./herdr.ts";
import { recordUsage } from "./usage.ts";
import { watchContext } from "./handoff.ts";
import { buildMetrics, findReverts, setPlan } from "./metrics.ts";
import { writeRuns } from "./runs.ts";
import { validateMetrics } from "../lib/metrics.js";
import { renameSync, writeFileSync } from "node:fs";
import { writeBlueprints } from "./blueprints.ts";
import { draftSource, dryRun as replayDraft, dryRunMarkdown, loadDraft } from "./dryrun.ts";
import { overwatch } from "./overwatch.ts";
import { activeOverrides, addLesson, exportPatch, listLessons, parseValue, retireLesson, setOverride, undoOverride } from "./learn.ts";
import { ask, askMidRun, chooseRepos, pick, readIssueAnswers, startGroomed, startGrooming, startPendingGrooming } from "./groom.ts";
import { hardStopLog, hasHardStop } from "./guard.ts";
import { describePlan, hcAgent, planSuite, runSuite, scheduledSuites, writeBenchmarks } from "./bench.ts";
import { advance, answer, checkReady, readFactory, mergeTicket, setMergeOrder, pause, ticketDiff, resume, sendBack, sh, startTicket, tryPr } from "./runner.ts";
import { migrateFlowStack } from "./migrate.ts";
import { claudeConfig, skipStep, setupSteps, skippedSteps, showSteps, trust, writeSetup } from "./setup.ts";
import { decideSplit, followSplits, pendingParts, proposePart } from "./split.ts";
import { getMeta, leadRepo, listRepos, needLead, setRepo, setWork } from "./db.ts";

const USAGE = `factory <command>   (factory: --name, else $FACTORY_NAME, else this folder's name)
  init [--repo owner/name] [--path dir]  create the factory's database for its lead repo (path: the checkout, default .; repo: its GitHub origin)
  repo [add owner/name --path dir]   the factory's repos; add records a checkout of one factory.yaml's repos: lists
  new <issue link | #n | goal…> [--blueprint b] [--start]  add a ticket (goals get ids from 10000)
  request <the change…>              a change to the factory itself (.factory/ or the account config): the maintainer makes it and it comes back as a PR
  account propose <id>               the maintainer's copy of ~/.factory/config.yaml to edit, in the request's folder (applied when the request merges)
  groom <id>                         the triage agent grooms a ticket that hasn't started
  pick <id> <blueprint>              the blueprint a ticket in grooming runs (triage's pick, or yours)
  repos <id> owner/name…             the repos a ticket that hasn't started works in (the lead is always one)
  question <id> product|engineering <text…>  a grooming question (product ones go to the PO on the issue)
  start <id>                         worktree + first stage + its agent in a herdr-core terminal
  stage-done <id> [--fail reason]    the stage's work is over: follow the blueprint
  budget <id> <in>[/<out>]           set a ticket's token budget: 3M, or 3M/200k
  send-back <id> <note…>             a ready PR goes back to its fix stage with your note (REVIEW.md)
  answer <id> <text…>                answer a parked ticket, or a grooming question ("A2: …" picks one)
  pause <id> | resume <id>           stop a running ticket's agent / rerun the stage it paused in
  split <id> add <title…> [--scope text] [--keeps-work]  propose one part of a ticket that is really several, in order
  split <id> [approve|reject]        list a ticket's proposed parts / make them sub-issues / go on as one ticket
  block <id> <#n>                    report that a ticket waits on issue #n (it resumes when #n closes or merges)
  drop <id>                          remove a ticket's worktrees and close it; the branch and notes stay (keep = resume)
  diff <id>                          what the ticket changed, against the repo's branch
  merge <id>                         merge a ready ticket's PR by merge_method, squash by default (marks it ready first)
  merge-order <id> owner/name…       the order a cross-repo ticket's PRs merge in (default: the others, then the lead)
  ready <id>                         the ready rules for a ticket, as the pr stage sees them
  sessions <id>                      the agent sessions started for a ticket, with their tokens
  cloud <id> | all                   hand a running ticket (or every one) to a Claude Code cloud session; skips what can't move, with a reason
  local <id> | all                   bring a ticket (or every one in the cloud) back and resume it here
  routine [brief]                    write ROUTINE.md, the prompt for a Claude Code scheduled task that watches PRs while you sleep, and print how to set it up
  routine on|off|import              read the task's log branch back every 10 minutes (on), stop (off), or now (import)
  away on|off                        you're away, in every factory: away: (config.yaml, then factory.yaml) applies; Home shows a digest when you're back
  learn set <key> <value> [--why reason]  tune a setting learn.tunable lists, for tickets that start from now on
  learn undo <key> | learn list      drop an override / show the active ones beside the file's value
  learn export                       print the edits that make the overrides permanent, as a patch (never writes .factory/)
  learn suggest <the change…> --why <evidence>  the learner files a change outside learn.tunable as a maintainer request, with its evidence
  lesson add <area> <text…> [--source s]  a lesson for code matching the area glob (src/auth/**); loaded when a ticket touches it
  lesson list [words…] | lesson retire <id>  the store (--json), searched by words / take one out of briefs
  overwatch [--json]                 start the overwatch agent, or print the live one's terminal
  blueprints                         write blueprints.json (stages, runs in 7 days) for the Blueprint page
  dry-run <file|name> [--tickets N] [--json]  replay the last N (default 5) finished tickets through a draft blueprint, no agents; writes DRYRUN.md here
  plan <5h tokens> <week tokens>     your plan's limits, for the 5h and week meters: plan 20M 400M
  usage                              read agents' Claude Code transcripts now (the daemon does every tick)
  queue                              add the Project's Ready issues as grooming tickets now (the daemon: every 3 minutes)
  ticket add <id> <title…> [--blueprint b]
  ticket set <id> <field=value>…     fields: ${"FIELDS"}
  stage <id> <Name> [detail…] [--next A,B]  enter a stage (the current one ends)
  evidence <id> <check> pass|fail [detail…] record a check result
  comment <id> C<n> fix|pushback|escalate <reason…>  the fix agent's verdict on a reviewer's comment
  label <id> C<n> fix|pushback|escalate  your own verdict on a review comment, for the agreement benchmark
  agreement [--dry-run] [--json]     re-judge your past review comments with review.judge_model and record how often it matches you (--dry-run counts them)
  verdict <id> holdout|review pass|fail [detail…] [--by voter]  a checker's or reviewer's verdict
  decide <ticket> <who> <what> [why] log a decision
  setup [--json]                     the first-run checklist: each step ok, missing or skipped, with its fix command
  setup skip|unskip <step>           set a step aside (it stays on the list; rerun setup any time)
  setup trust                        mark the factory's folders trusted in Claude Code, so its agents never stop at that prompt
  setup write [--budget 3M/150k] [--budget-day 40M/2M] [--merge human|auto] [--max-running n] [--queue owner/project]
                                     write .factory/ on branch factory/setup (a temporary worktree; your checkout is untouched)
  migrate flow-stack [--dry-run]     copy decisions, past tasks and lessons count from ~/.flow-stack and .flow/; prints proposals
  bench <name> [--dry-run]           replay a .factory/benchmarks/<name>.yaml suite; --dry-run lists its tasks and variants and runs nothing
  validate [dir] [--json]            check .factory/ files (default ./.factory)
  refresh [id]                       read usage, check agents and watched PRs now, rewrite status and ticket files
  status                             write status.json and print a summary
  run [--interval seconds] [--all] [--force]  the daemon: keep status.json fresh (--all: every factory); refuses while the service runs it
  service install [--login on|off]|uninstall|start|restart|status [--json]  keep \`factory run --all\` alive with launchd (--login: start at login, default on)
  service login on|off               whether the daemon starts at login (off: it runs until you log out; factory service start)
data: $FACTORY_HOME (default ~/.factory)/<name>/`;

// field name → column, and how to read the value.
const FIELDS: Record<string, [string, (v: string) => unknown]> = {
  title: ["title", String], state: ["state", String], blueprint: ["blueprint", String],
  stage: ["stage", nullable], detail: ["detail", nullable], where: ["location", String],
  tokens_in: ["tokens_in", Number], tokens_out: ["tokens_out", Number],
  budget_in: ["budget_in", Number], budget_out: ["budget_out", Number], usd: ["usd", Number],
  pr: ["pr_number", nullableNumber], pr_watched: ["pr_watched", (v) => (v === "true" || v === "1" ? 1 : 0)],
  pr_checked_at: ["pr_checked_at", nullable], needs: ["needs_kind", nullable], needs_text: ["needs_text", nullable],
  blocked_by: ["blocked_by", nullableNumber],
};
const WORK = new Set(["pr_number", "pr_watched", "pr_checked_at"]);
function nullable(v: string) { return v === "" || v === "null" ? null : v; }
function nullableNumber(v: string) { return v === "" || v === "null" ? null : Number(v); }

// Only a terminal the factory labelled for this ticket, and never from tests.
function closeFinished(terminal: string, ticket: number) {
  if (process.env.FACTORY_TEST_SANDBOX) return;
  try {
    const t = JSON.parse(sh(["hc", "get", terminal, "--json"]).out);
    if (t.labels?.["factory.ticket"] !== String(ticket)) return;
  } catch { return; }
  Bun.spawn(["sh", "-c", `sleep 5; hc kill '${terminal}' >/dev/null 2>&1`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");

export function paths(name: string, home = factoryHome()) {
  const dir = join(home, name);
  return { dir, db: join(dir, "factory.db"), status: join(dir, "status.json"), blueprints: join(dir, "blueprints.json"), metrics: join(dir, "metrics.json"), runs: join(dir, "runs.json") };
}

// Runs a change, then refuses it (rolling back) if status.json would break the contract.
export function change(db: Database, fn: () => void) {
  db.transaction(() => {
    fn();
    const errors = validateStatus(buildStatus(db));
    if (errors.length) throw new Error(errors.join("\n"));
  })();
}

function flag(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
}

export function main(argv: string[], log = console.log): void | Promise<void> {
  const args = [...argv];
  const name = flag(args, "name") ?? process.env.FACTORY_NAME ?? basename(process.cwd());
  const loginFlag = flag(args, "login");
  const repo = flag(args, "repo") ?? "unknown";
  const blueprint = flag(args, "blueprint") ?? "feature";
  const interval = Number(flag(args, "interval") ?? 5);
  const next = flag(args, "next");
  const repoPath = flag(args, "path");
  const failReason = flag(args, "fail");
  const budgetFlag = flag(args, "budget");
  const budgetDayFlag = flag(args, "budget-day");
  const mergeFlag = flag(args, "merge");
  const maxRunningFlag = flag(args, "max-running");
  const queueFlag = flag(args, "queue");
  const ticketsFlag = flag(args, "tickets");
  const by = flag(args, "by");
  const why = flag(args, "why");
  const source = flag(args, "source");
  const scope = flag(args, "scope");
  const p = paths(name);
  const all = args.includes("--all");
  const json = args.includes("--json");
  const start = args.includes("--start");
  const dryRun = args.includes("--dry-run");
  const keepsWork = args.includes("--keeps-work");
  const [cmd, sub, ...rest] = args.filter((a) => !["--all", "--json", "--start", "--dry-run", "--keeps-work"].includes(a));
  const now = () => new Date().toISOString();
  if (!cmd || cmd === "help" || cmd === "--help") return log(USAGE.replace('"FIELDS"', Object.keys(FIELDS).join(" ")));
  if (cmd === "service") return service(sub ?? "", { factoryHome: factoryHome(), log, json, arg: rest[0], login: loginFlag ?? undefined });
  if (cmd === "validate") {
    // An account config (the maintainer's ACCOUNT-CONFIG.yaml proposal) is checked as one.
    const accountLike = sub && /(^|\/)(ACCOUNT-CONFIG|config)\.yaml$/.test(sub) && existsSync(sub) && statSync(sub).isFile();
    const results = accountLike ? [{ path: sub, errors: validateAccount(readFileSync(sub, "utf8")) }] : validateDir(sub ?? ".factory");
    if (!sub && existsSync(accountFile())) results.push({ path: accountFile().replace(homedir(), "~"), errors: validateAccount(readFileSync(accountFile(), "utf8")) });
    if (json) return log(JSON.stringify(results));
    for (const r of results) log(r.errors.length ? `✗ ${r.path}\n${r.errors.map((e) => `    ${e}`).join("\n")}` : `✓ ${r.path}`);
    const bad = results.filter((r) => r.errors.length).length;
    if (bad) throw new Error(`${bad} of ${results.length} files have problems`);
    return;
  }
  if (cmd === "run") {
    // The service is the daemon; a second one, by hand, doubles every tick. --force for debugging.
    const pid = servicePid({ factoryHome: factoryHome() });
    if (pid && pid !== process.pid && !args.includes("--force"))
      throw new Error(`the factory service already runs the daemon (pid ${pid}) for ${factoryHome()}; use factory service restart, or factory run --force to run a second one anyway`);
  }
  if (cmd === "run" && all) return runAll(interval, log);
  if (cmd === "bench") return bench(p, args.filter((a) => !a.startsWith("--"))[1], args.includes("--dry-run"), log);
  // Only init makes a factory: a typo'd --name (or the window pointed at sample data)
  // must not leave a stray database for `run --all` to serve.
  if (cmd !== "init" && !existsSync(p.db)) throw new Error(`no factory "${name}" in ${dirname(p.dir)}; run factory init first`);
  const db = open(p.db);
  try {
    if (cmd === "init") {
      const path = resolve(repoPath ?? ".");
      change(db, () => { setMeta(db, "name", name); setRepo(db, { slug: repo !== "unknown" ? repo : originSlug(path) ?? repo, path, lead: true }); });
    } else if (cmd === "setup") {
      const lead = needLead(db);
      if (sub === "skip" || sub === "unskip") {
        change(db, () => skipStep(db, rest[0] ?? "", sub === "skip"));
        log(`${rest[0]}: ${sub === "skip" ? "skipped" : "back on the list"}`);
      } else if (sub === "trust") {
        const added = trust();
        log(added.length ? `Claude Code now trusts ${added.join(" and ")} (in ${claudeConfig()}), so the factory's agents don't stop at "do you trust this folder?"` : "Claude Code trusts the factory's folders already");
        return;
      } else if (sub === "write") {
        const r = writeSetup({ repo: lead.path, name: getMeta(db, "name") ?? name, slug: lead.slug,
          basics: { budget: budgetFlag ?? undefined, budgetDay: budgetDayFlag ?? undefined, merge: mergeFlag ?? undefined, maxRunning: maxRunningFlag === null ? undefined : Number(maxRunningFlag), queue: queueFlag ?? undefined } });
        log(`${r.committed ? `committed ${r.sha} on` : "already up to date on"} ${r.branch}: ${r.files.join(", ")}\nyour checkout (${r.from}) is untouched; review the branch, then merge it: git merge ${r.branch}`);
        return;
      } else if (sub) throw new Error("usage: factory setup [skip|unskip <step> | trust | write [--budget …]]");
      else {
        const steps = setupSteps({ repo: lead.path, skipped: skippedSteps(db) });
        log(json ? JSON.stringify({ steps }) : showSteps(steps));
        return;
      }
    } else if (cmd === "migrate") {
      if (sub !== "flow-stack") throw new Error("usage: factory migrate flow-stack [--dry-run]");
      const lead = needLead(db);
      const listed = existsSync(join(lead.path, ".factory", "blueprints")) ? readdirSync(join(lead.path, ".factory", "blueprints")).map((f) => f.replace(/\.yaml$/, "")) : [];
      change(db, () => { migrateFlowStack(db, { home: process.env.HOME ?? homedir(), repo: lead.path, dir: p.dir, blueprints: listed, dryRun, now: now(), log }); });
    } else if (cmd === "repo") {
      if (sub === "add") {
        const [slug] = rest;
        if (!slug?.includes("/") || !repoPath) throw new Error("usage: factory repo add owner/name --path <dir>");
        const listed = readFactory(needLead(db).path).repos ?? [];
        if (!listed.includes(slug)) throw new Error(`${slug} isn't in factory.yaml's repos: (${listed.join(", ") || "none listed"}); add it there first`);
        if (!existsSync(join(resolve(repoPath), ".git"))) throw new Error(`${resolve(repoPath)} isn't a git checkout`);
        if (leadRepo(db)?.slug === slug) throw new Error(`${slug} is the lead repo; factory init --path moves its checkout`);
        change(db, () => setRepo(db, { slug, path: resolve(repoPath), lead: false }));
      } else if (sub) throw new Error("usage: factory repo [add owner/name --path <dir>]");
      for (const r of listRepos(db)) log(`${r.lead ? "*" : " "} ${r.slug}  ${r.path}`);
      return;
    } else if (cmd === "ticket" && sub === "add") {
      const [id, ...title] = rest;
      if (!Number.isInteger(Number(id)) || !title.length) throw new Error("usage: factory ticket add <id> <title…>");
      change(db, () => db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (?, ?, ?, ?)").run(Number(id), title.join(" "), blueprint, now()));
    } else if (cmd === "ticket" && sub === "set") {
      const [id, ...pairs] = rest;
      const sets = pairs.map((pair) => {
        const at = pair.indexOf("=");
        const field = FIELDS[pair.slice(0, at)];
        if (at < 0 || !field) throw new Error(`unknown field in "${pair}"; fields: ${Object.keys(FIELDS).join(" ")}`);
        return [field[0], field[1](pair.slice(at + 1))] as const;
      });
      if (!sets.length) throw new Error("usage: factory ticket set <id> <field=value>…");
      // The PR fields are the lead repo's work; the rest are the ticket's.
      const work = sets.filter(([c]) => WORK.has(c));
      const own = sets.filter(([c]) => !WORK.has(c));
      change(db, () => {
        const r = db.query(`UPDATE tickets SET ${own.map(([c]) => `${c} = ?, `).join("")}updated_at = ? WHERE id = ?`)
          .run(...own.map(([, v]) => v as any), now(), Number(id));
        if (r.changes === 0) throw new Error(`no ticket ${id}`);
        setWork(db, Number(id), Object.fromEntries(work));
      });
    } else if (cmd === "stage") {
      const [name, ...detail] = rest;
      if (!Number.isInteger(Number(sub)) || !name) throw new Error("usage: factory stage <id> <Name> [detail…] [--next A,B]");
      change(db, () => {
        if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(Number(sub))) throw new Error(`no ticket ${sub}`);
        enterStage(db, Number(sub), name, detail.join(" ") || null, next ? next.split(",").filter(Boolean) : null, now());
      });
    } else if (cmd === "evidence") {
      const [check, result, ...detail] = rest;
      const r = result?.toUpperCase();
      if (!Number.isInteger(Number(sub)) || !check || (r !== "PASS" && r !== "FAIL")) throw new Error("usage: factory evidence <id> <check> pass|fail [detail…]");
      change(db, () => {
        if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(Number(sub))) throw new Error(`no ticket ${sub}`);
        db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (?, ?, ?, ?, ?)").run(Number(sub), check, r, detail.join(" ") || null, now());
      });
    } else if (cmd === "comment") {
      const [c = "", verdict = "", ...why] = rest;
      const n = Number(c.replace(/^C/i, ""));
      if (!Number.isInteger(Number(sub)) || !Number.isInteger(n) || n < 1) throw new Error("usage: factory comment <id> C<n> fix|pushback|escalate <reason…>");
      change(db, () => judge(db, { ticket: Number(sub), n, verdict, reason: why.join(" "), now: now(), repo: leadRepo(db)?.path }));
      log(`#${sub}: C${n} ${verdict}`);
    } else if (cmd === "label") {
      const [c = "", verdict = ""] = rest;
      const n = Number(c.replace(/^C/i, ""));
      if (!Number.isInteger(Number(sub)) || !Number.isInteger(n) || n < 1) throw new Error("usage: factory label <id> C<n> fix|pushback|escalate");
      change(db, () => label(db, { ticket: Number(sub), n, verdict, now: now() }));
      log(`#${sub}: C${n} labelled ${verdict}; factory agreement uses it`);
    } else if (cmd === "agreement") {
      // Not in a change: one model call per comment, and the run writes its rows at the end.
      const lead = needLead(db);
      if (dryRun) {
        const xs = examples(db);
        return log(`${xs.length} labelled comments (${xs.filter((x) => x.source === "you").length} labelled by you, the rest kept at merge)`);
      }
      const r = runAgreement(db, { repo: lead.path, run: sh, now });
      const gate = pushbackGate(db, lead.path);
      if (json) return log(JSON.stringify({ run: r, gate: { ok: gate.ok, why: gate.why, min: gate.min } }));
      log(`agreement with ${r.model}: ${Math.round(r.rate * 100)}% (${r.agreed} of ${r.examples}${r.failed ? `, ${r.failed} unanswered` : ""})`);
      for (const d of disagreements(db, r.id)) log(`  #${d.ticket} C${d.n}: you ${d.yours}, judge ${d.got ?? "none"}${d.why ? ` (${d.why})` : ""}: ${(d.body ?? "").trim().split("\n")[0].slice(0, 80)}`);
      log(`pushbacks while away: ${gate.ok ? "allowed" : "off"}; ${gate.why}`);
      writeMetrics(db, p.metrics);
      return;
    } else if (cmd === "verdict") {
      const [kind, result, ...detail] = rest;
      const r = result?.toUpperCase();
      if (!Number.isInteger(Number(sub)) || (kind !== "holdout" && kind !== "review") || (r !== "PASS" && r !== "FAIL"))
        throw new Error("usage: factory verdict <id> holdout|review pass|fail [detail…] [--by voter]");
      let voter = "";
      change(db, () => { voter = recordVerdict(db, { id: Number(sub), kind, result: r, detail: detail.join(" ") || null, by, now: now() }); });
      log(`#${sub}: ${kind} ${r} from ${voter}`);
    } else if (cmd === "request") {
      // A change to the factory itself, for the maintainer (maintainer.ts): it comes back as a PR.
      const lead = needLead(db);
      let r: any = null;
      change(db, () => { r = request(db, { text: [sub, ...rest].filter(Boolean).join(" "), repo: lead.slug, run: sh, now: now(), dir: p.dir }); });
      log(`#${r.id} ${r.title}: a request for the maintainer; it starts when a slot is free, and the change comes back as a PR for you`);
      writeStatus(db, p.status);
      writeTicketFiles(db, p.dir, r.id);
    } else if (cmd === "account") {
      // The account config isn't in any repo: the maintainer edits a copy in the request's folder.
      if (sub !== "propose" || !Number.isInteger(Number(rest[0]))) throw new Error("usage: factory account propose <request id>");
      const t = db.query("SELECT blueprint FROM tickets WHERE id = ?").get(Number(rest[0])) as { blueprint: string } | null;
      if (t?.blueprint !== "factory") throw new Error(`#${rest[0]} isn't a request for the maintainer`);
      log(`${proposeAccount(p.dir, Number(rest[0]))}: edit this copy; the factory check validates it and the PR shows the diff. It applies when the request merges.`);
      return;
    } else if (cmd === "new") {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      const lead = needLead(db);
      let r: any = null;
      let terminal: string | null = null;
      const cap = capsOf(readTriggers(lead.path).triggers).manual;
      if (start && cap !== undefined && (runningByTrigger(db).manual ?? 0) >= cap) throw new Error(`${cap} manual ticket${cap > 1 ? "s are" : " is"} running already (the manual trigger's concurrency); add it without --start`);
      // A held start still adds the ticket; it waits in the queue.
      const held = start ? startHold(db, lead.path, new Date()) : null;
      change(db, () => {
        r = newTicket(db, { text, repo: lead.slug, blueprint, run: sh, now: now(), groom: !start });
        if (start && !held) terminal = startTicket(db, { dir: p.dir, repo: lead.path, id: r.id });
      });
      log(`#${r.id} ${r.title}${start && !held ? ` started${terminal ? `: agent in ${terminal}` : ""}` : held ? ` queued; not started: ${held}` : " added; the triage agent grooms it, and it starts once nothing is left to ask"}`);
      writeStatus(db, p.status);
      writeTicketFiles(db, p.dir, r.id);
      return;
    } else if (cmd === "repos") {
      const id = Number(sub);
      if (!Number.isInteger(id) || !rest.length) throw new Error("usage: factory repos <id> owner/name…");
      let slugs: string[] = [];
      change(db, () => { slugs = chooseRepos(db, { repo: needLead(db).path, id, slugs: rest, now: now() }); });
      log(`#${id} works in ${slugs.join(", ")}`);
    } else if (cmd === "groom" || cmd === "pick" || cmd === "question") {
      const repoDir = needLead(db).path;
      const id = Number(sub);
      if (!Number.isInteger(id)) throw new Error(`usage: factory ${cmd} <id>…`);
      let out = "";
      const closing: string[] = [];
      change(db, () => {
        if (cmd === "groom") out = `#${id}: triage agent in ${startGrooming(db, { dir: p.dir, repo: repoDir, id, run: sh, now: now() })}`;
        else if (cmd === "pick") { pick(db, { repo: repoDir, id, blueprint: rest[0] ?? "", now: now() }); out = `#${id} runs the ${rest[0]} blueprint`; }
        else if ((db.query("SELECT state FROM tickets WHERE id = ?").get(id) as { state: string } | null)?.state === "running") {
          const q = askMidRun(db, { repo: repoDir, id, kind: rest[0] ?? "", text: rest.slice(1).join(" "), run: sh, now: now() });
          out = `#${id}: Q${q.n} asked; the ticket is parked until it's answered. Stop work now.`;
          closing.push(...q.terminals);
        }
        else out = `#${id}: Q${ask(db, { id, kind: rest[0] ?? "", text: rest.slice(1).join(" "), now: now() })} asked`;
      });
      log(out);
      for (const t of closing) closeFinished(t, id);
    } else if (cmd === "start") {
      const repoDir = needLead(db).path;
      let terminal: string | null = null;
      change(db, () => { terminal = startTicket(db, { dir: p.dir, repo: repoDir, id: Number(sub) }); });
      log(terminal ? `#${sub} started: agent in ${terminal}` : `#${sub} started`);
    } else if (cmd === "stage-done") {
      const repoDir = needLead(db).path;
      let r: any = null;
      const open = db.query("SELECT id, terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(Number(sub)) as { id: number; terminal: string }[];
      change(db, () => { r = advance(db, { dir: p.dir, repo: repoDir, id: Number(sub), failed: failReason ?? undefined }); });
      log(`#${sub}: ${r.split === "asked" ? "a split is proposed; it waits for you (factory split approve|reject)" : r.split ? `split into ${r.children.map((c: number) => `#${c}`).join(", ")}` : r.questions ? `groomed, waiting on ${r.questions} answer${r.questions > 1 ? "s" : ""}` : r.groomed ? `groomed${r.started ? " and started" : ", queued"}` : r.parked ? `parked at ${r.stage}` : r.ready ? `ready (${r.stage})` : r.terminal ? `${r.stage} agent in ${r.terminal}` : `waiting at ${r.stage}`}`);
      // The agent that said it's done is closed a few seconds later (it's usually the one
      // running this command, so it sees the result first). Its transcript stays in Runs.
      const ended = open.filter((s) => (db.query("SELECT ended_at FROM sessions WHERE id = ?").get(s.id) as { ended_at: string | null }).ended_at);
      for (const s of ended) closeFinished(s.terminal, Number(sub));
    } else if (cmd === "budget") {
      const [text = ""] = rest;
      const [input, output] = text.split("/").map(parseTokens);
      if (!input || (text.includes("/") && !output)) throw new Error(`"${text}" isn't a budget; type input tokens, or in/out: 3M, 3M/200k`);
      change(db, () => {
        const t = db.query("SELECT state FROM tickets WHERE id = ?").get(Number(sub)) as { state: string } | null;
        if (!t) throw new Error(`no ticket ${sub}`);
        if (t.state === "merged" || t.state === "closed") throw new Error(`#${sub} is ${t.state}; its budget is final`);
        db.query(`UPDATE tickets SET budget_in = ?${output ? ", budget_out = ?" : ""}, updated_at = ? WHERE id = ?`)
          .run(...([input, ...(output ? [output] : []), now(), Number(sub)] as any[]));
        db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(Number(sub), `set the budget to ${text}`, now());
      });
    } else if (cmd === "send-back" || cmd === "answer") {
      const repoDir = needLead(db).path;
      const text = rest.join(" ");
      let r: any = null;
      change(db, () => {
        r = cmd === "answer" ? answer(db, { dir: p.dir, repo: repoDir, id: Number(sub), text })
          : sendBack(db, { dir: p.dir, repo: repoDir, id: Number(sub), note: text });
      });
      log(r.children ? `#${sub}: split into ${r.children.map((c: number) => `#${c}`).join(", ")}` : r.rejected ? `#${sub}: kept as one ticket` : r.answered ? `#${sub}: answered ${r.answered.map((n: number) => `Q${n}`).join(", ")}; ${r.left ? `${r.left} open` : r.started ? "groomed and started" : "groomed, queued"}`
        : `#${sub}: back to ${r.stage}${r.terminal ? `, agent in ${r.terminal}` : ""}`);
    } else if (cmd === "diff") {
      const repoDir = needLead(db).path;
      return log(ticketDiff(db, { repo: repoDir, id: Number(sub) }));
    } else if (cmd === "pause") {
      let r: any = null;
      change(db, () => { r = pause(db, { id: Number(sub) }); });
      log(`#${sub}: paused at ${r.stage}${r.killed.length ? `; stopped ${r.killed.join(", ")}` : ""}`);
    } else if (cmd === "split") {
      const id = Number(sub);
      const [what, ...words] = rest;
      if (!Number.isInteger(id)) throw new Error("usage: factory split <id> add <title…> [--scope text] [--keeps-work] | approve | reject");
      if (what === "add") {
        let n = 0;
        change(db, () => { n = proposePart(db, { id, title: words.join(" "), scope, keepsWork, now: now() }); });
        log(`#${id}: part ${n} proposed; it's decided when the stage ends`);
      } else if (what === "approve" || what === "reject") {
        let r: any = null;
        change(db, () => { r = decideSplit(db, { dir: p.dir, repo: needLead(db).path, id, approve: what === "approve", run: sh, now: now() }); });
        log(r.children ? `#${id}: split into ${r.children.map((c: number) => `#${c}`).join(", ")}` : `#${id}: kept as one ticket`);
        for (const c of r.children ?? []) writeTicketFiles(db, p.dir, c);
      } else if (!what) {
        const parts = pendingParts(db, id);
        for (const x of parts) log(`${x.n}. ${x.title}${x.scope ? ` — ${x.scope}` : ""}${x.keeps_work ? " (keeps the work)" : ""}`);
        if (!parts.length) log(`#${id}: no split proposed`);
        return;
      } else throw new Error("usage: factory split <id> add <title…> [--scope text] [--keeps-work] | approve | reject");
    } else if (cmd === "block") {
      const by = Number((rest[0] ?? "").replace(/^#/, ""));
      if (!Number.isInteger(by) || by < 1) throw new Error("usage: factory block <id> <#n>");
      change(db, () => reportBlocked(db, { id: Number(sub), by, run: sh, now: now() }));
      log(`#${sub}: blocked by #${by}`);
    } else if (cmd === "drop") {
      let r: any = null;
      change(db, () => { r = dropTicket(db, { id: Number(sub), run: sh, now: now() }); });
      log(`#${sub}: dropped; ${r.removed} worktree${r.removed === 1 ? "" : "s"} removed, the branch stays${r.left ? `; ${r.left} with uncommitted work stays` : ""}`);
    } else if (cmd === "resume") {
      const repoDir = needLead(db).path;
      let r: any = null;
      change(db, () => { r = resume(db, { dir: p.dir, repo: repoDir, id: Number(sub) }); });
      log(`#${sub}: resumed at ${r.stage}${r.terminal ? `, agent in ${r.terminal}` : ""}`);
    } else if (cmd === "merge") {
      const repoDir = needLead(db).path;
      let r: any = null;
      change(db, () => { r = mergeTicket(db, { repo: repoDir, id: Number(sub), dir: p.dir }); });
      change(db, () => applyMergedAccounts(db, { dir: p.dir, now: now(), log }));
      if (r.failed) {
        // The merges that went through are recorded; the ticket stays ready for `m` again.
        writeStatus(db, p.status);
        writeTicketFiles(db, p.dir, Number(sub));
        throw new Error(`#${sub}: merged ${r.merged.join(", ")}, then stopped: ${r.failed}`);
      }
      log(`#${sub}: merged ${r.merged.length > 1 ? r.merged.join(", ") : r.pr == null ? "its account config change" : `PR #${r.pr}`}`);
    } else if (cmd === "merge-order") {
      const id = Number(sub);
      if (!Number.isInteger(id) || !rest.length) throw new Error("usage: factory merge-order <id> owner/name…");
      change(db, () => setMergeOrder(db, { id, slugs: rest, now: now() }));
      log(`#${id} merges ${rest.join(", then ")}`);
    } else if (cmd === "ready") {
      const repoDir = needLead(db).path;
      const rules = checkReady(db, { dir: p.dir, repo: repoDir, id: Number(sub), run: sh });
      for (const r of rules) log(`${r.result === "pass" ? "✓" : r.result === "skipped" ? "–" : "✗"} ${r.rule}: ${r.detail}`);
      return;
    } else if (cmd === "sessions") {
      for (const r of db.query("SELECT s.*, (SELECT SUM(usd) FROM usage u WHERE u.session = s.id) AS usd FROM sessions s WHERE ticket = ? ORDER BY id").all(Number(sub)) as any[])
        log(`${r.started_at.slice(0, 16)}  ${r.stage.padEnd(10)} ${r.terminal ?? "-"}  ${r.ended_at ? "ended" : "open "}  ${JSON.parse(r.argv)[0]}  ${r.tokens_in} in, ${r.tokens_out} out, $${(r.usd ?? 0).toFixed(2)}`);
      return;
    } else if (cmd === "cloud" || cmd === "local") {
      const repoDir = needLead(db).path;
      const ctx = { dir: p.dir, repo: repoDir, run: sh, now: now(), change };
      if (all || sub === "all") {
        // Every ticket at once; each is its own step, so one that can't move is said and the rest go.
        const r = cmd === "cloud" ? moveAll(db, ctx) : bringAll(db, ctx);
        for (const id of r.done) { log(`#${id}: ${cmd === "cloud" ? "in a cloud session" : "back here"}`); writeTicketFiles(db, p.dir, id); }
        for (const x of r.skipped) log(`#${x.id}: skipped: ${x.why}`);
        for (const x of r.failed) log(`#${x.id}: failed: ${x.why}`);
        if (!r.done.length && !r.skipped.length && !r.failed.length) log(cmd === "cloud" ? "no running tickets to move" : "no tickets in the cloud");
        writeStatus(db, p.status);
        return;
      }
      const id = Number(sub);
      if (!Number.isInteger(id)) throw new Error(`usage: factory ${cmd} <id>|all`);
      let r: any = null;
      try { change(db, () => { r = (cmd === "cloud" ? toCloud : toLocal)(db, { dir: p.dir, repo: repoDir, id, run: sh, now: now() }); }); }
      catch (e) { if (cmd === "cloud") change(db, () => noteCloudFailure(db, id, (e as Error).message, now())); throw e; }
      log(cmd === "cloud" ? `#${id}: in a cloud session from ${r.stage}; claude --cloud runs in ${r.terminal}`
        : `#${id}: back${r.parked ? ", parked on the cloud's questions" : ` at ${r.stage}${r.terminal ? `, agent in ${r.terminal}` : ""}`}`);
      writeTicketFiles(db, p.dir, id);
      writeStatus(db, p.status);
      return;
    } else if (cmd === "routine") {
      const lead = needLead(db);
      if (!sub || sub === "brief") {
        let me = "you";
        try { me = login(db, sh, "me"); } catch (e) { log(`(gh login unknown: ${(e as Error).message}; the brief says @you)`); }
        const path = writeRoutine(db, { dir: p.dir, repo: lead.path, slug: lead.slug, me, now: now() });
        for (const l of routineSteps({ path, slug: lead.slug, name })) log(l);
        return;
      } else if (sub === "on" || sub === "off") {
        change(db, () => setMeta(db, "routine_on", sub === "on" ? "1" : "0"));
        log(sub === "on" ? `reading ${LOG_BRANCH} back every 10 minutes` : "not reading the routine's log any more");
      } else if (sub === "import") {
        let r: ReturnType<typeof importRoutine> | null = null;
        change(db, () => { r = importRoutine(db, { dir: p.dir, repo: lead.path, run: sh, now: now() }); });
        log(routineSummary(r!));
        for (const id of r!.tickets) writeTicketFiles(db, p.dir, id);
      } else throw new Error("usage: factory routine [brief|on|off|import]");
    } else if (cmd === "away") {
      if (sub !== "on" && sub !== "off") throw new Error("usage: factory away on|off");
      // You are away, not a repo: every factory under FACTORY_HOME follows.
      const on = sub === "on";
      const moved: string[] = [];
      for (const n of new Set([name, ...factories()])) {
        const other = n === name ? db : open(paths(n).db);
        try {
          if (isAway(other) !== on) { change(other, () => setAway(other, on, now())); moved.push(n); }
          if (other !== db) writeStatus(other, paths(n).status);
        } finally { if (other !== db) other.close(); }
      }
      if (!moved.length) throw new Error(on ? "already away" : "you aren't away");
      log(`${on ? "away: the away policy applies until factory away off" : "back: Home shows what happened while you were away"} (${moved.join(", ")})`);
    } else if (cmd === "learn") {
      const lead = needLead(db);
      if (sub === "set") {
        const [key, ...value] = rest;
        if (!key || !value.length) throw new Error("usage: factory learn set <key> <value> [--why reason]");
        change(db, () => setOverride(db, { key, value: parseValue(value.join(" ")), reason: why, tunable: readFactory(lead.path).learn?.tunable, now: now() }));
        log(`${key} = ${value.join(" ")} for tickets that start from now on`);
      } else if (sub === "undo") {
        if (!rest[0]) throw new Error("usage: factory learn undo <key>");
        change(db, () => undoOverride(db, rest[0], now()));
        log(`${rest[0]} goes back to the file's value for tickets that start from now on`);
      } else if (sub === "list") {
        const on = activeOverrides(db);
        if (json) return log(JSON.stringify(on));
        for (const o of on) log(`${o.key} = ${JSON.stringify(o.value)}  (${o.at.slice(0, 10)}${o.reason ? `: ${o.reason}` : ""})`);
        if (!on.length) log("no overrides");
      } else if (sub === "export") {
        const { patch, notes } = exportPatch(lead.path, activeOverrides(db));
        if (patch) log(patch);
        for (const n of notes) log(`# ${n}`);
        if (!patch && !notes.length) log("# no overrides to export");
      } else if (sub === "suggest") {
        let r: any = null;
        change(db, () => { r = learnerSuggest(db, { dir: p.dir, repo: lead.path, slug: lead.slug, text: rest.join(" "), evidence: why ?? "", run: sh, now: now() }); });
        log(r ? `#${r.id}: a request for the maintainer, from the learner` : "an open request already asks for this");
        if (r) writeTicketFiles(db, p.dir, r.id);
      } else throw new Error("usage: factory learn set|undo|list|export|suggest");
    } else if (cmd === "lesson") {
      if (sub === "add") {
        const [area, ...text] = rest;
        if (!area || !text.length) throw new Error("usage: factory lesson add <area> <text…>");
        let r!: ReturnType<typeof addLesson>;
        change(db, () => { r = addLesson(db, { area, text: text.join(" "), source: source ?? "you", now: now() }); });
        log(r.dup_of ? `lesson ${r.id} added, a near-duplicate of ${r.dup_of}; it stays out of briefs` : `lesson ${r.id} added`);
      } else if (sub === "list") {
        const lessons = listLessons(db, rest.join(" ") || undefined);
        if (json) return log(JSON.stringify(lessons));
        for (const l of lessons) log(`${l.id}  ${l.area}  ${l.text}  (${l.source}, ${l.hits} hits${l.retired_at ? ", retired" : ""}${l.dup_of ? `, near-duplicate of ${l.dup_of}` : ""})`);
        if (!lessons.length) log("no lessons");
      } else if (sub === "retire") {
        if (!Number.isInteger(Number(rest[0]))) throw new Error("usage: factory lesson retire <id>");
        change(db, () => retireLesson(db, Number(rest[0]), now()));
        log(`lesson ${rest[0]} retired`);
      } else throw new Error("usage: factory lesson add|list|retire");
    } else if (cmd === "overwatch") {
      let r: any = null;
      change(db, () => { r = overwatch(db, { name, dir: p.dir, run: sh, now: now() }); });
      return log(json ? JSON.stringify(r) : `overwatch ${r.started ? "started" : "running"} in ${r.terminal}`);
    } else if (cmd === "blueprints") {
      const repoDir = needLead(db).path;
      const doc = writeBlueprints(db, repoDir, p.blueprints);
      log(`${doc.blueprints.map((b) => b.name).join(", ") || "no blueprints"} → ${p.blueprints}`);
      return;
    } else if (cmd === "dry-run") {
      if (!sub) throw new Error("usage: factory dry-run <blueprint file or name> [--tickets N] [--json]");
      const n = ticketsFlag === null ? 5 : Number(ticketsFlag);
      if (!Number.isInteger(n) || n < 1) throw new Error("--tickets takes a whole number of tickets, like --tickets 5");
      const d = replayDraft(db, loadDraft(draftSource(needLead(db).path, sub)), n);
      writeFileSync("DRYRUN.md", dryRunMarkdown(d));
      log(json ? JSON.stringify(d) : `${dryRunMarkdown(d)}\n→ DRYRUN.md`);
      return;
    } else if (cmd === "plan") {
      const [h5, wk] = [parseTokens(sub ?? ""), parseTokens(rest[0] ?? "")];
      if (!h5 || !wk) throw new Error("usage: factory plan <5h tokens> <week tokens>, like factory plan 20M 400M");
      change(db, () => setPlan(db, h5, wk));
      log(`plan meters: ${sub} per 5 hours, ${rest[0]} per week`);
    } else if (cmd === "queue") {
      const repoDir = needLead(db).path;
      const queue = readFactory(repoDir).queue;
      if (!queue?.github_project) throw new Error("factory.yaml has no queue: { github_project: owner/<number or title>, column: Ready, assignee: me }");
      let added: number[] = [];
      change(db, () => { added = pollQueue(db, { queue, repo: needLead(db).slug, run: sh, now: now() }); });
      log(added.length ? `added ${added.map((n) => `#${n}`).join(", ")} to grooming` : "no new issues in the queue");
    } else if (cmd === "usage") {
      change(db, () => recordUsage(db, log));
    } else if (cmd === "decide") {
      const [who, what, why] = rest;
      if (!sub || !who || !what) throw new Error("usage: factory decide <ticket> <who> <what> [why]");
      db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(Number(sub), who, what, why ?? null, now());
    } else if (cmd === "refresh") {
      // The window's Refresh: what a daemon tick does, now, plus the PR check its throttle would skip.
      recordUsage(db, log);
      watchSessions(db, p);
      const lead = leadRepo(db);
      if (lead && lead.slug !== "unknown" && db.query("SELECT 1 FROM tickets t JOIN ticket_repos r ON r.ticket = t.id WHERE t.state = 'ready' AND r.pr_watched = 1").get()) {
        try {
          const me = login(db, sh, "me");
          for (const e of watchPrs(db, { dir: p.dir, repo: lead.path, me, run: sh, now: now(), log })) log(`#${e.id}'s PR: ${e.event}`);
        } catch (e) { log(`not checking PRs: ${(e as Error).message}`); }
      }
      writeAll(db, p);
      return log(sub ? `#${sub} refreshed` : "refreshed");
    } else if (cmd === "status") {
      const s = writeStatus(db, p.status);
      log(`${s.factory.name}: ${s.tickets.length} tickets, daemon ${s.factory.daemon ? "on" : "off"} → ${p.status}`);
      return;
    } else if (cmd === "run") {
      // A tick that fails (a locked database, a gh hiccup) is logged; the next one tries again.
      const tick = () => {
        try { setMeta(db, "heartbeat", now()); recordUsage(db, log); watchSessions(db, p); writeAll(db, p); }
        catch (e) { log(`factory: tick failed: ${(e as Error).message}`); }
      };
      tick();
      log(`factory ${name}: writing ${p.status} every ${interval}s`);
      setInterval(tick, interval * 1000);
      return;
    } else throw new Error(`unknown command "${[cmd, sub].filter(Boolean).join(" ")}"\n${USAGE}`);
    writeStatus(db, p.status);
    const id = cmd === "ticket" ? Number(rest[0]) : Number(sub);
    if (Number.isInteger(id)) writeTicketFiles(db, p.dir, id);
  } finally {
    if (cmd !== "run") db.close();
  }
}

// `factory bench <name>`: the suite's tasks and variants (--dry-run), or the replay itself. It
// waits on agents, so it sits outside main's flow and owns its database handle.
async function bench(p: ReturnType<typeof paths>, name: string | undefined, dryRun: boolean, log: (s: string) => void) {
  if (!name) throw new Error("factory bench <name> [--dry-run]; the suites are in .factory/benchmarks/");
  if (!existsSync(p.db)) throw new Error(`no factory in ${p.dir}; run factory init first`);
  const db = open(p.db);
  try {
    const lead = needLead(db);
    if (dryRun) return void describePlan(planSuite(lead.path, lead.slug, name, sh)).forEach((l) => log(l));
    const r = await runSuite(db, { dir: p.dir, repo: lead.path, slug: lead.slug, name, run: sh, agent: hcAgent(sh), log });
    setMeta(db, `bench_at:${name}`, new Date().toISOString()); // the schedule counts from the last run
    log(`benchmark ${name}: ${r.runs} runs, $${r.spent_usd.toFixed(2)}${r.stopped ? ", stopped at its cap" : ""}; report in ${join(p.dir, "BENCHMARK.md")}`);
    writeRuns(db, p.runs);
  } finally {
    db.close();
  }
}

// Each trigger on its own clock (daemon/triggers.ts). The stamp is written outside the
// change: a failing gh waits its turn like a working one.
export function runTriggers(db: Database, o: { dir: string; repo: string; slug: string; run: typeof sh; now: string; log: (s: string) => void }) {
  for (const t of readTriggers(o.repo).triggers) {
    const ms = intervalOf(t);
    const key = `trigger_at:${t.name}`;
    if (ms === null || !isDue(getMeta(db, key), Date.parse(o.now), ms)) continue;
    if (t.on === "project_ready") {
      setMeta(db, key, o.now);
      try {
        let added: number[] = [];
        change(db, () => { added = pollQueue(db, { queue: readFactory(o.repo).queue, repo: o.slug, run: o.run, now: o.now, trigger: t }); });
        if (added.length) o.log(`factory: ${added.map((n) => `#${n}`).join(", ")} joined from the queue`);
      } catch (e) {
        o.log(`factory: reading the queue: ${(e as Error).message}`);
      }
    } else if (t.on === "pr_review_comment") {
      // Factory PRs waiting on you: merged or closed on GitHub, or new review comments.
      if (o.slug === "unknown") continue;
      setMeta(db, key, o.now);
      if (!db.query("SELECT 1 FROM tickets t JOIN ticket_repos r ON r.ticket = t.id WHERE t.state = 'ready' AND r.pr_watched = 1").get()) continue;
      let me: string | null = null;
      try { me = login(db, o.run, "me"); } catch (e) { o.log(`factory: not watching PRs: ${(e as Error).message}`); }
      if (me) for (const e of watchPrs(db, { dir: o.dir, repo: o.repo, me, run: o.run, now: o.now, log: o.log })) o.log(`factory: #${e.id}'s PR: ${e.event}`);
    } else if (t.on === "schedule") {
      setMeta(db, key, o.now);
      if ((runningByTrigger(db)[t.name] ?? 0) >= (t.concurrency ?? Infinity)) continue;
      try {
        let id = 0;
        change(db, () => {
          id = newTicket(db, { text: `${t.name}, ${o.now.slice(0, 16).replace("T", " ")}`, repo: o.slug, blueprint: t.blueprint, run: o.run, now: o.now, trigger: t.name }).id;
          startTicket(db, { dir: o.dir, repo: o.repo, id, run: o.run, now: o.now });
        });
        o.log(`factory: #${id} started by ${t.name}`);
      } catch (e) {
        o.log(`factory: trigger ${t.name}: ${(e as Error).message}`);
      }
    }
  }
}

// A suite's `schedule:` is a clock of its own, like a trigger's `every`. A run takes hours,
// so it starts as its own `factory bench` process instead of holding up the daemon's tick.
// The stamp is written first: a suite that fails waits for its next turn like one that works.
// A suite the daemon sees for the first time is stamped, not run: it costs real money, so
// the first run is one interval away (or `factory bench`, which stamps too).
export function runScheduledBenchmarks(db: Database, o: { repo: string; name: string; now: string; log: (s: string) => void; launch: (argv: string[]) => void }) {
  for (const s of scheduledSuites(o.repo)) {
    const key = `bench_at:${s.name}`;
    const last = getMeta(db, key);
    if (last && !isDue(last, Date.parse(o.now), s.ms)) continue;
    setMeta(db, key, o.now);
    if (!last) continue;
    o.launch(["bun", import.meta.path, "bench", s.name, "--name", o.name]);
    o.log(`factory: benchmark ${s.name} started`);
  }
}

// Detached, so a restart of the daemon doesn't kill a night's run. Never from a test.
const spawnDetached = (argv: string[]) => {
  if (process.env.FACTORY_TEST_SANDBOX) throw new Error("a test tried to start a real benchmark process");
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], env: process.env }).unref();
};
// An agent whose terminal exited without calling stage-done has still finished its turn.
export function watchSessions(db: Database, p: ReturnType<typeof paths>, run = sh, log = console.log) {
  const lead = leadRepo(db);
  if (!lead) return;
  const repoDir = lead.path;
  // Sessions near their context limit: asked to hand off, or replaced by the next one. Before the exits below see them.
  change(db, () => watchContext(db, { dir: p.dir, repo: repoDir, run, now: new Date().toISOString(), log }));
  // A ticket in the cloud is out of sight until ⇧L brings it back: its sessions aren't watched.
  const open_ = db.query(`SELECT s.id, s.ticket, s.terminal, s.in_space, s.agent_seen, s.started_at FROM sessions s JOIN tickets t ON t.id = s.ticket
    WHERE s.ended_at IS NULL AND s.terminal IS NOT NULL AND t.location != 'cloud'`).all() as
    { id: number; ticket: number; terminal: string; in_space: number; agent_seen: number; started_at: string }[];
  // Tickets waiting at the pr stage: their rules may pass now (a new PR.md, new evidence).
  // A pr stage whose agent is still writing PR.md waits for it.
  for (const { id } of db.query(`SELECT id FROM tickets t WHERE state = 'running' AND stage = 'pr' AND location != 'cloud'
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.ticket = t.id AND s.ended_at IS NULL)`).all() as { id: number }[]) {
    try {
      let r: any;
      change(db, () => { r = tryPr(db, { dir: p.dir, repo: repoDir, id, run }); });
      if (r.pr) log(`factory: #${id} opened PR #${r.pr}`);
    } catch (e) {
      log(`factory: #${id}: ${(e as Error).message}`);
    }
  }
  // Grooming answers given on issues, read at most once a minute (each is a gh call).
  const nowIso = new Date().toISOString();
  const lastRead = getMeta(db, "issues_read_at");
  if (!lastRead || Date.now() - Date.parse(lastRead) >= 60_000) {
    setMeta(db, "issues_read_at", nowIso); // outside the change: a failing gh waits a minute too
    try { change(db, () => { readIssueAnswers(db, { dir: p.dir, repo: repoDir, run, now: nowIso, log }); }); }
    catch (e) { log(`factory: reading issue answers: ${(e as Error).message}`); }
  }
  // What the cloud PR watch did while the laptop slept, before the watcher sees the same comments.
  if (routineDue(db, Date.now())) {
    try {
      let r: ReturnType<typeof importRoutine> | null = null;
      change(db, () => { r = importRoutine(db, { dir: p.dir, repo: repoDir, run, now: nowIso }); });
      if (r!.applied || r!.bad) log(`factory: ${routineSummary(r!)}`);
    } catch (e) { log(`factory: reading the routine's log: ${(e as Error).message}`); }
  }
  runTriggers(db, { dir: p.dir, repo: repoDir, slug: lead.slug, run, now: nowIso, log });
  // Issues of running and queued tickets: blocked, scope changed, pulled back (every 5 minutes).
  try { followIssues(db, { dir: p.dir, repo: repoDir, run, now: nowIso, log }); }
  catch (e) { log(`factory: following issues: ${(e as Error).message}`); }
  try {
    let groomed: number[] = [];
    change(db, () => { groomed = startPendingGrooming(db, { dir: p.dir, repo: repoDir, run, now: nowIso, log }); });
    for (const id of groomed) log(`factory: #${id}: triage started`);
  } catch (e) {
    log(`factory: starting triage: ${(e as Error).message}`);
  }
  // A merged request's account config change applies; an override that held files its request.
  try { change(db, () => applyMergedAccounts(db, { dir: p.dir, now: nowIso, log })); }
  catch (e) { log(`factory: applying the account config: ${(e as Error).message}`); }
  const lastLearn = getMeta(db, "learner_checked_at");
  if (!lastLearn || Date.now() - Date.parse(lastLearn) >= 600_000) {
    setMeta(db, "learner_checked_at", nowIso);
    try { change(db, () => { for (const r of promoteOverrides(db, { dir: p.dir, repo: repoDir, slug: lead.slug, run, now: nowIso })) log(`factory: #${r.id}: the learner asks the maintainer to ${r.title}`); }); }
    catch (e) { log(`factory: the learner: ${(e as Error).message}`); }
  }
  // Merged PRs someone reverted, every 10 minutes, for the revert rate.
  const lastReverts = getMeta(db, "reverts_checked_at");
  if (!lastReverts || Date.now() - Date.parse(lastReverts) >= 600_000) {
    setMeta(db, "reverts_checked_at", nowIso);
    try { change(db, () => { for (const id of findReverts(db, { repo: lead.slug, run, now: nowIso })) log(`factory: #${id}'s PR was reverted`); }); }
    catch (e) { log(`factory: checking reverts: ${(e as Error).message}`); }
  }
  // Split tickets: a part goes on once the one before it is done; a parent closes after its last part.
  try { change(db, () => followSplits(db, { dir: p.dir, repo: repoDir, run, now: nowIso, log })); }
  catch (e) { log(`factory: following splits: ${(e as Error).message}`); }
  // Groomed tickets waiting for room: one starts as another stops running.
  try {
    let started: number[] = [];
    change(db, () => { started = startGroomed(db, { dir: p.dir, repo: repoDir, run, now: nowIso, log }); });
    for (const id of started) log(`factory: #${id} groomed; started`);
  } catch (e) {
    log(`factory: starting groomed tickets: ${(e as Error).message}`);
  }
  for (const s of open_) {
    const r = run(["hc", "get", s.terminal, "--json"]);
    let state = "exited";
    let info: any = null;
    try { if (r.code === 0) { info = JSON.parse(r.out); state = sessionState(info); } } catch {}
    // In a tab the shell outlives the agent: done once the agent was seen and the shell is back.
    if (s.in_space && state === "agent" && !s.agent_seen) db.query("UPDATE sessions SET agent_seen = 1 WHERE id = ?").run(s.id);
    // An agent quicker than a tick is never seen: a shell idle a minute after the start means it's over.
    const idle = Date.now() - Date.parse(s.started_at) > 60_000;
    // A hard stop the guard noted ends the session now: kill it, and advance parks the ticket.
    const stopped = hasHardStop(hardStopLog(p.dir, s.ticket));
    if (stopped && state !== "exited") run(["hc", "kill", s.terminal]);
    const gone = stopped || state === "exited" || (s.in_space === 1 && state === "shell" && (s.agent_seen === 1 || idle));
    // Waiting on you in its terminal (a question, a prompt): Needs you says so until it moves on.
    try {
      let noted: string | null = null;
      change(db, () => { noted = noteAttention(db, { ticket: s.ticket, terminal: s.terminal, waiting: !gone && waiting(info, { startedAt: s.started_at, now: Date.now() }), now: nowIso }); });
      if (noted === "waiting") log(`factory: #${s.ticket}'s agent in ${s.terminal} is waiting on you`);
    } catch (e) { log(`factory: #${s.ticket}: ${(e as Error).message}`); }
    if (!gone) continue;
    try {
      change(db, () => advance(db, { dir: p.dir, repo: repoDir, id: s.ticket, run }));
      log(`factory: #${s.ticket}'s agent in ${s.terminal} finished; advanced`);
    } catch (e) {
      log(`factory: #${s.ticket}: ${(e as Error).message}`);
    }
  }
}

// status.json plus every ticket's files, so "12m so far" keeps counting.
function writeAll(db: Database, p: ReturnType<typeof paths>) {
  const s = writeStatus(db, p.status);
  const lead = leadRepo(db);
  if (lead) writeBlueprints(db, lead.path, p.blueprints);
  writeMetrics(db, p.metrics);
  writeRuns(db, p.runs);
  writeBenchmarks(db, p.dir);
  for (const t of s.tickets) writeTicketFiles(db, p.dir, t.id);
}

// metrics.json for the Metrics page, checked against lib/metrics.js and written atomically.
export function writeMetrics(db: Database, path: string, now = new Date()) {
  const doc = buildMetrics(db, now);
  const errors = validateMetrics(doc);
  if (errors.length) throw new Error(`metrics.json would break the contract:\n${errors.join("\n")}`);
  writeIfChanged(path, JSON.stringify(doc) + "\n");
  return doc;
}

const routineSummary = (r: ReturnType<typeof importRoutine>) => r.missing
  ? `no ${LOG_BRANCH} branch on origin yet`
  : `routine log: ${r.applied} comment${r.applied === 1 ? "" : "s"} handled in the cloud${r.tickets.length ? ` (${r.tickets.map((t) => `#${t}`).join(", ")})` : ""}, ${r.known} already judged here${r.unknown ? `, ${r.unknown} on PRs this factory doesn't know` : ""}${r.bad ? `, ${r.bad} unreadable lines` : ""}`;

// owner/name from a checkout's origin on GitHub (ssh or https), for init without --repo.
export function originSlug(path: string) {
  const r = Bun.spawnSync(["git", "-C", path, "remote", "get-url", "origin"], { env: process.env });
  return r.exitCode === 0 ? r.stdout.toString().trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null : null;
}

// One daemon for every factory under FACTORY_HOME; new ones are picked up on the next tick.
export function factories(home = factoryHome()) {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db")));
}

// Sleep and wake, for every factory whose cloud.on_sleep is move (daemon/sleep.ts).
function sleepWake(open_: Record<string, Database>, factoryHome_: string, interval: number, log: (s: string) => void) {
  const each = (fn: (db: Database, p: ReturnType<typeof paths>, repo: string) => void) => {
    for (const name of factories()) {
      const p = paths(name);
      const db = (open_[name] ??= open(p.db));
      const lead = leadRepo(db);
      if (!lead) continue;
      try { fn(db, p, lead.path); } catch (e) { log(`factory ${name}: ${(e as Error).message}`); }
    }
  };
  const ctx = (p: ReturnType<typeof paths>, repo: string) => ({ dir: p.dir, repo, run: sh, now: new Date().toISOString(), log, change });
  const ensure = powerWatcher({
    factoryHome: factoryHome_, log,
    wanted: () => { let w = false; each((_, __, repo) => { if (cloudPolicy(repo).on_sleep === "move") w = true; }); return w; },
    handlers: {
      sleep: () => each((db, p, repo) => { const r = onSleep(db, ctx(p, repo)); if (r) { log(`factory: sleeping: ${r.done.length} to the cloud, ${r.skipped.length} stay, ${r.failed.length} failed`); writeAll(db, p); } }),
      wake: () => setTimeout(() => each((db, p, repo) => { const r = onWake(db, ctx(p, repo)); if (r) { log(`factory: woke: ${r.done.length} back, ${r.failed.length} to retry`); writeAll(db, p); } }), 8000), // the network needs a moment
    },
  });
  return (db: Database, p: ReturnType<typeof paths>, repo: string) => {
    noteGap(db, { ...ctx(p, repo), interval });
    wakeTick(db, ctx(p, repo));
    ensure();
  };
}

function runAll(interval: number, log: (s: string) => void) {
  const open_: Record<string, Database> = {};
  const power = sleepWake(open_, factoryHome(), interval, log);
  const tick = () => {
    for (const name of factories()) {
      const p = paths(name);
      const db = (open_[name] ??= open(p.db));
      try {
        setMeta(db, "heartbeat", new Date().toISOString());
        const lead0 = leadRepo(db);
        if (lead0) power(db, p, lead0.path);
        recordUsage(db, log);
        watchSessions(db, p, sh, log);
        const lead = leadRepo(db);
        if (lead) runScheduledBenchmarks(db, { repo: lead.path, name, now: new Date().toISOString(), log, launch: spawnDetached });
        writeAll(db, p);
      } catch (e) {
        log(`factory ${name}: ${(e as Error).message}`);
      }
    }
  };
  tick();
  log(`factory: serving ${factories().join(", ") || "no factories yet"} under ${factoryHome()}, every ${interval}s`);
  setInterval(tick, interval * 1000);
}

if (import.meta.main) {
  const fail = (e: unknown) => { console.error(`factory: ${(e as Error).message}`); process.exit(1); };
  try {
    Promise.resolve(main(process.argv.slice(2))).catch(fail);
  } catch (e) {
    fail(e);
  }
}
