// Repo health (PRD 7.5): the full suite on each factory repo's default branch, on a
// schedule, so a PR only has to prove its own change. No agent and no tokens: the
// repo's quality_floor commands run in a throwaway worktree. A failure files one
// ticket (the trigger's blueprint, bugfix by default) holding the first failure; while
// that ticket is open, later failures add to it instead of filing another. A later pass
// closes it if nobody started it yet. The last result per repo is in meta (`health:<slug>`)
// and on Home.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMeta, listRepos, setMeta, type Repo } from "./db.ts";
import { worktreePath } from "./herdr.ts";
import { newTicket } from "./intake.ts";
import { closeTicket } from "./lifecycle.ts";
import { readFactory, type Run } from "./runner.ts";
import { intervalOf, isDue, isHealth, matchesFilter, readTriggers, type Trigger } from "./triggers.ts";

// ok: true passed, false a command failed, null the suite couldn't run (no commands, no
// default branch, a setup command failed): that says nothing about the code, so it files nothing.
export type Health = {
  repo: string; ok: boolean | null; at: string; branch: string | null; commit: string | null;
  command: string | null; failure: string | null; error: string | null; ticket: number | null;
};

const FAILURE_LINES = 20;
// A line that reports a failure in the common runners (bun, jest, vitest, node --test, pytest, go),
// but not a summary that says none did ("0 fail").
const FAILED = /\b(fail(ed|ing|ure|s)?|errors?|not ok|panic)\b|✗|✕|×/i;
const NONE_FAILED = /\b0 (fail(ed|ures?|s)?|errors?)\b/i;

// The first failure in a command's output: from the first line that reports one, else the output's end.
export function firstFailure(out: string): string {
  const lines = out.split("\n").map((l) => l.trimEnd());
  const at = lines.findIndex((l) => FAILED.test(l) && !NONE_FAILED.test(l));
  const part = at >= 0 ? lines.slice(at, at + FAILURE_LINES) : lines.slice(-FAILURE_LINES);
  return part.join("\n").trim().slice(0, 2000) || "(no output)";
}

// origin's default branch (fetched first), else a local main or master.
function defaultBranch(run: Run, path: string): { branch: string; ref: string } | null {
  const head = run(["git", "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.startsWith("origin/")) {
    const branch = head.out.slice("origin/".length);
    run(["git", "-C", path, "fetch", "-q", "origin", branch]); // offline: the last fetched commit
    return { branch, ref: head.out };
  }
  for (const b of ["main", "master"]) if (run(["git", "-C", path, "rev-parse", "--verify", "-q", `refs/heads/${b}`]).code === 0) return { branch: b, ref: b };
  return null;
}

// One repo's suite, in a worktree made for it and removed after, whatever happens.
export function checkRepo(o: { repo: Repo; commands: string[]; setup?: string[]; run: Run; now: () => string }): Omit<Health, "ticket"> {
  const { run } = o;
  const base = { repo: o.repo.slug, ok: null, branch: null, commit: null, command: null, failure: null, error: null };
  if (!o.commands.length) return { ...base, at: o.now(), error: "no quality_floor commands in its factory.yaml" };
  const def = defaultBranch(run, o.repo.path);
  if (!def) return { ...base, at: o.now(), error: "no default branch (origin/HEAD, main or master)" };
  const wt = worktreePath(o.repo.path, `health-${def.branch}`);
  mkdirSync(dirname(wt), { recursive: true });
  try {
    if (existsSync(wt)) run(["git", "-C", o.repo.path, "worktree", "remove", "--force", wt]);
    const add = run(["git", "-C", o.repo.path, "worktree", "add", "--detach", wt, def.ref]);
    if (add.code !== 0) return { ...base, branch: def.branch, at: o.now(), error: `git worktree add failed: ${add.out.slice(0, 200)}` };
    const commit = run(["git", "-C", wt, "rev-parse", "--short", "HEAD"]).out || null;
    for (const c of o.setup ?? []) {
      const r = run(["sh", "-c", c], wt);
      if (r.code !== 0) return { ...base, branch: def.branch, commit, at: o.now(), error: `setup \`${c}\` exited ${r.code}: ${r.out.split("\n").slice(-3).join(" / ").slice(0, 200)}` };
    }
    for (const c of o.commands) {
      const r = run(["sh", "-c", c], wt);
      if (r.code !== 0) return { ...base, ok: false, branch: def.branch, commit, at: o.now(), command: c, failure: firstFailure(r.out) };
    }
    return { ...base, ok: true, branch: def.branch, commit, at: o.now() };
  } finally {
    run(["git", "-C", o.repo.path, "worktree", "remove", "--force", wt]);
  }
}

const key = (slug: string) => `health:${slug}`;
export const lastHealth = (db: Database, slug: string): Health | null => {
  const v = getMeta(db, key(slug));
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};
// Every repo's last result, the lead first, for status.json.
export const healthOf = (db: Database): Health[] => listRepos(db).map((r) => lastHealth(db, r.slug)).filter((h): h is Health => !!h);

const note = (db: Database, id: number, what: string, why: string | null, now: string) =>
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'health', ?, ?, ?)").run(id, what, why, now);
const failureText = (h: Omit<Health, "ticket">) => `\`${h.command}\` on ${h.branch} at ${h.commit ?? "?"}:\n${h.failure}`;

// Files, adds to or closes the repo's health ticket for one result, and keeps the result.
export function recordHealth(db: Database, o: { dir: string; result: Omit<Health, "ticket">; lead: string; trigger: Trigger; run: Run }): Health {
  const h = o.result;
  const prev = lastHealth(db, h.repo);
  const state = prev?.ticket != null ? (db.query("SELECT state FROM tickets WHERE id = ?").get(prev.ticket) as { state: string } | null)?.state : null;
  let ticket = state && !["merged", "closed"].includes(state) ? prev!.ticket : null;
  if (h.ok === false && ticket != null) {
    // The same ticket, whatever fails now; a new failure is noted on it.
    if (prev!.command !== h.command || prev!.failure !== h.failure) note(db, ticket, "health: the full suite still fails, differently", failureText(h), h.at);
  } else if (h.ok === false) {
    ticket = fileTicket(db, { ...o, result: h });
  } else if (h.ok === true && ticket != null) {
    // A ticket nobody started closes; one being worked on is told, and you decide.
    if (state === "running" || state === "ready") note(db, ticket, `health: ${h.branch} passes again`, `at ${h.commit ?? "?"}; this ticket may no longer be needed`, h.at);
    else { closeTicket(db, { id: ticket, run: o.run, now: h.at, who: "health", what: "closed: the full suite passes again", why: `${h.branch} at ${h.commit ?? "?"}` }); ticket = null; }
  }
  const out = { ...h, ticket };
  setMeta(db, key(h.repo), JSON.stringify(out));
  return out;
}

// Queued, not groomed: it waits for you to start it, so a red suite never spends tokens unasked.
function fileTicket(db: Database, o: { dir: string; result: Omit<Health, "ticket">; lead: string; trigger: Trigger; run: Run }): number {
  const h = o.result;
  const t = newTicket(db, { text: `Repo health: ${h.repo} ${h.branch} fails \`${h.command}\``, repo: o.lead, blueprint: o.trigger.blueprint, run: o.run, now: h.at, trigger: o.trigger.name });
  if (h.repo !== o.lead) db.query("INSERT INTO ticket_repos (ticket, repo, lead) VALUES (?, ?, 1)").run(t.id, h.repo);
  db.query("UPDATE decisions SET who = 'health' WHERE ticket = ? AND who = 'you'").run(t.id);
  note(db, t.id, "health: the full suite fails", failureText(h), h.at);
  const folder = join(o.dir, "tickets", String(t.id));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "INTENT.md"), [
    `# ${t.title}`, "",
    `The scheduled full-suite run (repo health) failed on ${h.repo}'s default branch, ${h.branch}, at ${h.commit ?? "an unknown commit"}.`,
    `The first command that failed: \`${h.command}\`. Its first failure:`, "",
    "```", h.failure ?? "", "```", "",
    "## Acceptance", "",
    `- \`${h.command}\` passes on ${h.branch} again, with the fix in this ticket's PR.`,
    "- The fix is to the code or the test, whichever is wrong; a test is never skipped or deleted to pass.", "",
  ].join("\n"));
  return t.id;
}

// Every repo the trigger covers (filter.repos narrows), each checked then recorded. The
// suite runs outside any transaction; `commit` wraps each record.
export function runHealth(db: Database, o: { dir: string; repo: string; trigger: Trigger; run: Run; now: () => string; commit: (fn: () => void) => void }): Health[] {
  const repos = listRepos(db).filter((r) => matchesFilter({ repos: o.trigger.filter?.repos }, { repo: r.slug }));
  const lead = repos.find((r) => r.lead)?.slug ?? listRepos(db)[0]?.slug ?? "unknown";
  return repos.map((r) => {
    let commands: string[] = [];
    let bad: string | null = null;
    try { commands = readFactory(r.path).quality_floor ?? []; } catch (e) { bad = (e as Error).message; }
    const result = bad ? { repo: r.slug, ok: null, at: o.now(), branch: null, commit: null, command: null, failure: null, error: bad }
      : checkRepo({ repo: r, commands, setup: o.trigger.setup, run: o.run, now: o.now });
    let h!: Health;
    o.commit(() => { h = recordHealth(db, { dir: o.dir, result, lead, trigger: o.trigger, run: o.run }); });
    return h;
  });
}

// The run:health trigger by name, else the first one (the built-in `health` unless a file replaces it).
export function healthTrigger(repo: string, name?: string): Trigger {
  const all = readTriggers(repo).triggers.filter(isHealth);
  const t = name ? all.find((x) => x.name === name) : all[0];
  if (!t) throw new Error(name ? `no run: health trigger "${name}" in .factory/triggers/` : "no run: health trigger");
  return t;
}

// The run:health triggers due now, stamped. One the daemon sees for the first time is
// stamped, not run: the first check comes an interval later (or by `factory health`), so
// a new factory, or every factory at once after an update, doesn't start a suite on its first tick.
export function dueHealth(db: Database, repo: string, now: string): string[] {
  return readTriggers(repo).triggers.filter(isHealth).flatMap((t) => {
    const ms = intervalOf(t);
    const stamp = `trigger_at:${t.name}`;
    const last = getMeta(db, stamp);
    if (ms === null || (last && !isDue(last, Date.parse(now), ms))) return [];
    setMeta(db, stamp, now);
    return last ? [t.name] : [];
  });
}
