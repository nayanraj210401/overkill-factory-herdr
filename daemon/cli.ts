#!/usr/bin/env bun
// `factory`: the CLI agents and people use to change factory state, and
// `factory run`, the daemon. Every change is checked against the status.json
// contract inside its transaction, so a bad write never lands.
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readyRules } from "./ready.ts";
import { basename, dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { open, setMeta } from "./db.ts";
import { buildStatus, writeStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { parseTokens } from "../lib/model.js";
import { service } from "./service.ts";
import { enterStage, writeTicketFiles } from "./ticket.ts";
import { validateDir } from "./validate.ts";
import { newTicket } from "./intake.ts";
import { sessionState } from "./herdr.ts";
import { advance, answer, mergeTicket, pause, ticketDiff, resume, sendBack, sh, startTicket, tryPr } from "./runner.ts";
import { getMeta } from "./db.ts";

const USAGE = `factory <command>   (factory: --name, else $FACTORY_NAME, else this folder's name)
  init [--repo owner/name] [--path dir]  create the factory's database (path: the repo checkout, default .)
  new <issue link | #n | goal…> [--blueprint b] [--start]  add a ticket (goals get ids from 10000)
  start <id>                         worktree + first stage + its agent in a herdr-core terminal
  stage-done <id> [--fail reason]    the stage's work is over: follow the blueprint
  budget <id> <in>[/<out>]           set a ticket's token budget: 3M, or 3M/200k
  send-back <id> <note…>             a ready PR goes back to its fix stage with your note (REVIEW.md)
  answer <id> <text…>                answer a parked ticket and rerun its stage (GATES.md)
  pause <id> | resume <id>           stop a running ticket's agent / rerun the stage it paused in
  diff <id>                          what the ticket changed, against the repo's branch
  merge <id>                         squash-merge a ready ticket's PR (marks it ready first)
  ready <id>                         the ready rules for a ticket, as the pr stage sees them
  sessions <id>                      the agent sessions started for a ticket
  ticket add <id> <title…> [--blueprint b]
  ticket set <id> <field=value>…     fields: ${"FIELDS"}
  stage <id> <Name> [detail…] [--next A,B]  enter a stage (the current one ends)
  evidence <id> <check> pass|fail [detail…] record a check result
  decide <ticket> <who> <what> [why] log a decision
  validate [dir] [--json]            check .factory/ files (default ./.factory)
  status                             write status.json and print a summary
  run [--interval seconds] [--all]   the daemon: keep status.json fresh (--all: every factory)
  service install|uninstall|restart|status [--json]  keep \`factory run --all\` alive with launchd
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
function nullable(v: string) { return v === "" || v === "null" ? null : v; }
function nullableNumber(v: string) { return v === "" || v === "null" ? null : Number(v); }

const factoryHome = () => process.env.FACTORY_HOME ?? join(homedir(), ".factory");

export function paths(name: string, home = factoryHome()) {
  const dir = join(home, name);
  return { dir, db: join(dir, "factory.db"), status: join(dir, "status.json") };
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

export function main(argv: string[], log = console.log) {
  const args = [...argv];
  const name = flag(args, "name") ?? process.env.FACTORY_NAME ?? basename(process.cwd());
  const repo = flag(args, "repo") ?? "unknown";
  const blueprint = flag(args, "blueprint") ?? "feature";
  const interval = Number(flag(args, "interval") ?? 5);
  const next = flag(args, "next");
  const repoPath = flag(args, "path");
  const failReason = flag(args, "fail");
  const p = paths(name);
  const all = args.includes("--all");
  const json = args.includes("--json");
  const start = args.includes("--start");
  const [cmd, sub, ...rest] = args.filter((a) => a !== "--all" && a !== "--json" && a !== "--start");
  const now = () => new Date().toISOString();
  if (!cmd || cmd === "help" || cmd === "--help") return log(USAGE.replace('"FIELDS"', Object.keys(FIELDS).join(" ")));
  if (cmd === "service") return service(sub ?? "", { factoryHome: factoryHome(), log, json });
  if (cmd === "validate") {
    const results = validateDir(sub ?? ".factory");
    if (json) return log(JSON.stringify(results));
    for (const r of results) log(r.errors.length ? `✗ ${r.path}\n${r.errors.map((e) => `    ${e}`).join("\n")}` : `✓ ${r.path}`);
    const bad = results.filter((r) => r.errors.length).length;
    if (bad) throw new Error(`${bad} of ${results.length} files have problems`);
    return;
  }
  if (cmd === "run" && all) return runAll(interval, log);
  // Only init makes a factory: a typo'd --name (or the window pointed at sample data)
  // must not leave a stray database for `run --all` to serve.
  if (cmd !== "init" && !existsSync(p.db)) throw new Error(`no factory "${name}" in ${dirname(p.dir)}; run factory init first`);
  const db = open(p.db);
  try {
    if (cmd === "init") {
      change(db, () => { setMeta(db, "name", name); setMeta(db, "repo", repo); setMeta(db, "repo_path", resolve(repoPath ?? ".")); });
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
      change(db, () => {
        const r = db.query(`UPDATE tickets SET ${sets.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
          .run(...sets.map(([, v]) => v as any), now(), Number(id));
        if (r.changes === 0) throw new Error(`no ticket ${id}`);
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
    } else if (cmd === "new") {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      const repoDir = getMeta(db, "repo_path");
      if (start && !repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      let r: any = null;
      let terminal: string | null = null;
      change(db, () => {
        r = newTicket(db, { text, repo: getMeta(db, "repo") ?? "unknown", blueprint, run: sh, now: now() });
        if (start) terminal = startTicket(db, { dir: p.dir, repo: repoDir!, id: r.id });
      });
      log(`#${r.id} ${r.title}${start ? ` started${terminal ? `: agent in ${terminal}` : ""}` : " queued"}`);
      writeStatus(db, p.status);
      writeTicketFiles(db, p.dir, r.id);
      return;
    } else if (cmd === "start") {
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      let terminal: string | null = null;
      change(db, () => { terminal = startTicket(db, { dir: p.dir, repo: repoDir, id: Number(sub) }); });
      log(terminal ? `#${sub} started: agent in ${terminal}` : `#${sub} started`);
    } else if (cmd === "stage-done") {
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      let r: any = null;
      change(db, () => { r = advance(db, { dir: p.dir, repo: repoDir, id: Number(sub), failed: failReason ?? undefined }); });
      log(`#${sub}: ${r.parked ? `parked at ${r.stage}` : r.ready ? `ready (${r.stage})` : r.terminal ? `${r.stage} agent in ${r.terminal}` : `waiting at ${r.stage}`}`);
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
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      const text = rest.join(" ");
      let r: any = null;
      change(db, () => {
        r = cmd === "answer" ? answer(db, { dir: p.dir, repo: repoDir, id: Number(sub), text })
          : sendBack(db, { dir: p.dir, repo: repoDir, id: Number(sub), note: text });
      });
      log(`#${sub}: back to ${r.stage}${r.terminal ? `, agent in ${r.terminal}` : ""}`);
    } else if (cmd === "diff") {
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      return log(ticketDiff(db, { repo: repoDir, id: Number(sub) }));
    } else if (cmd === "pause") {
      let r: any = null;
      change(db, () => { r = pause(db, { id: Number(sub) }); });
      log(`#${sub}: paused at ${r.stage}${r.killed.length ? `; stopped ${r.killed.join(", ")}` : ""}`);
    } else if (cmd === "resume") {
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      let r: any = null;
      change(db, () => { r = resume(db, { dir: p.dir, repo: repoDir, id: Number(sub) }); });
      log(`#${sub}: resumed at ${r.stage}${r.terminal ? `, agent in ${r.terminal}` : ""}`);
    } else if (cmd === "merge") {
      const repoDir = getMeta(db, "repo_path");
      if (!repoDir) throw new Error("this factory has no repo path; run factory init --path <repo>");
      let r: any = null;
      change(db, () => { r = mergeTicket(db, { repo: repoDir, id: Number(sub) }); });
      log(`#${sub}: merged PR #${r.pr}`);
    } else if (cmd === "ready") {
      const t = db.query("SELECT worktree FROM tickets WHERE id = ?").get(Number(sub)) as any;
      if (!t?.worktree) throw new Error(`#${sub} has no worktree yet; factory start ${sub}`);
      const repoDir = getMeta(db, "repo_path")!;
      const text = readFileSync(join(repoDir, ".factory/factory.yaml"), "utf8");
      const rules = readyRules(db, { id: Number(sub), dir: p.dir, worktree: t.worktree, rules: (Bun.YAML.parse(text) as any).ready ?? ["evidence", "holdout", "quality_floor", "review", "template", "budget"], run: sh });
      for (const r of rules) log(`${r.result === "pass" ? "✓" : r.result === "skipped" ? "–" : "✗"} ${r.rule}: ${r.detail}`);
      return;
    } else if (cmd === "sessions") {
      for (const r of db.query("SELECT * FROM sessions WHERE ticket = ? ORDER BY id").all(Number(sub)) as any[])
        log(`${r.started_at.slice(0, 16)}  ${r.stage.padEnd(10)} ${r.terminal ?? "-"}  ${r.ended_at ? "ended" : "open"}  ${JSON.parse(r.argv)[0]}`);
      return;
    } else if (cmd === "decide") {
      const [who, what, why] = rest;
      if (!sub || !who || !what) throw new Error("usage: factory decide <ticket> <who> <what> [why]");
      db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(Number(sub), who, what, why ?? null, now());
    } else if (cmd === "status") {
      const s = writeStatus(db, p.status);
      log(`${s.factory.name}: ${s.tickets.length} tickets, daemon ${s.factory.daemon ? "on" : "off"} → ${p.status}`);
      return;
    } else if (cmd === "run") {
      const tick = () => { setMeta(db, "heartbeat", now()); watchSessions(db, p); writeAll(db, p); };
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

// An agent whose terminal exited without calling stage-done has still finished its turn.
export function watchSessions(db: Database, p: ReturnType<typeof paths>, run = sh, log = console.log) {
  const repoDir = getMeta(db, "repo_path");
  if (!repoDir) return;
  const open_ = db.query("SELECT id, ticket, terminal, in_space, agent_seen, started_at FROM sessions WHERE ended_at IS NULL AND terminal IS NOT NULL").all() as
    { id: number; ticket: number; terminal: string; in_space: number; agent_seen: number; started_at: string }[];
  // Tickets waiting at the pr stage: their rules may pass now (a new PR.md, new evidence).
  for (const { id } of db.query("SELECT id FROM tickets WHERE state = 'running' AND stage = 'pr'").all() as { id: number }[]) {
    try {
      let r: any;
      change(db, () => { r = tryPr(db, { dir: p.dir, repo: repoDir, id, run }); });
      if (r.pr) log(`factory: #${id} opened PR #${r.pr}`);
    } catch (e) {
      log(`factory: #${id}: ${(e as Error).message}`);
    }
  }
  for (const s of open_) {
    const r = run(["hc", "get", s.terminal, "--json"]);
    let state = "exited";
    try { if (r.code === 0) state = sessionState(JSON.parse(r.out)); } catch {}
    // In a tab the shell outlives the agent: done once the agent was seen and the shell is back.
    if (s.in_space && state === "agent" && !s.agent_seen) db.query("UPDATE sessions SET agent_seen = 1 WHERE id = ?").run(s.id);
    // An agent quicker than a tick is never seen: a shell idle a minute after the start means it's over.
    const idle = Date.now() - Date.parse(s.started_at) > 60_000;
    const gone = state === "exited" || (s.in_space === 1 && state === "shell" && (s.agent_seen === 1 || idle));
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
  for (const t of s.tickets) writeTicketFiles(db, p.dir, t.id);
}

// One daemon for every factory under FACTORY_HOME; new ones are picked up on the next tick.
export function factories(home = factoryHome()) {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => existsSync(join(home, n, "factory.db")));
}

function runAll(interval: number, log: (s: string) => void) {
  const open_: Record<string, Database> = {};
  const tick = () => {
    for (const name of factories()) {
      const p = paths(name);
      const db = (open_[name] ??= open(p.db));
      try {
        setMeta(db, "heartbeat", new Date().toISOString());
        watchSessions(db, p, sh, log);
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
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`factory: ${(e as Error).message}`);
    process.exit(1);
  }
}
