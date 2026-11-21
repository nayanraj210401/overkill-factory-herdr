#!/usr/bin/env bun
// `factory`: the CLI agents and people use to change factory state, and
// `factory run`, the daemon. Every change is checked against the status.json
// contract inside its transaction, so a bad write never lands.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { open, setMeta } from "./db.ts";
import { buildStatus, writeStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";

const USAGE = `factory <command>   (factory: --name, else $FACTORY_NAME, else this folder's name)
  init [--repo owner/name]           create the factory's database
  ticket add <id> <title…> [--blueprint b]
  ticket set <id> <field=value>…     fields: ${"FIELDS"}
  decide <ticket> <who> <what> [why] log a decision
  status                             write status.json and print a summary
  run [--interval seconds]           the daemon: keep status.json fresh
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

export function paths(name: string, home = process.env.FACTORY_HOME ?? join(homedir(), ".factory")) {
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
  const p = paths(name);
  const [cmd, sub, ...rest] = args;
  const now = () => new Date().toISOString();
  if (!cmd || cmd === "help" || cmd === "--help") return log(USAGE.replace('"FIELDS"', Object.keys(FIELDS).join(" ")));
  const db = open(p.db);
  try {
    if (cmd === "init") {
      change(db, () => { setMeta(db, "name", name); setMeta(db, "repo", repo); });
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
    } else if (cmd === "decide") {
      const [who, what, why] = rest;
      if (!sub || !who || !what) throw new Error("usage: factory decide <ticket> <who> <what> [why]");
      db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(Number(sub), who, what, why ?? null, now());
    } else if (cmd === "status") {
      const s = writeStatus(db, p.status);
      log(`${s.factory.name}: ${s.tickets.length} tickets, daemon ${s.factory.daemon ? "on" : "off"} → ${p.status}`);
      return;
    } else if (cmd === "run") {
      const tick = () => { setMeta(db, "heartbeat", now()); writeStatus(db, p.status); };
      tick();
      log(`factory ${name}: writing ${p.status} every ${interval}s`);
      setInterval(tick, interval * 1000);
      return;
    } else throw new Error(`unknown command "${[cmd, sub].filter(Boolean).join(" ")}"\n${USAGE}`);
    writeStatus(db, p.status);
  } finally {
    if (cmd !== "run") db.close();
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`factory: ${(e as Error).message}`);
    process.exit(1);
  }
}
