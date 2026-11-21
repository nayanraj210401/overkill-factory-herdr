// The graph runner's first half: a ticket gets its own worktree, enters its
// blueprint's first stage, and that stage's agent starts in a herdr-core terminal.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateFile } from "./validate.ts";
import { enterStage } from "./ticket.ts";
import { openPr, readyRules, rulesPass } from "./ready.ts";

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
  const worktree = join(o.dir, "worktrees", String(o.id));
  mkdirSync(join(o.dir, "worktrees"), { recursive: true });
  const wt = run(["git", "-C", o.repo, "worktree", "add", "-b", branch, worktree]);
  if (wt.code !== 0) throw new Error(`git worktree add failed: ${wt.out}`);
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
  const hc = o.run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", t.worktree,
    "--label", `factory.ticket=${o.id}`, "--label", `factory.stage=${o.stage}`, ...argv]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  const terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(o.id, o.stage, s.agent, terminal, JSON.stringify(argv), o.now);
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
  const number = openPr(db, { id: o.id, dir: o.dir, worktree: t.worktree, branch: t.branch, rules, run });
  db.query("UPDATE tickets SET pr_number = ?, pr_watched = 1, pr_checked_at = ? WHERE id = ?").run(number, now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(o.id, `opened PR #${number}`, rules.map((r) => `${r.rule} ${r.result}`).join(", "), now);
  return { ...advance(db, { dir: o.dir, repo: o.repo, id: o.id, run, now }), pr: number };
}
