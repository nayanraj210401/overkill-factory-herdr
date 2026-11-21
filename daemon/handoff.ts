// Seamless handoff between sessions (plan: Seamless handoff between sessions). Each tick
// the daemon reads how full every live Claude session's context is. At
// budget.handoff_at_context (60%) it flags the session: handoff-hook.ts then refuses
// the next edit until HANDOFF.md is written. A written HANDOFF.md ends the session and
// the next one starts in the same stage, worktree and space. At 80% the session is
// stopped without waiting, and the next one starts from the last commit.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptDir, parseTranscript, type Use } from "./usage.ts";
import { flagFile, withHandoffHook } from "./handoff-hook.ts";
import { openAgent } from "./herdr.ts";
import { argvFor, brief, loadAgent, readFactory, type Run } from "./runner.ts";
import { ticketRepos } from "./db.ts";

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

type Row = { id: number; ticket: number; stage: string; agent: string | null; terminal: string; argv: string; started_at: string; cwd: string | null; space: string | null; worktree: string | null };
type Flag = { session: number; at: string; fill: number; asked?: boolean; message?: string };

// The session's own transcript: the newest top-level file in its folder since it started.
function sessionFill(s: Row) {
  const argv: string[] = JSON.parse(s.argv);
  const names = argv.flatMap((a, i) => (argv[i - 1] === "--model" ? [a] : []));
  const dirs = [s.cwd ?? s.worktree ?? ""].flatMap((d) => (d && existsSync(d) ? [d, realpathSync(d)] : [d]));
  const uses = [...new Set(dirs)].flatMap((d) => {
    const dir = transcriptDir(d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
  }).filter((f) => statSync(f).mtimeMs >= Date.parse(s.started_at) - 1000)
    .flatMap((f) => parseTranscript(readFileSync(f, "utf8")).filter((u) => u.at >= s.started_at));
  return contextFill(uses, names);
}

const readFlag = (dir: string, id: number): Flag | null => { try { return JSON.parse(readFileSync(flagFile(dir, id), "utf8")); } catch { return null; } };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const say = (run: Run, terminal: string, text: string) => run(["hc", "send", "--if", "idle", terminal, text]).code === 0;

export function watchContext(db: Database, o: { dir: string; repo: string; run: Run; now: string; log?: (s: string) => void }) {
  const at = handoffAt((readFactory(o.repo) as { budget?: { handoff_at_context?: number | string } }).budget);
  const rows = db.query(`SELECT s.id, s.ticket, s.stage, s.agent, s.terminal, s.argv, s.started_at, s.cwd, t.space, t.worktree
    FROM sessions s JOIN ticket_lead t ON t.id = s.ticket
    WHERE s.ended_at IS NULL AND s.terminal IS NOT NULL AND t.state = 'running' AND t.location != 'cloud' AND s.argv LIKE '["claude"%'
    AND s.id = (SELECT MAX(id) FROM sessions WHERE ticket = s.ticket)`).all() as Row[];
  for (const s of rows) {
    try {
      const fill = sessionFill(s);
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

// The next session's brief: the usual one (stable parts first), then what this handoff adds.
function handoffBrief(db: Database, o: { dir: string; repo: string; run: Run; s: Row; folder: string; ceiling: boolean; fill: number; missing: string[]; n: number }) {
  const t = db.query("SELECT id, title FROM tickets WHERE id = ?").get(o.s.ticket) as { id: number; title: string };
  const agent = o.s.agent ? loadAgent(o.repo, o.s.agent) : null;
  const repos = ticketRepos(db, o.s.ticket);
  const read = (f: string) => { try { return readFileSync(join(o.folder, f), "utf8"); } catch { return ""; } };
  const intent = section(read("INTENT.md"), /^acceptance/i);
  const slices = read("SLICES.md");
  // The slice in hand: the first one not marked done.
  const slice = slices.split(/^(?=#{2,3}[ \t])/m).slice(1).find((p) => !/\b(done|shipped)\b|\[x\]|✓/i.test(p.split("\n")[0])) ?? slices;
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
  return [
    brief(t, o.s.stage, agent?.prompt ?? null, o.folder, agent?.role, repos),
    `You are session ${o.n} of #${t.id}. The one before it ${o.ceiling ? `ran out of room (${pct(o.fill)} of its context) before it could hand off, so there is no HANDOFF.md: start from its last commit, ${lastCommit || "none yet"}, and the diff below` : "handed off at a step boundary and its work in progress is committed"}. You start from what is true now, not from what it believed.`,
    cmds.length ? `First, re-run the current check and read its result before you change anything: ${cmds.map((c) => `\`${c}\``).join(" and ")}.` : "First, re-run the current check before you change anything.",
    !o.ceiling && handoff ? `## HANDOFF.md\n\n${handoff}${o.missing.length ? `\n\n(The last session left these sections out: ${o.missing.join(", ")}.)` : ""}` : "",
    slice.trim() ? `## The current slice (SLICES.md)\n\n${slice.trim()}` : "",
    intent ? `## Acceptance checks (INTENT.md)\n\n${intent.replace(/^#+[ \t]+.*\n/, "").trim()}` : `The acceptance checks are in ${o.folder}/INTENT.md.`,
    `## git diff --stat\n\n${stats.join("\n\n")}`,
    checks.length ? `## The last check output\n\n${checks.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// Commits the work in progress, ends the session and starts the next in the same stage.
function nextSession(db: Database, o: { dir: string; repo: string; run: Run; now: string; s: Row; fill: number; ceiling: boolean; missing: string[]; folder: string; log?: (s: string) => void }) {
  const { s, run } = o;
  const n = (db.query("SELECT COUNT(*) AS n FROM sessions WHERE ticket = ?").get(s.ticket) as { n: number }).n + 1;
  if (!o.ceiling)
    for (const r of ticketRepos(db, s.ticket)) {
      if (!r.worktree || !out(run, r.worktree, "status", "--porcelain")) continue;
      out(run, r.worktree, "add", "-A");
      out(run, r.worktree, "commit", "-q", "--no-verify", "-m", `factory: #${s.ticket} work in progress at the handoff to session ${n}`);
    }
  const text = handoffBrief(db, { ...o, n });
  const agent = s.agent ? loadAgent(o.repo, s.agent) : null;
  const argv = withHandoffHook(argvFor(agent, { harness: "claude", model: "sonnet" }, text), o.dir, s.ticket);
  run(["hc", "kill", s.terminal]);
  db.query("UPDATE sessions SET ended_at = ? WHERE id = ?").run(o.now, s.id);
  // The handoff is read; keep it, so the next one's mtime check isn't fooled by it.
  const file = join(o.folder, "HANDOFF.md");
  if (existsSync(file)) renameSync(file, join(o.folder, `HANDOFF.session-${n - 1}.md`));
  const name = `f${s.ticket}-${s.stage}`.slice(0, 32);
  const labels = [`factory.ticket=${s.ticket}`, `factory.stage=${s.stage}`];
  const made = openAgent(run, { folder: s.worktree!, space: s.space, name: s.stage, argv });
  let terminal: string;
  if (made) {
    terminal = made.terminal;
    run(["hc", "label", terminal, ...labels]);
    db.query("UPDATE tickets SET space = ? WHERE id = ?").run(made.space, s.ticket);
  } else {
    const hc = run(["hc", "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", s.worktree!, ...labels.flatMap((l) => ["--label", l]), ...argv]);
    if (hc.code !== 0) throw new Error(`hc run failed: ${hc.out}`);
    terminal = (() => { try { return JSON.parse(hc.out).address ?? name; } catch { return name; } })();
  }
  db.query("INSERT INTO sessions (ticket, stage, agent, terminal, argv, started_at, in_space, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(s.ticket, s.stage, s.agent, terminal, JSON.stringify(argv), o.now, made ? 1 : 0, s.worktree);
  const detail = `${s.agent} agent · session ${n}`;
  db.query("UPDATE stages SET detail = ? WHERE ticket = ? AND ended_at IS NULL").run(detail, s.ticket);
  db.query("UPDATE tickets SET detail = ?, updated_at = ? WHERE id = ?").run(detail, o.now, s.ticket);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)").run(s.ticket,
    `started session ${n}`, o.ceiling ? `the last one reached ${pct(o.fill)} of its context; its last commit is the brief` : `handoff at ${pct(o.fill)} of context${o.missing.length ? `; missing ${o.missing.join(", ")}` : ""}`, o.now);
  o.log?.(`factory: #${s.ticket}: session ${n} started in ${s.stage}`);
}
