// M3 local ⇄ cloud (plan: Local and cloud). `⇧C` hands a running ticket to a Claude
// Code cloud session: the work in progress is committed with a handoff pack
// (.factory-run/<id>/: HANDOFF.md plus the ticket's files) and pushed, and
// `claude --cloud` starts from it. The factory can't see a cloud session, so the
// ticket shows "in cloud" and the daemon leaves it alone until `⇧L` fetches the
// branch, imports RESULT.md (evidence, notes, PR.md), and resumes locally.
import { STOPS } from "./guard.ts";
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, ticketRepos } from "./db.ts";
import { openAgent } from "./herdr.ts";
import { pushbackGate } from "./agreement.ts";
import { enterStage } from "./ticket.ts";
import { loadBlueprint, plannedPath, readFactory, restartStage, startStage, title, type Run } from "./runner.ts";

const TICKET_FILES = ["STATUS.md", "EVIDENCE.md", "GATES.md", "REVIEW.md", "INTENT.md", "SLICES.md", "HANDOFF.md", "GROOMING.md", "PR.md"];
const RULES: Record<string, string> = {
  evidence: "every acceptance check has a PASS recorded after the last commit",
  holdout: "hidden checks written by the checker pass",
  quality_floor: "the quality floor commands all pass",
  review: "a reviewer finds no blockers",
  template: "PR.md opens with one plain sentence, then What changed, Why, How it was verified, Risk",
  budget: "the ticket stays within its token budget",
};

export const runDir = (id: number) => join(".factory-run", String(id));

export function handoffMd(o: { id: number; title: string; branch: string; blueprint: string; stage: string; left: string[]; agent: string | null;
  ready: string[]; floor: string[]; hardStops: string[]; files: string[]; others?: string[]; noPushbacks?: string | null }) {
  const here = runDir(o.id);
  const others = o.others ?? [];
  return `# #${o.id} ${o.title}: continue in the cloud

You're continuing a ticket the local factory was running. The factory isn't reachable from here (there is no \`factory\` command), so you report through files. Work only on the branch \`${o.branch}\`. Never push to main, and never open, edit or merge a pull request.
${others.length ? `
This ticket changes ${others.length + 1} repos, each on the same branch \`${o.branch}\`, already pushed: this one and ${others.map((r) => `\`${r}\``).join(", ")}. Clone each other repo on that branch (\`gh repo clone ${others[0]} -- -b ${o.branch}\`), change it where the work needs, and push it to that branch too. The pack and RESULT.md stay in this repo.
` : ""}
## Where it stands

- Blueprint: \`${o.blueprint}\` (\`.factory/blueprints/${o.blueprint}.yaml\`).
- Stage now: **${o.stage}**${o.agent ? `, run by the \`${o.agent}\` agent: follow \`.factory/agents/${o.agent}.md\`` : ""}.
- Stages left after it: ${o.left.length ? o.left.join(" → ") : "none"}. For each stage with an agent, follow that agent's prompt in \`.factory/agents/\`.
- The ticket's files from the factory are in \`${here}/\`: ${o.files.length ? o.files.join(", ") : "none yet"}. Act on every note in REVIEW.md and GATES.md.

## Rules

- The PR opens only when these ready rules pass: ${o.ready.map((r) => `${r} (${RULES[r] ?? r})`).join("; ")}.
- Quality floor, run before you stop: ${o.floor.length ? o.floor.map((c) => `\`${c}\``).join(", ") : "none set"}.
- Hard stops: ${o.hardStops.length ? o.hardStops.join(", ") : "push-to-main, outside-worktree, destructive-commands, secrets-in-output"}.
- A product question (what to build, for whom, wording, scope) isn't yours to answer: write it under Questions and stop.
${o.noPushbacks ? `- Don't push back on a review comment: ${o.noPushbacks}. Fix a comment only when the fix is clear-cut; put every other one under Questions.\n` : ""}- When the work is ready for review, write \`${here}/PR.md\`: one plain sentence, then **What changed:**, **Why:**, **How it was verified:**, **Risk:**.

## When you stop

Write \`${here}/RESULT.md\` like this, then commit everything and push to \`${o.branch}\`:

\`\`\`
Stage: <the stage you reached, from the list above>

## Evidence
- PASS <check name>: <what you ran and saw>
- FAIL <check name>: <what failed>

## Notes
<what you did, decisions you made for the person, what's left>

## Questions
<anything that needs the person; empty if none>
\`\`\`
`;
}

function launch(run: Run, t: Record<string, any>, argv: string[]) {
  const made = openAgent(run, { folder: t.worktree, space: t.space, name: "cloud", argv });
  if (made) return { terminal: made.terminal, space: made.space, inSpace: 1 };
  const hc = run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", `f${t.id}-cloud`, "--cwd", t.worktree,
    "--label", `factory.ticket=${t.id}`, "--label", "factory.stage=cloud", ...argv]);
  if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
  let terminal = `f${t.id}-cloud`;
  try { terminal = JSON.parse(hc.out).address ?? terminal; } catch {}
  return { terminal, space: t.space, inSpace: 0 };
}

const git = (run: Run, wt: string, args: string[], what: string) => {
  const r = run(["git", "-C", wt, ...args]);
  if (r.code !== 0) throw new Error(`${what} failed: ${r.out}`);
  return r.out;
};

// `factory cloud <id>`
export function toCloud(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.location === "cloud") throw new Error(`#${o.id} is in the cloud already`);
  if (t.state !== "running" || !t.worktree) throw new Error(`#${o.id} is ${t.state}; only a running ticket moves to the cloud`);
  // Nobody is there to ask in the cloud: below the agreement bar, the pack says no pushbacks.
  const gate = pushbackGate(db, o.repo);
  const b = loadBlueprint(o.repo, t.blueprint);
  const stage = t.stage as string;
  const repos = ticketRepos(db, o.id);
  // The local agent stops first, so it can't write after the snapshot.
  const open = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  for (const s of open) o.run(["hc", "kill", s.terminal]);
  // The pack: HANDOFF.md and copies of the ticket's files, inside the worktree.
  const pack = join(t.worktree, runDir(o.id));
  mkdirSync(pack, { recursive: true });
  const folder = join(o.dir, "tickets", String(o.id));
  const files = TICKET_FILES.filter((f) => existsSync(join(folder, f)));
  for (const f of files) copyFileSync(join(folder, f), join(pack, f));
  const f = readFactory(o.repo) as any;
  writeFileSync(join(pack, "CLOUD.md"), handoffMd({
    id: o.id, title: t.title, branch: t.branch, blueprint: t.blueprint, stage, left: plannedPath(b, stage), agent: b.stages[stage]?.agent ?? null,
    ready: f.ready ?? ["evidence", "holdout", "quality_floor", "review", "template", "budget"], floor: f.quality_floor ?? [], hardStops: f.hard_stops ?? [...STOPS], files,
    others: repos.slice(1).map((r) => r.repo), noPushbacks: gate.ok ? null : gate.why,
  }));
  // Every repo's work in progress goes up on its branch; the pack rides in the lead's.
  for (const r of repos) {
    git(o.run, r.worktree!, ["add", "-A"], `git add in ${r.repo}`);
    git(o.run, r.worktree!, ["commit", "-q", "--allow-empty", "-m", `factory: hand #${o.id} to a cloud session at ${stage}`], `git commit in ${r.repo}`);
    git(o.run, r.worktree!, ["push", "-u", "origin", r.branch!], `git push in ${r.repo}`);
  }
  const argv = ["claude", "--cloud", `Continue the work described in ${runDir(o.id)}/CLOUD.md on branch ${t.branch}.`, "-n", `factory #${o.id} ${t.title}`.slice(0, 60)];
  const l = launch(o.run, t, argv);
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd) VALUES (?, 'cloud', 'cloud', ?, ?, ?, ?, ?)")
    .run(o.id, l.terminal, JSON.stringify(argv), o.now, l.inSpace, t.worktree);
  db.query("UPDATE tickets SET location = 'cloud', space = ?, detail = 'in a cloud session', updated_at = ? WHERE id = ?").run(l.space, o.now, o.id);
  db.query("UPDATE stages SET detail = 'in a cloud session' WHERE ticket = ? AND ended_at IS NULL").run(o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'you', ?, ?, ?)").run(o.id, `moved to the cloud at ${stage}`, t.branch, o.now);
  return { terminal: l.terminal, stage };
}

// RESULT.md, as CLOUD.md asks for it.
export function parseResult(md: string) {
  const stage = md.match(/^Stage:\s*([\w-]+)/im)?.[1]?.toLowerCase() ?? null;
  const evidence = [...md.matchAll(/^\s*-\s*(PASS|FAIL)\s+([^:\n]+?)\s*:\s*(.*)$/gim)].map((m) => ({ result: m[1].toUpperCase(), check: m[2].trim(), detail: m[3].trim() }));
  const questions = md.match(/^##\s*Questions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1]?.trim() ?? "";
  return { stage, evidence, questions };
}

// `factory local <id>`
export function toLocal(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.location !== "cloud") throw new Error(`#${o.id} isn't in the cloud`);
  // Only the cloud session wrote to the branches since the hand-off, so each fast-forwards.
  for (const x of ticketRepos(db, o.id)) {
    const where = x.lead ? "" : ` in ${x.repo}`;
    git(o.run, x.worktree!, ["fetch", "-q", "origin", x.branch!], `git fetch${where}`);
    git(o.run, x.worktree!, ["merge", "-q", "--ff-only", `origin/${x.branch}`], `fast-forward${where} to the cloud's commits (stop the cloud session at a step, then try again)`);
  }
  const pack = join(t.worktree, runDir(o.id));
  const folder = join(o.dir, "tickets", String(o.id));
  mkdirSync(folder, { recursive: true });
  const resultPath = join(pack, "RESULT.md");
  const result = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : null;
  const r = result ? parseResult(result) : { stage: null, evidence: [], questions: "" };
  // The next local session reads HANDOFF.md (its brief says so); PR.md is the cloud's draft.
  writeFileSync(join(folder, "HANDOFF.md"), result ?? `# Back from the cloud\n\nThe cloud session wrote no RESULT.md. Read the branch's commits since "factory: hand #${o.id} to a cloud session".\n`);
  if (existsSync(join(pack, "PR.md"))) copyFileSync(join(pack, "PR.md"), join(folder, "PR.md"));
  for (const e of r.evidence) db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (?, ?, ?, ?, ?)").run(o.id, e.check, e.result, `${e.detail} (cloud)`, o.now);
  // The pack leaves the branch, so it isn't in the PR.
  rmSync(join(t.worktree, ".factory-run"), { recursive: true, force: true });
  git(o.run, t.worktree, ["add", "-A"], "git add");
  if (o.run(["git", "-C", t.worktree, "diff", "--cached", "--quiet"]).code !== 0)
    git(o.run, t.worktree, ["commit", "-q", "-m", `factory: #${o.id} back from the cloud`], "git commit");
  const cloud = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND stage = 'cloud' AND ended_at IS NULL").all(o.id) as { terminal: string }[];
  db.query("UPDATE sessions SET ended_at = ? WHERE ticket = ? AND ended_at IS NULL").run(o.now, o.id);
  for (const s of cloud) o.run(["hc", "kill", s.terminal]);
  db.query("UPDATE tickets SET location = 'local', detail = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'you', ?, ?, ?)")
    .run(o.id, "brought back from the cloud", `${r.evidence.length} checks; reached ${r.stage ?? "unknown"}`, o.now);
  const b = loadBlueprint(o.repo, t.blueprint);
  if (r.questions) {
    db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ? WHERE id = ?").run(`From the cloud: ${r.questions.split("\n")[0].slice(0, 160)}`, o.id);
    return { stage: t.stage, terminal: null, parked: true };
  }
  const at = r.stage && b.stages[r.stage] ? r.stage : t.stage;
  // The pr stage has no agent: it waits on the ready rules, checked every tick.
  if ((b.stages[at] as any)?.requires === "ready") {
    enterStage(db, o.id, title(at), null, plannedPath(b, at).map(title), o.now);
    return { stage: at, terminal: null };
  }
  const stage = restartStage(b, at);
  return { stage, terminal: startStage(db, { dir: o.dir, repo: o.repo, id: o.id, run: o.run, now: o.now, blueprint: b, stage }) };
}
