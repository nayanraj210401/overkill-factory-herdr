// The ready rules (plan: Autonomy). A PR opens only when each rule passes; a rule
// the factory can't check yet is "skipped" and named in the PR, never silently passed.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./runner.ts";

export type Rule = { rule: string; result: "pass" | "fail" | "skipped"; detail: string };

// PRD 6.3: one plain sentence first, then the fields a reviewer needs.
const PR_FIELDS = ["What changed", "Why", "How it was verified", "Risk"];
export function templateProblems(md: string | null) {
  if (!md?.trim()) return ["PR.md is missing"];
  const [first, ...rest] = md.trim().split("\n");
  const problems: string[] = [];
  if (first.startsWith("#") || !/[.!?]$/.test(first.trim())) problems.push("PR.md must open with one plain sentence");
  for (const f of PR_FIELDS) if (!new RegExp(`\\*\\*${f}:?\\*\\*|^#+\\s*${f}`, "mi").test(rest.join("\n"))) problems.push(`PR.md has no "${f}"`);
  return problems;
}

export type VerdictKind = "holdout" | "review";
// The agent roles whose stage must end with a verdict, and the verdict they give.
export const VERDICT_OF_ROLE: Record<string, VerdictKind> = { verify: "holdout", review: "review" };

// `factory verdict`: a checker or reviewer agent reports. The vote is the open
// session's agent's unless --by names another voter.
export function recordVerdict(db: Database, o: { id: number; kind: VerdictKind; result: "PASS" | "FAIL"; detail: string | null; by?: string | null; now: string }) {
  if (!db.query("SELECT 1 FROM ticket_lead WHERE id = ?").get(o.id)) throw new Error(`no ticket ${o.id}`);
  const s = db.query("SELECT id, agent FROM sessions WHERE ticket = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(o.id) as { id: number; agent: string | null } | null;
  const voter = o.by ?? s?.agent ?? "you";
  db.query("INSERT INTO verdicts (ticket, session, kind, voter, result, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(o.id, s?.id ?? null, o.kind, voter, o.result, o.detail, o.now);
  return voter;
}

// Each voter's latest verdict, counted only if it is newer than the last commit.
// Holdout: every hidden check run passes. Review: a majority reports no blockers.
// With no fresh verdict, the rule fails when the blueprint has a stage that should
// have given one, and is skipped when it has none.
function verdictRule(db: Database, id: number, kind: VerdictKind, lastCommit: string, expected: boolean): Rule {
  const rows = db.query(`SELECT voter, result, detail, at FROM verdicts v WHERE ticket = ? AND kind = ? AND id = (SELECT MAX(id) FROM verdicts WHERE ticket = v.ticket AND kind = v.kind AND voter = v.voter)`)
    .all(id, kind) as { voter: string; result: string; detail: string | null; at: string }[];
  const fresh = rows.filter((r) => !lastCommit || Date.parse(r.at) >= Date.parse(lastCommit));
  const who = kind === "holdout" ? "checker" : "reviewer";
  if (!fresh.length) {
    if (!expected) return { rule: kind, result: "skipped", detail: `the blueprint has no ${who} stage` };
    return { rule: kind, result: "fail", detail: rows.length ? `the ${who}'s verdict is older than the last commit` : `no ${who} verdict recorded` };
  }
  const fails = fresh.filter((r) => r.result !== "PASS");
  const why = fails[0]?.detail ? `: ${fails[0].detail}` : "";
  if (kind === "holdout")
    return fails.length ? { rule: kind, result: "fail", detail: `hidden checks fail${why}` } : { rule: kind, result: "pass", detail: "hidden checks pass" };
  const passes = fresh.length - fails.length;
  return passes * 2 > fresh.length
    ? { rule: kind, result: "pass", detail: `${passes} of ${fresh.length} reviewers report no blockers` }
    : { rule: kind, result: "fail", detail: `${fails.length} of ${fresh.length} reviewers block${why}` };
}

export function readyRules(db: Database, o: { id: number; dir: string; worktree: string; rules: string[]; run: Run; expects?: VerdictKind[]; cap?: { input: number; output: number } | null }): Rule[] {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any>;
  const latest = db.query(`SELECT check_name, result, at FROM evidence e WHERE ticket = ? AND id = (SELECT MAX(id) FROM evidence WHERE ticket = e.ticket AND check_name = e.check_name)`).all(o.id) as { check_name: string; result: string; at: string }[];
  const lastCommit = o.run(["git", "-C", o.worktree, "log", "-1", "--format=%cI"]).out.trim();
  const out: Rule[] = [];
  for (const rule of o.rules) {
    if (rule === "evidence") {
      const failing = latest.filter((c) => c.result !== "PASS").map((c) => c.check_name);
      const stale = latest.filter((c) => lastCommit && Date.parse(c.at) < Date.parse(lastCommit)).map((c) => c.check_name);
      out.push(!latest.length ? { rule, result: "fail", detail: "no checks recorded" }
        : failing.length ? { rule, result: "fail", detail: `failing: ${failing.join(", ")}` }
        : stale.length ? { rule, result: "fail", detail: `older than the last commit: ${stale.join(", ")}` }
        : { rule, result: "pass", detail: `${latest.length} checks pass after the last commit` });
    } else if (rule === "quality_floor") {
      const ran = latest.filter((c) => c.check_name !== "evidence");
      out.push(ran.some((c) => c.result !== "PASS") ? { rule, result: "fail", detail: "a check fails" } : { rule, result: "pass", detail: "no check fails" });
    } else if (rule === "budget") {
      const bin = Math.min(t.budget_in, o.cap?.input ?? Infinity);
      const bout = Math.min(t.budget_out, o.cap?.output ?? Infinity);
      const over = t.tokens_in > bin || t.tokens_out > bout;
      out.push({ rule, result: over ? "fail" : "pass", detail: `${t.tokens_in}/${bin} in, ${t.tokens_out}/${bout} out${o.cap ? " (away cap)" : ""}` });
    } else if (rule === "template") {
      const file = join(o.dir, "tickets", String(o.id), "PR.md");
      const problems = templateProblems(existsSync(file) ? readFileSync(file, "utf8") : null);
      out.push(problems.length ? { rule, result: "fail", detail: problems.join("; ") } : { rule, result: "pass", detail: "PR.md follows the template" });
    } else if (rule === "holdout" || rule === "review") {
      out.push(verdictRule(db, o.id, rule, lastCommit, o.expects?.includes(rule) ?? false));
    } else {
      out.push({ rule, result: "skipped", detail: "not a rule the factory knows" });
    }
  }
  return out;
}

export const rulesPass = (rules: Rule[]) => rules.every((r) => r.result !== "fail");

// All rules pass: push the ticket's branch and open the PR from PR.md, as a draft
// with the rule results appended. Agents can't push; only the daemon does (plan: Hard stops).
export function openPr(db: Database, o: { id: number; dir: string; worktree: string; branch: string; rules: Rule[]; run: Run; existing?: number | null }) {
  const t = db.query("SELECT title FROM ticket_lead WHERE id = ?").get(o.id) as { title: string };
  const md = readFileSync(join(o.dir, "tickets", String(o.id), "PR.md"), "utf8").trim();
  const table = o.rules.map((r) => `- ${r.result === "pass" ? "✓" : r.result === "skipped" ? "–" : "✗"} ${r.rule}: ${r.detail}`).join("\n");
  const body = `${md}\n\n**Ready rules**\n${table}\n`;
  const bodyFile = join(o.dir, "tickets", String(o.id), ".pr-body.md");
  mkdirSync(join(o.dir, "tickets", String(o.id)), { recursive: true });
  writeFileSync(bodyFile, body);
  const push = o.run(["git", "-C", o.worktree, "push", "-u", "origin", o.branch]);
  if (push.code !== 0) throw new Error(`git push failed: ${push.out}`);
  // Sent back and fixed: the PR it already has gets the new commits and a fresh body.
  if (o.existing != null) {
    const edit = o.run(["gh", "pr", "edit", String(o.existing), "--body-file", bodyFile], o.worktree);
    if (edit.code !== 0) throw new Error(`gh pr edit failed: ${edit.out}`);
    return o.existing;
  }
  const pr = o.run(["gh", "pr", "create", "--draft", "--head", o.branch, "--title", t.title, "--body-file", bodyFile], o.worktree);
  if (pr.code !== 0) throw new Error(`gh pr create failed: ${pr.out}`);
  const number = Number(pr.out.match(/\/pull\/(\d+)/)?.[1]);
  if (!number) throw new Error(`gh pr create printed no PR link: ${pr.out}`);
  return number;
}
