// Claude Code's PreToolUse hook for the context handoff. While the daemon's flag file
// exists, the next edit is refused so the session writes HANDOFF.md instead; the
// session never stops mid-edit, because a call already running finishes. Kept apart
// from every other hook the factory adds: it is its own script and settings entry.
//   bun handoff-hook.ts <flag file>     (the hook's JSON arrives on stdin)
// It is also the PreCompact backstop: Claude Code is about to compact a session's context,
// so the session is full and never handed off. The hook writes what the transcript still
// holds (its last words, the files it was changing) to PRECOMPACT.md; the daemon then stops
// the session and starts the next one from its last commit and that snapshot (handoff.ts).
//   bun handoff-hook.ts --precompact <snapshot file>
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { planStatusLine } from "./planline.ts";
import { agentAllow } from "./allow.ts";

export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export const flagFile = (dir: string, id: number) => join(dir, "tickets", String(id), "handoff.json");
export const snapshotFile = (dir: string, id: number) => join(dir, "tickets", String(id), "PRECOMPACT.md");

// The snapshot: the session's last few things said, and the files its last edits touched.
export function snapshotOf(transcript: string, trigger: string, now: string) {
  const said: string[] = [];
  const files: string[] = [];
  for (const line of transcript.split("\n")) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type === "text" && c.text?.trim()) said.push(c.text.trim());
      const f = c?.type === "tool_use" && EDIT_TOOLS.includes(c.name) ? c.input?.file_path ?? c.input?.notebook_path : null;
      if (f) files.push(f);
    }
  }
  const touched = [...new Set(files.reverse())].slice(0, 12);
  return [
    `# PreCompact snapshot`,
    ``,
    `Claude Code was about to compact this session's context (${trigger}) at ${now}.`,
    ``,
    `## Files it was changing`,
    ``,
    touched.length ? touched.map((f) => `- ${f}`).join("\n") : "none",
    ``,
    `## Its last words`,
    ``,
    said.slice(-3).map((t) => t.slice(0, 1500)).join("\n\n---\n\n") || "nothing",
    ``,
  ].join("\n");
}

// null lets the call through; text refuses it. HANDOFF.md itself is the one edit allowed.
export function refusal(flag: { message?: string } | null, input: { tool_name?: string; tool_input?: { file_path?: string; notebook_path?: string } }) {
  if (!flag || !EDIT_TOOLS.includes(input.tool_name ?? "")) return null;
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "";
  if (basename(file) === "HANDOFF.md") return null;
  return flag.message ?? "handoff requested: write HANDOFF.md now";
}

// The argv of a Claude session, with the hook added through its own settings file in
// the ticket's folder. Also clears a flag left by an earlier session: a new session
// starts clean. Other programs have no such hook and run as they are. `also` is another
// settings JSON (the hard-stop guard's) whose hooks go in the same file, since Claude Code
// reads only one --settings. The session runs in Claude Code's auto mode plus agentAllow(commands)
// (allow.ts): safe actions run on their own and risky ones are refused, so nothing waits at a
// permission prompt. Questions for the person are asked in the terminal (the daemon flags them).
// `dirs` are the folders the session works in besides its own (the ticket folder, the repos and
// worktrees): Claude Code asks before touching a folder outside its working directories, even in
// auto mode, so they go in additionalDirectories.
// `allow`: tools beyond agentAllow, such as Artifact when the factory shares plans (artifacts.ts).
export function withHandoffHook(argv: string[], dir: string, id: number, also?: string | null, commands: string[] = [], dirs: string[] = [], allow: string[] = []) {
  const flag = flagFile(dir, id);
  for (const f of [flag, snapshotFile(dir, id)]) if (existsSync(f)) unlinkSync(f);
  if (argv[0] !== "claude") return argv;
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const settings = join(dirname(flag), "handoff-settings.json");
  mkdirSync(dirname(flag), { recursive: true });
  const hook = `${quote(process.execPath)} ${quote(import.meta.path)}`;
  const ours = { matcher: EDIT_TOOLS.join("|"), hooks: [{ type: "command", command: `${hook} ${quote(flag)}` }] };
  const precompact = { hooks: [{ type: "command", command: `${hook} --precompact ${quote(snapshotFile(dir, id))}` }] };
  const others = also ? JSON.parse(also).hooks?.PreToolUse ?? [] : [];
  // The status line saves Claude Code's plan-usage reading for the plan meters (planline.ts).
  const statusLine = planStatusLine();
  // skipAutoPermissionPrompt: registering a repo with the factory is the consent to auto mode, so
  // Claude Code's one-time "Enable auto mode?" dialog never holds up an agent.
  writeFileSync(settings, JSON.stringify({ skipAutoPermissionPrompt: true, permissions: { allow: [...agentAllow(commands), ...allow], additionalDirectories: [...new Set(dirs.filter(Boolean))] }, hooks: { PreToolUse: [...others, ours], PreCompact: [precompact] }, statusLine }, null, 2) + "\n");
  return ["claude", "--permission-mode", "auto", "--settings", settings, ...argv.slice(1)];
}

if (import.meta.main && process.argv[2] === "--precompact") {
  // Never in the way: a snapshot that can't be written still lets the compaction run.
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const transcript = input.transcript_path && existsSync(input.transcript_path) ? readFileSync(input.transcript_path, "utf8") : "";
    writeFileSync(process.argv[3], snapshotOf(transcript, input.trigger ?? "auto", new Date().toISOString()));
  } catch {}
} else if (import.meta.main) {
  let flag: { message?: string } | null = null;
  try { flag = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch {}
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const why = refusal(flag, input);
  if (why) { console.error(why); process.exit(2); } // exit 2 blocks the call and shows the session this text
}
