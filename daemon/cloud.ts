// M3 local ⇄ cloud (plan: Local and cloud). `⇧C` hands a running ticket to a Claude
// Code cloud session: the work in progress is committed with a pack of the ticket's files
// (.factory-run/<id>/) and pushed, and `claude --cloud` starts with the brief as its
// description. .factory/ stays local (local.ts), so nothing from it goes on the branch: the
// agents' prompts, the stages and the rules ride in the brief, never in the pack. The factory
// can't see a cloud session, so the ticket shows "in cloud" and the daemon leaves it alone
// until `⇧L` fetches the branch, imports RESULT.md (evidence, notes, PR.md), and resumes locally.
import { STOPS } from "./guard.ts";
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, ticketRepos } from "./db.ts";
import { openAgent } from "./herdr.ts";
import { pushbackGate } from "./agreement.ts";
import { artifactPolicy, sharedLinks, type Kind, type Link } from "./artifacts.ts";
import { agentRepos, loadAgent } from "./agents.ts";
import { LOCAL_REASON } from "./local.ts";
import { enterStage } from "./ticket.ts";
import { loadBlueprint, localChanges, plannedPath, readFactory, restartStage, startStage, title, type Run } from "./runner.ts";
import { endSessions, journal } from "./journal.ts";

const TICKET_FILES = ["STATUS.md", "EVIDENCE.md", "GATES.md", "REVIEW.md", "INTENT.md", "SLICES.md", "HANDOFF.md", "GROOMING.md", "PR.md"];
const RULES: Record<string, string> = {
  evidence: "every acceptance check has a PASS recorded after the last commit",
  holdout: "hidden checks written by the checker pass",
  quality_floor: "the quality floor commands all pass",
  review: "a reviewer finds no blockers",
  template: "PR.md opens with one plain sentence, then What changed, Why, How it was verified, Risk",
  budget: "the ticket stays within its token budget",
};

// The brief is one argument to `claude --cloud`; Linux caps one argument at 128 KiB. The
// stage now always gets its agent's prompt; a later stage's goes in only while it fits.
export const BRIEF_CAP = 100_000;

// A stage of the path the cloud session walks, with its agent as the checkout holds it.
export type CloudStage = { stage: string; agent: string | null; prompt: string | null; skills: string[] };

export const runDir = (id: number) => join(".factory-run", String(id));

// The cloud session's whole brief, passed as its description: where the ticket stands, the
// rules, what to report, then each stage's agent prompt. Nothing in it points at .factory/,
// which isn't on the branch.
export function cloudBrief(o: { id: number; title: string; branch: string; blueprint: string; stages: CloudStage[];
  ready: string[]; floor: string[]; hardStops: string[]; files: string[]; others?: string[]; noPushbacks?: string | null; shared?: Link[]; as?: Kind; cap?: number }) {
  const here = runDir(o.id);
  const others = o.others ?? [];
  const shared = o.shared ?? [];
  const [now, ...left] = o.stages;
  const tool = o.as === "doc" ? "the Claude Docs connector (mcp__claude_ai_Claude_Docs__read)" : "your Artifact tool (action read)";
  const head = `# #${o.id} ${o.title}: continue in the cloud

You're continuing a ticket the local factory was running. The factory isn't reachable from here (there is no \`factory\` command), so you report through files. Work only on the branch \`${o.branch}\`. Never push to main, and never open, edit or merge a pull request. The factory's own files (\`.factory/\`) stay on the person's machine and aren't on this branch: everything you need from them is in this brief. Don't create \`.factory/\` here.
${others.length ? `
This ticket changes ${others.length + 1} repos, each on the same branch \`${o.branch}\`, already pushed: this one and ${others.map((r) => `\`${r}\``).join(", ")}. Clone each other repo on that branch (\`gh repo clone ${others[0]} -- -b ${o.branch}\`), change it where the work needs, and push it to that branch too. The pack and RESULT.md stay in this repo.
` : ""}
## Where it stands

- Blueprint: \`${o.blueprint}\`.
- Stage now: **${now.stage}**${now.agent ? `, run by the \`${now.agent}\` agent: follow its prompt below` : ""}.
- Stages left after it: ${left.length ? left.map((s) => s.stage).join(" → ") : "none"}. For each stage with an agent, follow that agent's prompt below.
- The ticket's files from the factory are in \`${here}/\`: ${o.files.length ? o.files.join(", ") : "none yet"}. Act on every note in REVIEW.md and GATES.md.
${shared.length ? `- The plan is shared on claude.ai too: ${shared.map((l) => `${l.file} ${l.url}`).join(", ")}. Read it there with ${tool} if the copy in \`${here}/\` is missing; the two hold the same text. If you change one of those files, republish it to the same link (best-effort: carry on if the publish fails).
` : ""}
## Rules

- The PR opens only when these ready rules pass: ${o.ready.map((r) => `${r} (${RULES[r] ?? r})`).join("; ")}.
- Quality floor, run before you stop: ${o.floor.length ? o.floor.map((c) => `\`${c}\``).join(", ") : "none set"}.
- Hard stops: ${o.hardStops.length ? o.hardStops.join(", ") : "push-to-main, outside-worktree, destructive-commands, secrets-in-output"}.
- A product question (what to build, for whom, wording, scope) isn't yours to answer: write it under Questions and stop.
${o.noPushbacks ? `- Don't push back on a review comment: ${o.noPushbacks}. Fix a comment only when the fix is clear-cut; put every other one under Questions.\n` : ""}- When the work is ready for review, write \`${here}/PR.md\`: one plain sentence, then **What changed:**, **Why:**, **How it was verified:**, **Risk:**.
- Where an agent's prompt below says to run a \`factory\` command, there is none here: write what it would have recorded in RESULT.md instead.

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
  const cap = o.cap ?? BRIEF_CAP;
  const block = (s: CloudStage, prompt: string) => [`### ${s.stage}: the \`${s.agent}\` agent`, prompt,
    s.skills.length ? `Its skills (${s.skills.join(", ")}) are on the person's machine, not in this session: do the work without them.` : ""].filter(Boolean).join("\n\n");
  const withAgent = o.stages.filter((s) => s.agent);
  if (!withAgent.length) return head;
  const parts = [head, "## The agents' prompts"];
  const size = () => parts.join("\n\n").length;
  const cut: string[] = [];
  for (const s of withAgent) {
    const prompt = s.prompt ?? "(no prompt: the checkout has no file for this agent; do the stage from its name and the rules above)";
    const full = block(s, prompt);
    if (s === now) {
      // The stage now always gets its prompt, cut short only if it alone overflows the brief.
      const room = cap - size() - 200;
      parts.push(full.length <= room ? full : `${full.slice(0, Math.max(0, room))}\n\n(The rest of this prompt didn't fit in the brief.)`);
    } else if (!cut.length && size() + full.length + 2 <= cap) parts.push(full);
    else cut.push(s.stage);
  }
  if (cut.length) parts.push(`The prompts for ${cut.join(", ")} didn't fit in this brief. Stop before ${cut[0]}: write RESULT.md with the stage you reached, and the factory runs the rest locally.`);
  return parts.join("\n\n") + "\n";
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
export function toCloud(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; reason?: string }) {
  const t = db.query("SELECT * FROM ticket_lead WHERE id = ?").get(o.id) as Record<string, any> | null;
  if (!t) throw new Error(`no ticket ${o.id}`);
  if (t.location === "cloud") throw new Error(`#${o.id} is in the cloud already`);
  if (t.state !== "running" || !t.worktree) throw new Error(`#${o.id} is ${t.state}; only a running ticket moves to the cloud`);
  // Nobody is there to ask in the cloud: below the agreement bar, the pack says no pushbacks.
  const gate = pushbackGate(db, o.repo);
  const b = loadBlueprint(o.repo, t.blueprint);
  const stage = t.stage as string;
  const repos = ticketRepos(db, o.id);
  // .factory/ stays local (local.ts): a branch that committed to it can't go up, or the push would carry it.
  const local = localChanges(o.run, repos, t.base ?? undefined);
  if (local.length) throw new Error(`${LOCAL_REASON} (${local.slice(0, 3).join(", ")}), so it can't go to the cloud: the push would carry it`);
  // The pack: copies of the ticket's files, inside the worktree. Never anything from .factory/.
  const pack = join(t.worktree, runDir(o.id));
  mkdirSync(pack, { recursive: true });
  rmSync(join(pack, "CLOUD.md"), { force: true }); // an older factory's brief, which named .factory/ paths
  const folder = join(o.dir, "tickets", String(o.id));
  const files = TICKET_FILES.filter((f) => existsSync(join(folder, f)));
  for (const f of files) copyFileSync(join(folder, f), join(pack, f));
  const f = readFactory(o.repo) as any;
  // Each stage's agent as the local runner loads it (the checkout's .factory/agents/), inlined.
  const from = agentRepos(db, o.id, o.repo);
  const stages: CloudStage[] = [stage, ...plannedPath(b, stage)].map((s) => {
    const name = b.stages[s]?.agent ?? null;
    const a = name ? loadAgent(from, name) : null;
    return { stage: s, agent: name, prompt: a?.prompt ?? null, skills: Array.isArray(a?.skills) ? a.skills.filter((x: unknown): x is string => typeof x === "string") : [] };
  });
  const brief = cloudBrief({
    id: o.id, title: t.title, branch: t.branch, blueprint: t.blueprint, stages,
    ready: f.ready ?? ["evidence", "holdout", "quality_floor", "review", "template", "budget"], floor: f.quality_floor ?? [], hardStops: f.hard_stops ?? [...STOPS], files,
    others: repos.slice(1).map((r) => r.repo), noPushbacks: gate.ok ? null : gate.why,
    shared: sharedLinks(db, o.id, artifactPolicy(f)), as: artifactPolicy(f).as,
  });
  // Every repo's work in progress goes up on its branch while the local agent is still alive; the pack
  // rides in the lead's. A retry commits nothing new when nothing changed, so it never duplicates the commit.
  // .factory/ is unstaged, so it stays out even where a repo isn't adopted yet (no exclude line).
  const snapshot = () => {
    for (const r of repos) {
      git(o.run, r.worktree!, ["add", "-A"], `git add in ${r.repo}`);
      o.run(["git", "-C", r.worktree!, "reset", "-q", "--", ".factory"]);
      if (o.run(["git", "-C", r.worktree!, "diff", "--cached", "--quiet"]).code !== 0)
        git(o.run, r.worktree!, ["commit", "-q", "-m", `factory: hand #${o.id} to a cloud session at ${stage}`], `git commit in ${r.repo}`);
      git(o.run, r.worktree!, ["push", "-u", "origin", r.branch!], `git push in ${r.repo}`);
    }
  };
  const dirty = () => repos.some((r) => o.run(["git", "-C", r.worktree!, "status", "--porcelain", "--", ".", ":(exclude).factory"]).out.trim() !== "");
  snapshot();
  // The agent may have written while the push ran; snapshot again until the tree is quiet.
  for (let i = 0; i < 3 && dirty(); i++) snapshot();
  const argv = ["claude", "--cloud", brief, "-n", `factory #${o.id} ${t.title}`.slice(0, 60)];
  const l = launch(o.run, t, argv); // throws with the local agent still running and the ticket still local
  // Safe now: the work is pushed and the cloud session started. Stop the local agent.
  const open = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND ended_at IS NULL AND terminal IS NOT NULL").all(o.id) as { terminal: string }[];
  endSessions(db, { ticket: o.id, at: o.now, why: "handed to a cloud session" });
  for (const s of open) o.run(["hc", "kill", s.terminal]);
  // Anything written in the last instant stays in the worktree and the local branch; push it best-effort.
  try { if (dirty()) snapshot(); } catch {}
  const session = Number(db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd) VALUES (?, 'cloud', 'cloud', ?, ?, ?, ?, ?)")
    .run(o.id, l.terminal, JSON.stringify(argv), o.now, l.inSpace, t.worktree).lastInsertRowid);
  journal(db, { ticket: o.id, session, kind: "cloud", text: `moved to a cloud session at ${stage}${o.reason ? ` (${o.reason})` : ""}`, ref: `session:${session}`, at: o.now });
  db.query("UPDATE tickets SET location = 'cloud', space = ?, detail = 'in a cloud session', updated_at = ? WHERE id = ?").run(l.space, o.now, o.id);
  db.query("UPDATE stages SET detail = 'in a cloud session' WHERE ticket = ? AND ended_at IS NULL").run(o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)")
    .run(o.id, o.reason ? "daemon" : "you", `moved to the cloud at ${stage}`, o.reason ?? t.branch, o.now);
  return { terminal: l.terminal, stage, brief };
}

// A move that failed leaves the ticket local with its agent running; say why on the ticket.
// Written outside the move's transaction, which a failure rolls back.
export const noteCloudFailure = (db: Database, id: number, why: string, now: string, reason?: string) =>
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(id, `couldn't move to the cloud${reason ? ` for ${reason}` : ""}; the agent keeps running here`, why.slice(0, 300), now);

// RESULT.md, as the cloud brief asks for it.
export function parseResult(md: string) {
  const stage = md.match(/^Stage:\s*([\w-]+)/im)?.[1]?.toLowerCase() ?? null;
  const evidence = [...md.matchAll(/^\s*-\s*(PASS|FAIL)\s+([^:\n]+?)\s*:\s*(.*)$/gim)].map((m) => ({ result: m[1].toUpperCase(), check: m[2].trim(), detail: m[3].trim() }));
  const questions = md.match(/^##\s*Questions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1]?.trim() ?? "";
  return { stage, evidence, questions };
}

// `factory local <id>`
export function toLocal(db: Database, o: { dir: string; repo: string; id: number; run: Run; now: string; reason?: string }) {
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
  // The pack leaves the branch, so it isn't in the PR. It is deleted from disk only after the commit
  // succeeds, so a failed attempt can be retried with RESULT.md still there.
  git(o.run, t.worktree, ["add", "-A", "--", ".", ":!.factory-run"], "git add");
  o.run(["git", "-C", t.worktree, "rm", "-rq", "--cached", "--ignore-unmatch", ".factory-run"]);
  if (o.run(["git", "-C", t.worktree, "diff", "--cached", "--quiet"]).code !== 0)
    git(o.run, t.worktree, ["commit", "-q", "-m", `factory: #${o.id} back from the cloud`], "git commit");
  rmSync(join(t.worktree, ".factory-run"), { recursive: true, force: true });
  const cloud = db.query("SELECT terminal FROM sessions WHERE ticket = ? AND stage = 'cloud' AND ended_at IS NULL").all(o.id) as { terminal: string }[];
  endSessions(db, { ticket: o.id, at: o.now, why: "back from the cloud" });
  journal(db, { ticket: o.id, kind: "cloud", text: `brought back from the cloud${o.reason ? ` (${o.reason})` : ""}: ${r.evidence.length} checks; reached ${r.stage ?? "unknown"}`, at: o.now });
  for (const s of cloud) o.run(["hc", "kill", s.terminal]);
  db.query("UPDATE tickets SET location = 'local', detail = NULL, updated_at = ? WHERE id = ?").run(o.now, o.id);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)")
    .run(o.id, o.reason ? "daemon" : "you", "brought back from the cloud", `${o.reason ? `${o.reason}: ` : ""}${r.evidence.length} checks; reached ${r.stage ?? "unknown"}`, o.now);
  const b = loadBlueprint(o.repo, t.blueprint);
  if (r.questions) {
    db.query("UPDATE tickets SET state = 'parked', needs_kind = 'parked', needs_text = ? WHERE id = ?").run(`From the cloud: ${r.questions.split("\n")[0].slice(0, 160)}`, o.id);
    // As open questions, so u talks them through in a fresh local session instead of an answer box.
    let n = ((db.query("SELECT MAX(n) AS m FROM questions WHERE ticket = ?").get(o.id) as { m: number | null }).m ?? 0);
    for (const q of r.questions.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim()).filter(Boolean))
      { db.query("INSERT INTO questions (ticket, n, kind, text, asked_at) VALUES (?, ?, 'engineering', ?, ?)").run(o.id, ++n, q, o.now);
        journal(db, { ticket: o.id, kind: "question", text: `Q${n} (engineering, from the cloud): ${q}`, ref: `question:${n}`, at: o.now }); }
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
