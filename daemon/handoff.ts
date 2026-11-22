// Seamless handoff between sessions (plan: Seamless handoff between sessions). Each tick
// the daemon reads how full every live Claude session's context is. At
// budget.handoff_at_context (60%) it flags the session: handoff-hook.ts then refuses
// the next edit until HANDOFF.md is written. A written HANDOFF.md ends the session and
// the next one starts in the same stage, worktree and space. At 80% the session is
// stopped without waiting, and the next one starts from the last commit. The PreCompact
// hook is the backstop: a session Claude Code starts compacting (it filled up between two
// ticks) is stopped the same way, and its snapshot (PRECOMPACT.md) joins the brief.
import { DEFAULT_MODEL } from "./models.ts";
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptDir, parseTranscript, type Use } from "./usage.ts";
import { flagFile, snapshotFile, withHandoffHook } from "./handoff-hook.ts";
import { openAgent, withFactory } from "./herdr.ts";
import { agentSettings, argvFor, brief, loadBlueprint, readFactory, shareFor, type Run } from "./runner.ts";
import { agentRepos, factoryMap, loadAgent } from "./agents.ts";
import { publishStep } from "./artifacts.ts";
import { loadPrompt, render } from "./prompts.ts";
import { settingOf } from "./learn.ts";
import { ticketRepos } from "./db.ts";
import { slicesOf } from "./slices.ts";

export const DEFAULT_HANDOFF_AT = 0.6;
export const CEILING = 0.8;

// The context window per model: 200k unless the model is marked [1m].
export const contextWindow = (...names: string[]) => (names.some((n) => /\[1m\]/i.test(n)) ? 1_000_000 : 200_000);

// What the session's last message had in context: input, cache reads and cache writes,
// over the window. `names` are other places the model shows up (the argv's --model keeps
// its [1m], which the transcript's model id drops). null: nothing said yet.
export function contextFill(uses: Use[], names: string[] = []) {
  const last = [...uses].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!last) return null;
  return (last.input + last.w5m + last.w1h + last.read) / contextWindow(last.model, ...names);
}

// budget.handoff_at_context: 60%, "60%" or 0.6.
export function handoffAt(budget: { handoff_at_context?: number | string } | undefined) {
  const v = parseFloat(String(budget?.handoff_at_context ?? ""));
  if (!(v > 0)) return DEFAULT_HANDOFF_AT;
  return v > 1 ? v / 100 : v;
}

export type Step = "none" | "flag" | "ceiling";
// flag: ask for a handoff now. ceiling: stop the session without waiting for one.
export const handoffStep = (fill: number, o: { at: number; flagged: boolean }): Step =>
  fill >= CEILING ? "ceiling" : fill >= o.at && !o.flagged ? "flag" : "none";

export const SECTIONS: [string, RegExp][] = [
  ["goal", /^goal/i], ["done", /^done/i], ["in progress", /^in progress/i], ["next step", /^next step/i],
  ["open decisions", /^open decisions/i], ["commands to re-run", /^commands to re-run/i], ["gotchas", /^gotchas/i],
];

// The required sections HANDOFF.md lacks: no heading for it, or a heading with nothing under it.
export function missingSections(text: string) {
  const parts = text.split(/^#{1,6}[ \t]+/m).slice(1).map((p) => {
    const [head, ...body] = p.split("\n");
    return { head: head.trim(), body: body.join("\n").trim() };
  });
  return SECTIONS.filter(([, re]) => !parts.some((p) => re.test(p.head) && p.body)).map(([name]) => name);
}

type Row = { id: number; ticket: number; stage: string; agent: string | null; terminal: string; argv: string; started_at: string; cwd: string | null; space: string | null; worktree: string | null; settings?: string | null; slice?: string | null };
type Flag = { session: number; at: string; fill: number; asked?: boolean; message?: string };

// The session's own transcripts: the top-level files in its folder written since it started.
function sessionTranscripts(s: Row) {
  const dirs = [s.cwd ?? s.worktree ?? ""].flatMap((d) => (d && existsSync(d) ? [d, realpathSync(d)] : [d]));
  return [...new Set(dirs)].flatMap((d) => {
    const dir = transcriptDir(d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
  }).filter((f) => statSync(f).mtimeMs >= Date.parse(s.started_at) - 1000);
}

function sessionFill(s: Row) {
  const argv: string[] = JSON.parse(s.argv);
  const names = argv.flatMap((a, i) => (argv[i - 1] === "--model" ? [a] : []));
  const uses = sessionTranscripts(s).flatMap((f) => parseTranscript(readFileSync(f, "utf8")).filter((u) => u.at >= s.started_at));
  return contextFill(uses, names);
}

// What the session said last: its newest transcript's last few assistant messages, each cut
// short, and where the whole transcript is. "" when there is none.
export function transcriptTail(s: Row, messages = 3, chars = 800) {
  const file = sessionTranscripts(s).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
  if (!file) return "";
  const said = readFileSync(file, "utf8").split("\n").flatMap((line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return []; }
    if (e?.type !== "assistant" || (e.timestamp && e.timestamp < s.started_at) || !Array.isArray(e.message?.content)) return [];
    const text = e.message.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n").trim();
    return text ? [text.length > chars ? `${text.slice(0, chars)}…` : text] : [];
  }).slice(-messages);
  return [...said.map((t) => `> ${t.replace(/\n/g, "\n> ")}`), `(The whole transcript: ${file})`].join("\n\n");
}

const readFlag = (dir: string, id: number): Flag | null => { try { return JSON.parse(readFileSync(flagFile(dir, id), "utf8")); } catch { return null; } };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const say = (run: Run, terminal: string, text: string) => run(["hc", "send", "--if", "idle", terminal, text]).code === 0;

export function watchContext(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const budget = (readFactory(o.repo) as { budget?: { handoff_at_context?: number | string } }).budget;
  const rows = db.query(`SELECT s.id, s.ticket, s.stage, s.agent, s.terminal, s.argv, s.started_at, s.cwd, s.slice, t.space, t.worktree, t.settings
    FROM sessions s JOIN ticket_lead t ON t.id = s.ticket
    WHERE s.ended_at IS NULL AND s.terminal IS NOT NULL AND t.state = 'running' AND t.location != 'cloud' AND s.argv LIKE '["claude"%'
    AND s.id = (SELECT MAX(id) FROM sessions WHERE ticket = s.ticket)`).all() as Row[];
  for (const s of rows) {
    try {
      const at = handoffAt({ handoff_at_context: settingOf(s, "budget.handoff_at_context", budget?.handoff_at_context) }); // the ticket's own, fixed at its start
      const fill = sessionFill(s);
      // The backstop: Claude Code began compacting it, whatever the transcript says now.
      if (existsSync(snapshotFile(o.dir, s.ticket))) {
        nextSession(db, { ...o, s, fill: fill ?? CEILING, ceiling: true, compacted: true, missing: [], folder: join(o.dir, "tickets", String(s.ticket)) });
        continue;
      }
      if (fill == null) continue;
      const flag = readFlag(o.dir, s.ticket);
      const flagged = flag?.session === s.id;
      const step = handoffStep(fill, { at, flagged });
      const folder = join(o.dir, "tickets", String(s.ticket));
      if (step === "flag") {
        const message = "handoff requested: write HANDOFF.md now";
        writeFileSync(flagFile(o.dir, s.ticket), JSON.stringify({ session: s.id, at: o.now, fill, message } satisfies Flag));
        db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(`handoff at ${pct(at)}`, s.ticket);
        db.query("UPDATE tickets SET detail = ? WHERE id = ?").run(`handoff at ${pct(at)}`, s.ticket);
        db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(s.ticket, "asked the session for a handoff", `context at ${pct(fill)}, over ${pct(at)}`, o.now);
        say(o.run, s.terminal, `Context is at ${pct(fill)}. ${message} (${folder}/HANDOFF.md, with sections: ${SECTIONS.map(([n]) => n).join(", ")}). Then stop.`);
        o.log?.(`factory: #${s.ticket}'s session is at ${pct(fill)} of its context; asked for a handoff`);
        continue;
      }
      let missing: string[] = [];
      if (step === "none") {
        const file = join(folder, "HANDOFF.md");
        if (!flagged || !existsSync(file) || statSync(file).mtimeMs < Date.parse(flag!.at)) continue;
        missing = missingSections(readFileSync(file, "utf8"));
        if (missing.length && !flag!.asked) {
          const message = `HANDOFF.md is missing: ${missing.join(", ")}. Fill those sections in, then stop.`;
          writeFileSync(flagFile(o.dir, s.ticket), JSON.stringify({ ...flag, asked: true, message: `handoff requested: ${message}` }));
          say(o.run, s.terminal, message);
          continue;
        }
      }
      nextSession(db, { ...o, s, fill, ceiling: step === "ceiling", missing, folder });
    } catch (e) {
      o.log?.(`factory: #${s.ticket}: handoff: ${(e as Error).message}`);
    }
  }
}

const out = (run: Run, cwd: string, ...argv: string[]) => run(["git", "-C", cwd, ...argv]).out;
const section = (text: string, re: RegExp) => text.split(/^(?=#{1,6}[ \t])/m).find((p) => re.test(p.replace(/^#+[ \t]+/, "")));

// The next session's brief: the stage's usual one (stable parts first), then what this handoff adds (prompts/handoff.md).
// `limit`: the plan limit stopped the last session (planlimit.ts), in words for the brief.
function handoffBrief(db: Database, o: { dir: string; repo: string; run: Run; s: Row; folder: string; ceiling: boolean; compacted?: boolean; limit?: string; fill: number; missing: string[]; n: number }) {
  const t = db.query("SELECT id, title FROM tickets WHERE id = ?").get(o.s.ticket) as { id: number; title: string };
  const agent = o.s.agent ? loadAgent(agentRepos(db, o.s.ticket, o.repo), o.s.agent) : null;
  const repos = ticketRepos(db, o.s.ticket);
  const read = (f: string) => { try { return readFileSync(join(o.folder, f), "utf8"); } catch { return ""; } };
  const intent = section(read("INTENT.md"), /^acceptance/i);
  const slices = slicesOf(read("SLICES.md"));
  // The slice in hand: the session's own (per: slice), else the first one not marked done.
  const slice = (o.s.slice ? slices.find((x) => x.key === o.s.slice) : slices.find((x) => !x.marked))?.text ?? read("SLICES.md");
  const cmds = readFactory(o.repo).quality_floor ?? [];
  const checks = (db.query(`SELECT check_name, result, detail FROM evidence e WHERE ticket = ? AND id = (SELECT MAX(id) FROM evidence WHERE ticket = e.ticket AND check_name = e.check_name) ORDER BY id DESC LIMIT 6`)
    .all(o.s.ticket) as { check_name: string; result: string; detail: string | null }[]).map((c) => `- ${c.check_name}: ${c.result}${c.detail ? ` (${c.detail})` : ""}`);
  const stats = repos.filter((r) => r.worktree).map((r) => {
    const base = out(o.run, r.path, "rev-parse", "--abbrev-ref", "HEAD");
    const from = out(o.run, r.worktree!, "merge-base", "HEAD", base) || "HEAD";
    const loose = out(o.run, r.worktree!, "status", "--short"); // new files aren't in a diff
    return `${repos.length > 1 ? `${r.repo}:\n` : ""}${out(o.run, r.worktree!, "diff", "--stat", from) || "no changes yet"}${loose ? `\nnot committed:\n${loose}` : ""}`;
  });
  const handoff = read("HANDOFF.md").trim();
  const lastCommit = out(o.run, o.s.cwd ?? o.s.worktree!, "log", "-1", "--format=%h %s");
  const own = (db.query("SELECT blueprint FROM tickets WHERE id = ?").get(t.id) as { blueprint: string } | null)?.blueprint;
  let stagePrompt: string | undefined, output: string | undefined;
  try { ({ prompt: stagePrompt, output } = own ? loadBlueprint(o.repo, own).stages[o.s.stage] ?? {} : {}); } catch {}
  const share = shareFor(db, { repo: o.repo, id: t.id, folder: o.folder, output });
  const stageBrief = brief(t, o.s.stage, agent?.prompt ?? null, o.folder, agent?.role, repos, [], loadPrompt(o.repo, stagePrompt ?? "stage"), "", share);
  // The handoff this session starts from is renamed HANDOFF.session-<n-1>.md; it is shared as HANDOFF.md.
  const kept = join(o.folder, `HANDOFF.session-${o.n - 1}.md`);
  return render(loadPrompt(o.repo, "handoff"), {
    neighbours: factoryMap(db), // the stage brief inside goes without it: the map leads once
    "ticket.id": String(t.id),
    "ticket.title": t.title,
    stage: o.s.stage,
    folder: o.folder,
    session: String(o.n),
    stage_brief: stageBrief,
    previous: o.limit ? `${o.limit}. Its work in progress is committed; start from its last commit, ${lastCommit || "none yet"}, the diff below and the end of its transcript`
      : o.compacted ? `ran out of room (Claude Code began compacting its context) before it could hand off, so there is no HANDOFF.md: start from its last commit, ${lastCommit || "none yet"}, the diff below and its PreCompact snapshot`
      : o.ceiling ? `ran out of room (${pct(o.fill)} of its context) before it could hand off, so there is no HANDOFF.md: start from its last commit, ${lastCommit || "none yet"}, and the diff below` : "handed off at a step boundary and its work in progress is committed",
    rerun: cmds.length ? `First, re-run the current check and read its result before you change anything: ${cmds.map((c) => `\`${c}\``).join(" and ")}.` : "First, re-run the current check before you change anything.",
    handoff: !o.ceiling && handoff ? `${handoff}${o.missing.length ? `\n\n(The last session left these sections out: ${o.missing.join(", ")}.)` : ""}` : "",
    slice: slice.trim(),
    acceptance: intent ? intent.replace(/^#+[ \t]+.*\n/, "").trim() : "",
    acceptance_missing: intent ? "" : `The acceptance checks are in ${o.folder}/INTENT.md.`,
    diff: stats.join("\n\n"),
    last_check: checks.join("\n"),
    tail: o.limit ? transcriptTail(o.s) : "",
    snapshot: o.ceiling ? read("PRECOMPACT.md").replace(/^# PreCompact snapshot\s*/, "").trim() : "",
    publish_handoff: !o.ceiling && handoff ? publishStep(share.policy, { id: t.id, file: "HANDOFF.md", path: kept, links: share.links, when: "After the check, before you change anything", what: "the handoff you start from" }) : "",
  });
}

// Commits each of the ticket's repos' work in progress, where there is any.
function commitWip(db: Database, run: Run, ticket: number, message: string) {
  for (const r of ticketRepos(db, ticket)) {
    if (!r.worktree || !out(run, r.worktree, "status", "--porcelain")) continue;
    out(run, r.worktree, "add", "-A");
    out(run, r.worktree, "commit", "-q", "--no-verify", "-m", message);
  }
}

const sessionCount = (db: Database, ticket: number) => (db.query("SELECT COUNT(*) AS n FROM sessions WHERE ticket = ?").get(ticket) as { n: number }).n;

// Commits the work in progress, ends the session and starts the next in the same stage.
function nextSession(db: Database, o: { dir: string; repo: string; run: Run; now: string; s: Row; fill: number; ceiling: boolean; compacted?: boolean; missing: string[]; folder: string; log?: (s: string) => void }) {
  const { s, run } = o;
  const n = sessionCount(db, s.ticket) + 1;
  if (!o.ceiling) commitWip(db, run, s.ticket, `factory: #${s.ticket} work in progress at the handoff to session ${n}`);
  const text = handoffBrief(db, { ...o, n });
  launch(db, { ...o, n, text, stop: () => {
    run(["hc", "kill", s.terminal]);
    db.query("UPDATE sessions SET ended_at = ? WHERE id = ?").run(o.now, s.id);
  } });
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(s.ticket,
    `started session ${n}`, o.compacted ? "Claude Code began compacting the last one; its last commit and the PreCompact snapshot are the brief" : o.ceiling ? `the last one reached ${pct(o.fill)} of its context; its last commit is the brief` : `handoff at ${pct(o.fill)} of context${o.missing.length ? `; missing ${o.missing.join(", ")}` : ""}`, o.now);
  o.log?.(`factory: #${s.ticket}: session ${n} started in ${s.stage}`);
}

// The plan limit stopped this session (planlimit.ts): its work in progress is committed and it
// ends. Nothing starts until the window resets; then resumeAtReset starts a fresh session.
export function stopAtLimit(db: Database, o: { run: Run; now: string; s: { id: number; ticket: number; terminal: string } }) {
  commitWip(db, o.run, o.s.ticket, `factory: #${o.s.ticket} work in progress at the plan limit (session ${sessionCount(db, o.s.ticket)})`);
  o.run(["hc", "kill", o.s.terminal]);
  db.query("UPDATE sessions SET ended_at = ? WHERE id = ?").run(o.now, o.s.id);
}

// After the reset: a fresh session in the stage and slice the stopped one was in, never the old
// conversation (its prompt cache is long gone, so going on would resend all of it at full
// price). Its brief is the handoff brief, from the last commit, the diff and the transcript's end.
export function resumeAtReset(db: Database, o: { dir: string; repo: string; run: Run; now: string; id: number; limit: string; log?: (s: string) => void }) {
  const s = db.query(`SELECT s.id, s.ticket, s.stage, s.agent, s.terminal, s.argv, s.started_at, s.cwd, s.slice, t.space, t.worktree, t.settings
    FROM sessions s JOIN ticket_lead t ON t.id = s.ticket WHERE s.ticket = ? ORDER BY s.id DESC LIMIT 1`).get(o.id) as Row | null;
  if (!s) throw new Error(`#${o.id} has no session to resume`);
  const folder = join(o.dir, "tickets", String(o.id));
  const n = sessionCount(db, o.id) + 1;
  const text = handoffBrief(db, { ...o, s, folder, ceiling: true, limit: o.limit, fill: 0, missing: [], n });
  launch(db, { ...o, s, folder, n, text });
  return n;
}

// Starts session n of the stage with the brief `text`. The snapshot and the handoff it read are
// kept beside the session's handoffs (the next session's hook would remove the one, and the
// other would fool the next handoff's mtime check). `stop` ends the session before it, once
// the new one's command is built.
function launch(db: Database, o: { dir: string; repo: string; run: Run; now: string; s: Row; folder: string; n: number; text: string; stop?: () => void }) {
  const { s, run, n } = o;
  const snap = snapshotFile(o.dir, s.ticket);
  if (existsSync(snap)) renameSync(snap, join(o.folder, `PRECOMPACT.session-${n - 1}.md`));
  const agent = s.agent ? loadAgent(agentRepos(db, s.ticket, o.repo), s.agent) : null;
  const defaults = { harness: "claude", model: DEFAULT_MODEL };
  const argv = withHandoffHook(argvFor(agentSettings(s, s.agent ?? "", agent, defaults), defaults, o.text), o.dir, s.ticket, null, readFactory(o.repo).quality_floor ?? [], [o.folder, ...ticketRepos(db, s.ticket).flatMap((r) => r.worktree ?? [])], shareFor(db, { repo: o.repo, id: s.ticket, folder: o.folder }).allow);
  const cmd = withFactory(argv, o.dir, { agent: s.agent, ticket: s.ticket });
  o.stop?.();
  const file = join(o.folder, "HANDOFF.md");
  if (existsSync(file)) renameSync(file, join(o.folder, `HANDOFF.session-${n - 1}.md`));
  const name = `f${s.ticket}-${s.stage}`.slice(0, 32);
  const labels = [`factory.ticket=${s.ticket}`, `factory.stage=${s.stage}`];
  const made = openAgent(run, { folder: s.worktree!, space: s.space, name: s.stage, argv: cmd });
  let terminal: string;
  if (made) {
    terminal = made.terminal;
    run(["hc", "label", terminal, ...labels]);
    db.query("UPDATE tickets SET space = ? WHERE id = ?").run(made.space, s.ticket);
  } else {
    const hc = run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", s.worktree!, ...labels.flatMap((l) => ["--label", l]), ...cmd]);
    if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
    terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  }
  // The next session goes on with the same slice.
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd, slice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(s.ticket, s.stage, s.agent, terminal, JSON.stringify(argv), o.now, made ? 1 : 0, s.worktree, s.slice ?? null);
  const detail = `${s.agent} agent · session ${n}`;
  db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, s.ticket);
  db.query("UPDATE tickets SET detail = ?, updated_at = ? WHERE id = ?").run(detail, o.now, s.ticket);
  return terminal;
}
