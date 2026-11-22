// The maintainer (plan: Changing the factory) owns every change to the factory's
// configuration. A request, from you in Overwatch or from the learner, is a ticket on the
// shipped `factory` blueprint. The maintainer agent edits .factory/ in the ticket's worktree
// and, for the account config (~/.factory/config.yaml, which no repo holds), writes the
// proposed file into the ticket's folder. The factory check proves both, and the change
// comes back as a PR you merge (maintainer.gate); the account config is applied only then.
// A request skips grooming: whoever asked already agreed, or brought the evidence.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountFile } from "./account.ts";
import { newTicket } from "./intake.ts";
import type { Run } from "./runner.ts";
import { validateAccount } from "./validate.ts";

export const BLUEPRINT = "factory";

// Who asked: you (in Overwatch, or `factory request`), or an agent: the learner with its
// evidence, Overwatch on its own, the babysitter… (`factory ask maintainer`, ask.ts).
export type From = string;
const triggerOf = (from: From) => (from === "learner" ? "learner" : "maintainer");
export const requestedBy = (trigger: string | null | undefined): From => (trigger === "learner" ? "learner" : "you");
const FROM_LINE: Record<string, string> = { you: "you, in Overwatch", learner: "the learner (self-learning found this)", overwatch: "Overwatch, on its own" };

const folderOf = (dir: string, id: number) => join(dir, "tickets", String(id));

export function request(db: Database, o: { text: string; repo: string; run: Run; now: string; from?: From; evidence?: string; dir?: string; about?: number | null }) {
  const text = o.text.trim().replace(/\s+/g, " ");
  if (!text) throw new Error('say what to change: factory request "<the change, and why>"');
  // A link or #number would make it a GitHub issue ticket: a request is the person's words.
  if (/^#?\d+$|^https?:\/\//.test(text)) throw new Error("a request is a sentence about the change, not an issue link; use factory new for issues");
  const from = o.from ?? "you";
  const r = newTicket(db, { text, repo: o.repo, blueprint: BLUEPRINT, run: o.run, now: o.now, trigger: triggerOf(from) });
  db.query("UPDATE tickets SET groomed_at = ? WHERE id = ?").run(o.now, r.id);
  if (from !== "you") db.query("UPDATE decisions SET who = ? WHERE ticket = ? AND who = 'you'").run(from, r.id);
  if (o.evidence) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, 'evidence for the request', ?, ?)").run(r.id, from, o.evidence, o.now);
  // Every hand-off is recorded with its origin and target (Config's Pending changes: from X to the maintainer).
  db.query("INSERT INTO asks (from_agent, to_agent, text, why, about, request, at, delivered_at) VALUES (?, 'maintainer', ?, ?, ?, ?, ?, ?)")
    .run(from, text, o.evidence ?? null, o.about ?? null, r.id, o.now, o.now);
  // REQUEST.md: what the maintainer reads first, with who asked and why.
  if (o.dir) {
    mkdirSync(folderOf(o.dir, r.id), { recursive: true });
    writeFileSync(join(folderOf(o.dir, r.id), "REQUEST.md"), [
      `# Request #${r.id}`, "", `From: ${FROM_LINE[from] ?? `the ${from} agent`}`, "", text, "",
      ...(o.about ? [`About: ticket #${o.about}`, ""] : []),
      ...(o.evidence ? ["## Evidence", "", o.evidence.trim(), ""] : []),
    ].join("\n"));
  }
  return r;
}

// Who asked for a request: its ask's origin, else (a request from before asks were recorded) its trigger.
export function requesterOf(db: Database, id: number, trigger: string | null | undefined): From {
  const a = db.query("SELECT from_agent FROM asks WHERE request = ? ORDER BY id LIMIT 1").get(id) as { from_agent: string } | null;
  return a?.from_agent ?? requestedBy(trigger);
}

// ---- the account config --------------------------------------------------------------
// The maintainer writes the whole proposed file as ACCOUNT-CONFIG.yaml in the ticket's
// folder. The factory check validates it, keeps the copy it checked and the file it was
// checked against, and writes the diff the PR carries. Merged, the daemon applies the
// checked copy, keeping a backup; if the account config changed in between, it applies
// nothing and says so.
export const ACCOUNT_PROPOSAL = "ACCOUNT-CONFIG.yaml";
export const ACCOUNT_DIFF = "ACCOUNT-CONFIG.md";
const CHECKED = ".account-checked.yaml";
const BASE = ".account-base.yaml";
const APPLIED = "ACCOUNT-CONFIG.applied.yaml";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// `factory account propose <id>`: the maintainer starts from the file as it is.
export function proposeAccount(dir: string, id: number, file = accountFile()) {
  const out = join(folderOf(dir, id), ACCOUNT_PROPOSAL);
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, existsSync(file) ? readFileSync(file, "utf8") : "# ~/.factory/config.yaml: what belongs to you in every factory (plan, budget, away, cloud, profile)\n");
  return out;
}

// A checked change waits to be applied: the account-only ticket's merge needs no PR.
export const accountPending = (dir: string, id: number) => existsSync(join(folderOf(dir, id), CHECKED));

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

// The factory check's account part; null when the request doesn't touch the account config.
export function checkAccount(dir: string, id: number, file = accountFile()): { ok: boolean; detail: string } | null {
  const folder = folderOf(dir, id);
  const p = join(folder, ACCOUNT_PROPOSAL);
  const clear = () => { for (const f of [CHECKED, BASE, ACCOUNT_DIFF]) rmSync(join(folder, f), { force: true }); };
  if (!existsSync(p)) { clear(); return null; }
  const text = readFileSync(p, "utf8");
  const errors = validateAccount(text);
  if (errors.length) { clear(); return { ok: false, detail: `${ACCOUNT_PROPOSAL}: ${errors[0]}`.slice(0, 200) }; }
  const current = read(file);
  if (current === text) { clear(); return { ok: true, detail: "the proposal matches the account config: nothing to apply" }; }
  writeFileSync(join(folder, BASE), current);
  writeFileSync(join(folder, CHECKED), text);
  writeFileSync(join(folder, ACCOUNT_DIFF), [
    "## The account config (~/.factory/config.yaml)", "",
    `Applied to \`${file}\` only after this merges, with a backup beside it. Not part of the repo.`, "",
    "```diff", unifiedDiff(current, text, file), "```", "",
  ].join("\n"));
  return { ok: true, detail: `${ACCOUNT_PROPOSAL} passes; its diff goes on the PR and it applies when the PR merges` };
}

// Merged: write the checked copy over the account config, keeping a backup.
export function applyAccount(db: Database, o: { dir: string; id: number; now: string; file?: string }): { applied: boolean; detail: string } | null {
  const file = o.file ?? accountFile();
  const folder = folderOf(o.dir, o.id);
  const checked = join(folder, CHECKED);
  if (!existsSync(checked)) return null;
  const note = (what: string, why: string | null) => db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(o.id, what, why, o.now);
  const text = readFileSync(checked, "utf8");
  if (read(file) !== read(join(folder, BASE))) {
    // Someone changed it after the check: applying would lose their edit.
    renameSync(checked, join(folder, ".account-stale.yaml"));
    const detail = `${file} changed after the check; nothing was applied. Ask again so the maintainer starts from the file as it is now`;
    note("account config not applied", detail);
    return { applied: false, detail };
  }
  mkdirSync(dirname(file), { recursive: true });
  const backup = existsSync(file) ? `${file}.bak-${o.now.replace(/[^0-9]/g, "").slice(0, 14)}-${o.id}` : null;
  if (backup) copyFileSync(file, backup);
  const tmp = `${file}.factory-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file); // whole or not at all: every factory reads this file
  renameSync(checked, join(folder, APPLIED));
  rmSync(join(folder, BASE), { force: true });
  rmSync(join(folder, ACCOUNT_PROPOSAL), { force: true });
  const detail = backup ? `the old file is ${backup}` : "there was no account config before";
  note("applied the account config", detail);
  return { applied: true, detail };
}

// Every tick: a merged request's account change applies (once; the checked copy moves aside).
export function applyMergedAccounts(db: Database, o: { dir: string; now: string; file?: string; log?: (s: string) => void }) {
  const ids = (db.query("SELECT id FROM tickets WHERE blueprint = ? AND state = 'merged' ORDER BY id").all(BLUEPRINT) as { id: number }[]).map((r) => r.id);
  for (const id of ids.filter((i) => accountPending(o.dir, i))) {
    const r = applyAccount(db, { dir: o.dir, id, now: o.now, file: o.file });
    if (r) o.log?.(`factory: #${id}: ${r.applied ? `applied the account config (${r.detail})` : r.detail}`);
  }
}
