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

export function readyRules(db: Database, o: { id: number; dir: string; worktree: string; rules: string[]; run: Run }): Rule[] {
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(o.id) as Record<string, any>;
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
      const over = t.tokens_in > t.budget_in || t.tokens_out > t.budget_out;
      out.push({ rule, result: over ? "fail" : "pass", detail: `${t.tokens_in}/${t.budget_in} in, ${t.tokens_out}/${t.budget_out} out` });
    } else if (rule === "template") {
      const file = join(o.dir, "tickets", String(o.id), "PR.md");
      const problems = templateProblems(existsSync(file) ? readFileSync(file, "utf8") : null);
      out.push(problems.length ? { rule, result: "fail", detail: problems.join("; ") } : { rule, result: "pass", detail: "PR.md follows the template" });
    } else {
      out.push({ rule, result: "skipped", detail: "not built yet" }); // holdout (checker agent), review (reviewer vote)
    }
  }
  return out;
}

export const rulesPass = (rules: Rule[]) => rules.every((r) => r.result !== "fail");

// All rules pass: push the ticket's branch and open the PR from PR.md, as a draft
// with the rule results appended. Agents can't push; only the daemon does (plan: Hard stops).
export function openPr(db: Database, o: { id: number; dir: string; worktree: string; branch: string; rules: Rule[]; run: Run; existing?: number | null }) {
  const t = db.query("SELECT title FROM tickets WHERE id = ?").get(o.id) as { title: string };
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
