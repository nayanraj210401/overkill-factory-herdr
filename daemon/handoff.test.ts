import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { buildStatus } from "./status.ts";
import { sh, startTicket, type Run } from "./runner.ts";
import { transcriptDir, type Use } from "./usage.ts";
import { CEILING, contextFill, contextWindow, handoffAt, handoffStep, missingSections, watchContext } from "./handoff.ts";
import { flagFile, refusal, snapshotFile, snapshotOf, withHandoffHook } from "./handoff-hook.ts";
import { validateStatus } from "../lib/status.js";
import { matchBrief } from "./snap.ts";
import { recordArtifact } from "./artifacts.ts";

const use = (at: string, o: Partial<Use> = {}): Use => ({ id: at, at, model: "claude-sonnet-5-5", input: 0, w5m: 0, w1h: 0, read: 0, output: 0, ...o });

test("fill: the last message's input, cache reads and cache writes over the window", () => {
  const uses = [use("2026-11-21T10:00:00Z", { read: 150_000 }), use("2026-11-21T10:05:00Z", { input: 2_000, w5m: 8_000, w1h: 10_000, read: 100_000, output: 5_000 })];
  expect(contextFill(uses)).toBeCloseTo(0.6); // 120k of 200k; output isn't context yet
  expect(contextFill([])).toBeNull();
  // the argv's model keeps [1m], which the transcript's model id drops
  expect(contextFill(uses, ["sonnet[1m]"])).toBeCloseTo(0.12);
  expect(contextWindow("claude-opus-5-5")).toBe(200_000);
  expect(contextWindow("claude-opus-5-5[1m]")).toBe(1_000_000);
});

test("threshold: 60% by default or budget.handoff_at_context; flag once; 80% is a ceiling", () => {
  expect(handoffAt(undefined)).toBe(0.6);
  expect(handoffAt({ handoff_at_context: "50%" })).toBe(0.5);
  expect(handoffAt({ handoff_at_context: 0.7 })).toBe(0.7);
  expect(handoffAt({ handoff_at_context: "junk" })).toBe(0.6);
  expect(handoffStep(0.59, { at: 0.6, flagged: false })).toBe("none");
  expect(handoffStep(0.6, { at: 0.6, flagged: false })).toBe("flag");
  expect(handoffStep(0.7, { at: 0.6, flagged: true })).toBe("none"); // already asked
  expect(handoffStep(CEILING, { at: 0.6, flagged: true })).toBe("ceiling");
  expect(handoffStep(CEILING, { at: 0.6, flagged: false })).toBe("ceiling");
});

const FULL = `# Handoff

## Goal
Rate-limit login.

## Done
- the limiter

## In progress
auth.ts, check(), uncommitted

## Next step
wire the 429

## Open decisions
none

## Commands to re-run
bun test

## Gotchas
the clock is mocked
`;

test("HANDOFF.md needs all seven sections, each with something under it", () => {
  expect(missingSections(FULL)).toEqual([]);
  expect(missingSections(FULL.replace("## Gotchas\nthe clock is mocked\n", ""))).toEqual(["gotchas"]);
  expect(missingSections(FULL.replace("wire the 429", "").replace("## Done\n- the limiter", "## Done"))).toEqual(["done", "next step"]);
  expect(missingSections("just prose")).toHaveLength(7);
});

test("the hook refuses edits while flagged, but lets HANDOFF.md and reads through", () => {
  const flag = { message: "handoff requested: write HANDOFF.md now" };
  for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(refusal(flag, { tool_name, tool_input: { file_path: "/w/a.ts" } })).toBe(flag.message);
  expect(refusal(flag, { tool_name: "Write", tool_input: { file_path: "/f/tickets/412/HANDOFF.md" } })).toBeNull();
  expect(refusal(flag, { tool_name: "Read", tool_input: { file_path: "/w/a.ts" } })).toBeNull();
  expect(refusal(flag, { tool_name: "Bash" })).toBeNull();
  expect(refusal(null, { tool_name: "Edit", tool_input: { file_path: "/w/a.ts" } })).toBeNull();
});

test("the hook script, as Claude Code runs it from the settings file: exit 2 only while the flag exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(dir, "tickets/412"), { recursive: true });
  const argv = withHandoffHook(["claude", "--model", "sonnet", "go"], dir, 412);
  expect(argv.slice(0, 4)).toEqual(["claude", "--permission-mode", "auto", "--settings"]);
  expect(argv.slice(5)).toEqual(["--model", "sonnet", "go"]);
  const hook = JSON.parse(readFileSync(argv[4], "utf8")).hooks.PreToolUse[0];
  expect(hook.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
  const command = hook.hooks[0].command;
  const call = (tool: string) => Bun.spawnSync(["sh", "-c", command], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: tool, tool_input: { file_path: "/w/a.ts" } })) });
  expect(call("Edit").exitCode).toBe(0);
  writeFileSync(flagFile(dir, 412), JSON.stringify({ session: 1, message: "handoff requested: write HANDOFF.md now" }));
  const r = call("Edit");
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("handoff requested: write HANDOFF.md now");
  expect(call("Read").exitCode).toBe(0);
  // a new session starts clean, and a program other than Claude gets no hook
  expect(withHandoffHook(["echo", "hi"], dir, 412)).toEqual(["echo", "hi"]);
  expect(existsSync(flagFile(dir, 412))).toBe(false);
});

test("the session may work in its ticket folder, repos and worktrees, and starts in auto mode without its consent dialog", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const argv = withHandoffHook(["claude", "go"], dir, 5, null, [], ["/f/tickets/5", "/r/api", "", "/r/api", "/w/api"]);
  const settings = JSON.parse(readFileSync(argv[4], "utf8"));
  expect(settings.permissions.additionalDirectories).toEqual(["/f/tickets/5", "/r/api", "/w/api"]);
  // registering the repo is the consent: Claude Code's one-time auto mode dialog is skipped
  expect(settings.skipAutoPermissionPrompt).toBe(true);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/agents/spec-writer.md"), "---\nrole: spec\nharness: claude\nmodel: sonnet\n---\nWrite INTENT.md.\n");
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const calls: string[][] = [];
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: `{"address":"t${10 + calls.length}","state":"live"}` }) : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (412, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  startTicket(db, { dir, repo, id: 412, run, now: "2026-11-21T10:00:00Z" });
  const wt = (db.query("SELECT worktree FROM ticket_lead WHERE id = 412").get() as any).worktree as string;
  const folder = join(dir, "tickets/412");
  mkdirSync(folder, { recursive: true });
  // The session's transcript: its last message had `used` tokens in context.
  const fill = (used: number, at = "2026-11-21T10:30:00Z") => {
    mkdirSync(transcriptDir(wt), { recursive: true });
    writeFileSync(join(transcriptDir(wt), "s1.jsonl"), JSON.stringify({ type: "assistant", timestamp: at, message: { id: `m${used}`, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: used - 10, output_tokens: 5 } } }) + "\n");
  };
  const tick = (now: string) => watchContext(db, { dir, repo, run, now });
  return { dir, db, repo, run, calls, wt, folder, fill, tick };
}

test("below the threshold nothing happens; at 60% the session is flagged once and told", () => {
  const { dir, db, calls, fill, tick } = setup();
  fill(100_000); // 50%
  tick("2026-11-21T10:31:00Z");
  expect(existsSync(flagFile(dir, 412))).toBe(false);
  fill(125_000); // 62.5%
  const before = calls.length;
  tick("2026-11-21T10:32:00Z");
  expect(JSON.parse(readFileSync(flagFile(dir, 412), "utf8"))).toMatchObject({ session: 1, message: "handoff requested: write HANDOFF.md now" });
  const send = calls.slice(before).find((c) => c[1] === "send")!;
  expect(send.slice(0, 4)).toEqual(["hc", "send", "--if", "idle"]);
  expect(send.at(-1)).toContain("write HANDOFF.md now");
  expect((db.query("SELECT detail FROM stages WHERE ended_at IS NULL").get() as any).detail).toBe("handoff at 60%");
  tick("2026-11-21T10:33:00Z"); // flagged already: no second ask, no early hand-off
  expect(calls.slice(before).filter((c) => c[1] === "send")).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
});

test("a complete HANDOFF.md: work committed, session ended, the next one starts in the same stage with a fixed brief", () => {
  const { dir, db, calls, wt, folder, fill, tick } = setup();
  writeFileSync(join(folder, "INTENT.md"), "# Intent\n\n## Goal\nLimit logins.\n\n## Acceptance checks\n- 6th attempt in a minute gets a 429\n");
  writeFileSync(join(folder, "SLICES.md"), "# Slices\n\n## 1. The limiter (done)\nx\n\n## 2. The 429 response\nreturn it from login\n");
  db.query("INSERT INTO evidence (ticket, check_name, result, detail, at) VALUES (412, 'bun test', 'FAIL', 'exit 1: 2 failing', '2026-11-21T10:20:00Z')").run();
  fill(125_000);
  tick("2026-11-21T10:32:00Z");
  writeFileSync(join(wt, "limiter.ts"), "export const x = 1;\n"); // work in progress
  tick("2026-11-21T10:33:00Z");
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 }); // no HANDOFF.md yet
  // an incomplete one: asked once more, in the terminal; the hook's message names what is missing
  writeFileSync(join(folder, "HANDOFF.md"), FULL.replace("## Gotchas\nthe clock is mocked\n", ""));
  const before = calls.length;
  tick("2026-11-21T10:34:00Z");
  expect(calls.slice(before).find((c) => c[1] === "send")!.at(-1)).toContain("missing: gotchas");
  expect(JSON.parse(readFileSync(flagFile(dir, 412), "utf8")).message).toContain("missing: gotchas");
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  writeFileSync(join(folder, "HANDOFF.md"), FULL);
  tick("2026-11-21T10:35:00Z");
  const sessions = db.query("SELECT id, stage, agent, ended_at, cwd FROM sessions ORDER BY id").all() as any[];
  expect(sessions).toHaveLength(2);
  expect(sessions[0].ended_at).toBe("2026-11-21T10:35:00Z");
  expect(sessions[1]).toMatchObject({ stage: "spec", agent: "spec-writer", ended_at: null, cwd: wt });
  expect(calls.some((c) => c[1] === "kill" && c[2] === "t11")).toBe(true);
  const run = calls.findLast((c) => c[1] === "run")!;
  expect(run[run.indexOf("--cwd") + 1]).toBe(wt);
  const brief = run.at(-1)!;
  expect(run).toContain("--settings");
  expect(brief).toContain("You are session 2 of #412");
  expect(brief.indexOf("re-run the current check")).toBeLessThan(brief.indexOf("## HANDOFF.md"));
  expect(brief).toContain("`npm test` and `npm run typecheck`"); // the repo's quality_floor
  expect(brief).toContain("wire the 429"); // HANDOFF.md
  expect(brief).toContain("## The current slice");
  expect(brief).toContain("The 429 response"); // not the finished slice 1
  expect(brief).not.toContain("1. The limiter");
  expect(brief).toContain("6th attempt in a minute gets a 429");
  expect(brief).toMatch(/limiter\.ts \| 1 \+/); // git diff --stat
  expect(brief).toContain("bun test: FAIL (exit 1: 2 failing)");
  matchBrief("handoffFull", brief.split(folder).join("<folder>")); // the text the code built before it was a template
  // the work in progress is on the ticket branch; the flag is gone; the old handoff is kept apart
  expect(sh(["git", "-C", wt, "log", "-1", "--format=%s"]).out).toContain("work in progress at the handoff to session 2");
  expect(sh(["git", "-C", wt, "status", "--porcelain"]).out).toBe("");
  expect(existsSync(flagFile(dir, 412))).toBe(false);
  expect(existsSync(join(folder, "HANDOFF.md"))).toBe(false);
  // what you see
  const t = buildStatus(db).tickets[0];
  expect(t.session).toBe(2);
  expect(t.detail).toBe("spec-writer agent · session 2");
  expect(validateStatus(buildStatus(db))).toEqual([]);
  // the new session starts below the line: the transcript has only the old one's messages
  tick("2026-11-21T10:36:00Z");
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
});

test("at the 80% ceiling the session is stopped without a handoff and the brief comes from its last commit", () => {
  const { db, calls, wt, folder, fill, tick } = setup();
  writeFileSync(join(wt, "half.ts"), "export const half = 1;\n"); // never committed
  fill(170_000); // 85%, never flagged
  tick("2026-11-21T10:40:00Z");
  expect(calls.some((c) => c[1] === "kill" && c[2] === "t11")).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
  const brief = calls.findLast((c) => c[1] === "run")!.at(-1)!;
  expect(brief).toContain("ran out of room (85% of its context)");
  expect(brief).toMatch(/last commit, [0-9a-f]+ init/);
  expect(brief).toMatch(/not committed:\n\?\? half\.ts/); // still on disk, and the brief says so
  expect(brief).not.toContain("## HANDOFF.md");
  matchBrief("handoffCeiling", brief.split(folder).join("<folder>").replace(/last commit, [0-9a-f]+ init/, "last commit, <sha> init"));
  expect(sh(["git", "-C", wt, "log", "-1", "--format=%s"]).out).toBe("init"); // nothing committed for it
  expect(existsSync(folder)).toBe(true);
});

test("a session building one slice (per: slice) hands that slice on, even one SLICES.md marks done", () => {
  const { db, calls, folder, fill, tick } = setup();
  writeFileSync(join(folder, "SLICES.md"), "# Slices\n\n## 1. The limiter (done)\nx\n\n## 2. The 429 response\ny\n");
  db.query("UPDATE sessions SET slice = '#1'").run();
  fill(170_000);
  tick("2026-11-21T10:40:00Z");
  const brief = calls.findLast((c) => c[1] === "run")!.at(-1)!;
  expect(brief.slice(brief.indexOf("## The current slice"))).toContain("1. The limiter");
  expect(db.query("SELECT slice FROM sessions ORDER BY id").all()).toEqual([{ slice: "#1" }, { slice: "#1" }]);
});

test("the handoff threshold is the one the ticket started with: 80% in its snapshot means 62% doesn't flag it", () => {
  const { dir, db, fill, tick } = setup();
  db.query("UPDATE tickets SET settings = ? WHERE id = 412").run('{"budget.handoff_at_context":"80%"}');
  fill(125_000); // 62.5%: over the file's 60%, under the ticket's 80%
  tick("2026-11-21T10:32:00Z");
  expect(existsSync(flagFile(dir, 412))).toBe(false);
});

test("an agent runs unattended: auto mode, and an allowlist with the factory CLI and the repo's tests, never git push", () => {
  const dir = mkdtempSync(join(tmpdir(), "allow-"));
  const argv = withHandoffHook(["claude", "go"], dir, 9, null, ["bun test"]);
  expect(argv.slice(0, 3)).toEqual(["claude", "--permission-mode", "auto"]);
  const allow: string[] = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1], "utf8")).permissions.allow;
  for (const a of ["Bash(factory:*)", "Bash(bun test)", "Bash(git commit:*)", "Bash(gh issue view:*)", "Read", "Edit"]) expect(allow).toContain(a);
  expect(allow.some((a) => /push|bypass/.test(a))).toBe(false);
});

// A transcript as Claude Code writes it: assistant messages with text and tool calls.
const TRANSCRIPT = [
  { type: "user", message: { content: "go" } },
  { type: "assistant", message: { content: [{ type: "text", text: "Adding the limiter." }, { type: "tool_use", name: "Edit", input: { file_path: "/w/src/limiter.ts" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/w/src/login.ts" } }, { type: "tool_use", name: "Write", input: { file_path: "/w/src/login.ts" } }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Next: return 429 from login." }] } },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("the PreCompact snapshot: the files the last edits touched, newest first, and the last words", () => {
  const md = snapshotOf(TRANSCRIPT + "not json\n", "auto", "2026-11-21T10:40:00Z");
  expect(md).toContain("## Files it was changing\n\n- /w/src/login.ts\n- /w/src/limiter.ts\n");
  expect(md).toContain("Adding the limiter.\n\n---\n\nNext: return 429 from login.");
  expect(snapshotOf("", "manual", "x")).toContain("## Files it was changing\n\nnone");
});

test("the PreCompact hook, as Claude Code runs it from the settings file, writes the snapshot and never blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const argv = withHandoffHook(["claude", "go"], dir, 412);
  const command = JSON.parse(readFileSync(argv[4], "utf8")).hooks.PreCompact[0].hooks[0].command;
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, TRANSCRIPT);
  const call = (input: string) => Bun.spawnSync(["sh", "-c", command], { stdin: new TextEncoder().encode(input), env: process.env });
  expect(call("garbage").exitCode).toBe(0);
  expect(existsSync(snapshotFile(dir, 412))).toBe(false);
  expect(call(JSON.stringify({ hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript })).exitCode).toBe(0);
  expect(readFileSync(snapshotFile(dir, 412), "utf8")).toContain("compact this session's context (auto)");
  withHandoffHook(["claude", "go"], dir, 412); // a new session starts with no snapshot
  expect(existsSync(snapshotFile(dir, 412))).toBe(false);
});

test("a session Claude Code starts compacting below the ceiling is stopped, and its snapshot goes into the next brief", () => {
  const { dir, db, calls, folder, fill, tick } = setup();
  fill(90_000); // 45%: the transcript says nothing is wrong
  writeFileSync(snapshotFile(dir, 412), snapshotOf(TRANSCRIPT, "auto", "2026-11-21T10:39:00Z"));
  tick("2026-11-21T10:40:00Z");
  expect(calls.some((c) => c[1] === "kill" && c[2] === "t11")).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL").get()).toEqual({ n: 1 });
  const brief = calls.findLast((c) => c[1] === "run")!.at(-1)!;
  expect(brief).toContain("Claude Code began compacting its context");
  expect(brief).toMatch(/last commit, [0-9a-f]+ init/);
  expect(brief).toContain("## Before it ran out of room (its PreCompact snapshot)");
  expect(brief).toContain("- /w/src/login.ts");
  expect(existsSync(snapshotFile(dir, 412))).toBe(false); // read, and kept beside the session's handoffs
  expect(readFileSync(join(folder, "PRECOMPACT.session-1.md"), "utf8")).toContain("Next: return 429 from login.");
  expect((db.query("SELECT why FROM decisions WHERE what = 'started session 2'").get() as any).why).toContain("PreCompact snapshot");
  tick("2026-11-21T10:41:00Z"); // the new session isn't stopped again
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
});

test("with sharing on, the next session gets the links and republishes the handoff it starts from to HANDOFF.md's link", () => {
  const { db, repo, calls, folder, fill, tick } = setup();
  writeFileSync(join(repo, ".factory/factory.yaml"), readFileSync(join(repo, ".factory/factory.yaml"), "utf8") + "artifacts: { as: artifact }\n");
  const url = "https://claude.ai/code/artifact/0b6c9e1a-0000-4000-8000-0000000000aa";
  recordArtifact(db, { id: 412, file: "HANDOFF.md", url, now: "2026-11-21T10:01:00Z" });
  fill(125_000);
  tick("2026-11-21T10:32:00Z");
  writeFileSync(join(folder, "HANDOFF.md"), FULL);
  tick("2026-11-21T10:35:00Z");
  const run = calls.findLast((c) => c[1] === "run")!;
  const brief = run.at(-1)!;
  expect(brief).toContain(`Shared copies on claude.ai, for sessions that can't see ${folder}: HANDOFF.md ${url}.`);
  expect(brief).toContain(`After the check, before you change anything, share the handoff you start from on claude.ai as the ticket's HANDOFF.md, so cloud sessions read it by link: publish ${folder}/HANDOFF.session-1.md with your Artifact tool: action publish, file_path ${folder}/HANDOFF.session-1.md, url ${url}, so the link stays the same`);
  expect(brief.indexOf("re-run the current check")).toBeLessThan(brief.indexOf("After the check, before you change anything"));
  expect(existsSync(join(folder, "HANDOFF.session-1.md"))).toBe(true); // the file it names is there
  expect(JSON.parse(readFileSync(run[run.indexOf("--settings") + 1], "utf8")).permissions.allow).toContain("Artifact");
});
