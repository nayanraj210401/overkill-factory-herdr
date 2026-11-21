// The graph runner's first half: a ticket gets its own worktree (a Herdr worktree
// space when the app runs), enters its blueprint's first stage, and that stage's
// agent starts in a tab there, or in a free-floating herdr-core terminal.
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateFile } from "./validate.ts";
import { enterStage } from "./ticket.ts";
import { openPr, readyRules, rulesPass } from "./ready.ts";
import { closeSpace, openAgent, worktreePath } from "./herdr.ts";

export type Run = (argv: string[], cwd?: string) => { code: number; out: string };
export const sh: Run = (argv, cwd) => {
  const r = Bun.spawnSync(argv, { cwd });
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

type Stage = { agent?: string; check?: string; next?: string[]; output?: string };
type Blueprint = { name: string; start: string; stages: Record<string, Stage> };

function readYaml(repo: string, path: string) {
  const file = join(repo, ".factory", path);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const errors = validateFile(path, text);
  if (errors.length) throw new Error(`.factory/${path}: ${errors[0]}`);
  return text;
}

export function loadBlueprint(repo: string, name: string): Blueprint {
  const text = readYaml(repo, `blueprints/${name}.yaml`) ?? (name === "default" ? readYaml(repo, "blueprint.yaml") : null);
  if (!text) throw new Error(`no blueprint "${name}" in ${repo}/.factory/blueprints/`);
  return Bun.YAML.parse(text) as Blueprint;
}

export function loadAgent(repo: string, name: string) {
  const text = readYaml(repo, `agents/${name}.md`);
  if (!text) return null;
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  return { ...(Bun.YAML.parse(m[1]) as Record<string, any>), prompt: m[2].trim() };
}

// The path the blueprint would take with no surprises: the first `next` each time.
export function plannedPath(b: Blueprint, from: string) {
  const path: string[] = [];
  for (let at = b.stages[from]?.next?.[0]; at && at !== "end" && !path.includes(at); at = b.stages[at]?.next?.[0]) path.push(at);
  return path;
}

const title = (id: string) => (id.length <= 2 ? id.toUpperCase() : id[0].toUpperCase() + id.slice(1)); // pr → PR
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// A session starts from files, not chat: the brief names them (plan: Worktrees and sessions).
export function brief(t: { id: number; title: string }, stage: string, prompt: string | null, folder: string) {
  return [
    `Ticket #${t.id}: ${t.title}. You run its ${stage} stage.`,
    prompt ?? "",
    `Read ${folder}/STATUS.md and any INTENT.md, SLICES.md and HANDOFF.md there before you start.`,
    `If REVIEW.md or GATES.md is there, act on every note in it from a person: they sent this ticket back or answered why it stopped.`,
    `When the stage's work is done, run: factory stage-done ${t.id}`,
  ].filter(Boolean).join("\n\n");
}

export function argvFor(agent: { harness?: string; model?: string } | null, defaults: { harness: string; model?: string }, text: string) {
  const harness = agent?.harness ?? defaults.harness;
  const model = agent?.model ?? defaults.model;
  if (harness === "claude") return ["claude", ...(model ? ["--model", model] : []), text];
  if (harness === "codex") return ["codex", ...(model ? ["--model", model] : []), text];
  return [harness, text]; // any other program gets the brief as its last argument
}

export function startTicket(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!["queued", "grooming"].includes(t.state) || t.needs_kind) throw new Error(`#${o.id} is ${t.state}${t.needs_kind ? " with open questions" : ""}; only a groomed or queued ticket starts`);
  const b = loadBlueprint(o.repo, t.blueprint);
  const branch = `factory/${o.id}-${slug(t.title)}`;
  const worktree = worktreePath(o.repo, branch);
  mkdirSync(dirname(worktree), { recursive: true });
  // Idempotent: a start that failed after this step (its rows rolled back) left the
  // branch and checkout behind; reuse them, as Herdr's New worktree does a branch.
  const here = existsSync(worktree) && run(["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).out === branch;
  if (!here) {
    const known = run(["git", "-C", o.repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
    const wt = run(["git", "-C", o.repo, "worktree", "add", ...(known ? [worktree, branch] : ["-b", branch, worktree])]);
    if (wt.code !== 0) throw new Error(`git worktree add failed: ${wt.out}`);
  }
  db.query("UPDATE tickets SET state = 'running', worktree = ?, branch = ? WHERE id = ?").run(worktree, branch, o.id);
  return startStage(db, { ...o, run, now, blueprint: b, stage: b.start });
}

export function startStage(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; blueprint: Blueprint; stage: string }) {
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any>;
  const s = o.blueprint.stages[o.stage];
  if (!s) throw new Error(`blueprint ${o.blueprint.name} has no stage "${o.stage}"`);
  enterStage(db, o.id, title(o.stage), s.agent ? `${s.agent} agent` : s.check ? `check: ${s.check}` : null, plannedPath(o.blueprint, o.stage).map(title), o.now);
  if (!s.agent) return null; // check and gate stages are the daemon's own (D4b)
  const agent = loadAgent(o.repo, s.agent);
  const defaults = { harness: "claude", model: "sonnet" };
  const argv = argvFor(agent, defaults, brief(t as any, o.stage, agent?.prompt ?? null, join(o.dir, "tickets", String(o.id))));
  const name = `f${o.id}-${o.stage}`.slice(0, 32);
  const labels = [`factory.ticket=${o.id}`, `factory.stage=${o.stage}`];
  const made = openAgent(o.run, { folder: t.worktree, space: t.space, name: o.stage, argv });
  let terminal: string;
  if (made) {
    terminal = made.terminal;
    o.run(["hc", "label", terminal, ...labels]);
    db.query("UPDATE tickets SET space = ? WHERE id = ?").run(made.space, o.id);
  } else {
    const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", t.worktree,
      ...labels.flatMap((l) => ["--label", l]), ...argv]);
    if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
    terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  }
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.id, o.stage, s.agent, terminal, JSON.stringify(argv), o.now, made ? 1 : 0);
  return terminal;
}

type Factory = { quality_floor?: string[]; ready?: string[] };
const DEFAULT_READY = ["evidence", "holdout", "quality_floor", "review", "template", "budget"];
const readFactory = (repo: string): Factory => {
  const text = readYaml(repo, "factory.yaml");
  return text ? (Bun.YAML.parse(text) as Factory) : {};
};

// A check stage the daemon runs itself. Returns whether it passed, after recording evidence.
export function runCheck(db: Database, o: { id: number; repo: string; worktree: string; check: string; run: Run; now: string }) {
  const record = (name: string, ok: boolean, detail: string) =>
    db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (?, ?, ?, ?, ?)").run(o.id, name, ok ? "PASS" : "FAIL", detail, o.now);
  if (o.check === "tests" || o.check === "lint") {
    const commands = readFactory(o.repo).quality_floor ?? [];
    if (!commands.length) { record(o.check, false, "factory.yaml has no quality_floor commands"); return false; }
    let ok = true;
    for (const c of commands) {
      const r = o.run(["sh", "-c", c], o.worktree);
      // Agents see the first failing lines; full logs stay out of the prompt (PRD 6.10).
      const tail = r.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 200);
      record(c, r.code === 0, r.code === 0 ? "passed" : `exit ${r.code}: ${tail}`);
      ok &&= r.code === 0;
    }
    return ok;
  }
  if (o.check === "evidence") {
    // Every check's latest result must be a PASS, and there must be at least one.
    const latest = db.query(`SELECT check_name, result FROM evidence e WHERE ticket = ? AND id = (SELECT MAX(id) FROM evidence WHERE ticket = e.ticket AND check_name = e.check_name)`).all(o.id) as { result: string }[];
    const ok = latest.length > 0 && latest.every((r) => r.result === "PASS");
    record("evidence", ok, ok ? `${latest.length} checks pass` : latest.length ? `${latest.filter((r) => r.result !== "PASS").length} failing` : "no checks recorded");
    return ok;
  }
  throw new Error(`unknown check "${o.check}"`);
}

type BlueprintStage = Stage & { on_fail?: string; max_retries?: number; gate?: string; requires?: string };

// The current stage's work is over (an agent said so, its terminal exited, or a
// check ran): close its session, then follow the blueprint until something waits.
export function advance(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string; failed?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t || t.state !== "running") throw new Error(`#${o.id} isn't running`);
  const b = loadBlueprint(o.repo, t.blueprint);
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  let at = t.stage as string;
  let failed = o.failed ?? null;
  for (let hops = 0; hops < 50; hops++) {
    const stage = b.stages[at] as BlueprintStage;
    let to: string | undefined;
    if (failed) {
      const retries = (db.query("SELECT retries FROM tickets WHERE id = ?").get(o.id) as any).retries + 1;
      if (!stage.on_fail || retries > (stage.max_retries ?? 3)) {
        db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ?, updated_at = ? WHERE id = ?")
          .run(`${title(at)} failed ${retries} times: ${failed}`, now, o.id);
        db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
        return { parked: true, stage: at };
      }
      db.query("UPDATE tickets SET retries = ? WHERE id = ?").run(retries, o.id);
      to = stage.on_fail;
    } else {
      // Retries count failures of one check; only that check passing clears them.
      if (stage.check) db.query("UPDATE tickets SET retries = 0 WHERE id = ?").run(o.id);
      to = stage.next?.[0]; // the orchestrator agent picks among `next` later; first is the default
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
      failed = runCheck(db, { id: o.id, repo: o.repo, worktree: t.worktree, check: next.check, run, now }) ? null : `${next.check} check failed`;
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

// The pr stage: check the ready rules; when they all pass, open the PR and move on
// to the next stage (merge, a human gate by default). Called on entry and every tick.
export function tryPr(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any>;
  const rules = readyRules(db, { id: o.id, dir: o.dir, worktree: t.worktree, rules: readFactory(o.repo).ready ?? DEFAULT_READY, run });
  if (!rulesPass(rules)) {
    const failing = rules.filter((r) => r.result === "fail");
    const detail = `${rules.length - failing.length} of ${rules.length} ready rules · ${failing[0].rule}: ${failing[0].detail}`;
    db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, o.id);
    db.query("UPDATE tickets SET detail = ? WHERE id = ?").run(detail, o.id);
    return { waiting: true, stage: t.stage, failing: failing.length };
  }
  const number = openPr(db, { id: o.id, dir: o.dir, worktree: t.worktree, branch: t.branch, rules, run, existing: t.pr_number });
  db.query("UPDATE tickets SET pr_number = ?, pr_watched = 1, pr_checked_at = ? WHERE id = ?").run(number, now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(o.id, `${t.pr_number == null ? "opened" : "updated"} PR #${number}`, rules.map((r) => `${r.rule} ${r.result}`).join(", "), now);
  return { ...advance(db, { dir: o.dir, repo: o.repo, id: o.id, run, now }), pr: number };
}

// `m` on a ready ticket: the human merge gate. The PR was opened as a draft, so it's
// marked ready first (gh refuses to merge a draft), then squash-merged on GitHub.
export function mergeTicket(db: Database, o: { repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT state, pr_number FROM tickets WHERE id = ?").get(o.id) as { state: string; pr_number: number | null } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "ready" || t.pr_number == null) throw new Error(`#${o.id} is ${t.state}${t.pr_number == null ? " with no PR" : ""}; only a ready ticket's PR merges`);
  const pr = String(t.pr_number);
  for (const argv of [["gh", "pr", "ready", pr], ["gh", "pr", "merge", pr, "--squash"]]) {
    const r = run(argv, o.repo);
    // `gh pr ready` on a PR that is already ready says so and changes nothing.
    if (r.code !== 0 && !(argv[2] === "ready" && /already .*ready/i.test(r.out))) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.out}`);
  }
  db.query("UPDATE stages SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  db.query("DELETE FROM planned WHERE ticket = ?").run(o.id);
  db.query("UPDATE tickets SET state = 'merged', detail = NULL, pr_watched = 0, updated_at = ? WHERE id = ?").run(now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'you', ?, 'squash', ?)").run(o.id, `merged PR #${pr}`, now);
  // The plan: the worktree goes once the PR merges; the branch and the ticket's .md files stay.
  // A worktree with uncommitted work is left for a person to look at.
  const w = db.query("SELECT worktree, space FROM tickets WHERE id = ?").get(o.id) as { worktree: string | null; space: string | null };
  if (w.worktree) {
    closeSpace(run, w.space);
    const rm = run(["git", "-C", o.repo, "worktree", "remove", w.worktree]);
    if (rm.code === 0) db.query("UPDATE tickets SET worktree = NULL, space = NULL WHERE id = ?").run(o.id);
  }
  return { pr: t.pr_number };
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

function note(dir: string, id: number, file: string, heading: string, text: string) {
  const folder = join(dir, "tickets", String(id));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, file);
  appendFileSync(path, `${existsSync(path) ? "\n" : `# ${file.replace(".md", "")}\n\n`}## ${heading}\n\n${text.trim()}\n`);
}

function restart(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; stage: string; b: Blueprint; who: string; why: string }) {
  db.query("UPDATE tickets SET state = 'running', needs_kind = NULL, needs_text = NULL, retries = 0, updated_at = ? WHERE id = ?").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'you', ?, ?, ?)").run(o.id, o.who, o.why, o.now);
  return { stage: o.stage, terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run: o.run, now: o.now, blueprint: o.b, stage: o.stage }) };
}

// `x`: a ready PR goes back with a note. The open PR stays; the pr stage updates it.
export function sendBack(db: Database, o: { dir: string; repo: string; id: number; note: string; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "ready" || t.pr_number == null) throw new Error(`#${o.id} is ${t.state}${t.pr_number == null ? " with no PR" : ""}; only a ready PR goes back`);
  if (!o.note.trim()) throw new Error("say what to change: factory send-back <id> <note…>");
  const b = loadBlueprint(o.repo, t.blueprint);
  note(o.dir, o.id, "REVIEW.md", `Sent back by you · ${now.slice(0, 16).replace("T", " ")} · PR #${t.pr_number}`, o.note);
  return restart(db, { ...o, run, now, b, stage: fixStage(b), who: `sent PR #${t.pr_number} back`, why: o.note.trim() });
}

// `u`: answer a parked ticket and run the stage it stopped at again.
export function answer(db: Database, o: { dir: string; repo: string; id: number; text: string; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state === "grooming" && t.needs_kind) throw new Error(`#${o.id}'s grooming questions are answered on the issue until intake (D6) is built`);
  if (t.state !== "parked") throw new Error(`#${o.id} is ${t.state}; only a parked ticket waits for an answer`);
  if (!o.text.trim()) throw new Error("type an answer: factory answer <id> <text…>");
  if (!t.worktree) throw new Error(`#${o.id} has no worktree; factory start ${o.id}`);
  const b = loadBlueprint(o.repo, t.blueprint);
  note(o.dir, o.id, "GATES.md", `Parked · ${now.slice(0, 16).replace("T", " ")}`, `${t.needs_text ?? "Stopped."}\n\n**Your answer:** ${o.text.trim()}`);
  return restart(db, { ...o, run, now, b, stage: restartStage(b, t.stage), who: "answered and restarted", why: o.text.trim() });
}

// `p` on a running ticket: its agent stops now; the stage it was in is remembered.
export function pause(db: Database, o: { id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT state, stage FROM tickets WHERE id = ?").get(o.id) as { state: string; stage: string | null } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "running") throw new Error(`#${o.id} is ${t.state}; only a running ticket pauses`);
  const open_ = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  db.query("UPDATE stages SET ended_at = ?, detail = 'paused' WHERE ticket = ? AND ended_at IS NULL").run(now, o.id);
  db.query("UPDATE tickets SET state = 'paused', detail = NULL, updated_at = ? WHERE id = ?").run(now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', ?, ?)").run(o.id, `paused at ${t.stage ?? "start"}`, now);
  // Last, so a failed kill (the terminal already gone) leaves the pause recorded.
  for (const s of open_) run(["hc", "kill", s.terminal]);
  return { stage: t.stage, killed: open_.map((s) => s.terminal) };
}

// `p` again: a fresh session for the stage it paused in. The pr stage has no agent;
// it goes back to waiting on the ready rules, which the daemon checks every tick.
export function resume(db: Database, o: { dir: string; repo: string; id: number; run?: Run; now?: string }) {
  const run = o.run ?? sh;
  const now = o.now ?? new Date().toISOString();
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.state !== "paused") throw new Error(`#${o.id} is ${t.state}; only a paused ticket resumes`);
  const b = loadBlueprint(o.repo, t.blueprint);
  db.query("UPDATE tickets SET state = 'running', updated_at = ? WHERE id = ?").run(now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, at) VALUES (?, 'you', 'resumed', ?)").run(o.id, now);
  if ((b.stages[t.stage] as BlueprintStage | undefined)?.requires === "ready") {
    enterStage(db, o.id, title(t.stage), null, plannedPath(b, t.stage).map(title), now);
    return { stage: t.stage, terminal: null };
  }
  const stage = restartStage(b, t.stage);
  return { stage, terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run, now, blueprint: b, stage }) };
}

// `d`: what the ticket changed, as `git diff` text: its worktree (uncommitted work
// too) against where its branch left the repo's current branch.
export function ticketDiff(db: Database, o: { repo: string; id: number; run?: Run }) {
  const run = o.run ?? sh;
  const t = db.query("SELECT worktree FROM tickets WHERE id = ?").get(o.id) as { worktree: string | null } | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (!t.worktree) throw new Error(`#${o.id} has no worktree: it hasn't started, or it merged and its worktree was removed`);
  const base = run(["git", "-C", o.repo, "symbolic-ref", "--short", "HEAD"]);
  if (base.code !== 0) throw new Error(`can't tell the repo's branch: ${base.out}`);
  const from = run(["git", "-C", t.worktree, "merge-base", base.out, "HEAD"]);
  if (from.code !== 0) throw new Error(`git merge-base failed: ${from.out}`);
  const diff = run(["git", "-C", t.worktree, "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", from.out]);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.out}`);
  return diff.out;
}
