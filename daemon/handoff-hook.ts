// Claude Code's PreToolUse hook for the context handoff. While the daemon's flag file
// exists, the next edit is refused so the session writes HANDOFF.md instead; the
// session never stops mid-edit, because a call already running finishes. Kept apart
// from every other hook the factory adds: it is its own script and settings entry.
//   bun handoff-hook.ts <flag file>     (the hook's JSON arrives on stdin)
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { planFile } from "./planline.ts";

export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export const flagFile = (dir: string, id: number) => join(dir, "tickets", String(id), "handoff.json");

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
// reads only one --settings.
export function withHandoffHook(argv: string[], dir: string, id: number, also?: string | null) {
  const flag = flagFile(dir, id);
  if (existsSync(flag)) unlinkSync(flag);
  if (argv[0] !== "claude") return argv;
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const settings = join(dirname(flag), "handoff-settings.json");
  mkdirSync(dirname(flag), { recursive: true });
  const ours = { matcher: EDIT_TOOLS.join("|"), hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(import.meta.path)} ${quote(flag)}` }] };
  const others = also ? JSON.parse(also).hooks?.PreToolUse ?? [] : [];
  // The status line saves Claude Code's plan-usage reading for the plan meters (planline.ts).
  const statusLine = { type: "command", command: `${quote(process.execPath)} ${quote(join(dirname(import.meta.path), "planline.ts"))} ${quote(planFile())}` };
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [...others, ours] }, statusLine }, null, 2) + "\n");
  return ["claude", "--settings", settings, ...argv.slice(1)];
}

if (import.meta.main) {
  let flag: { message?: string } | null = null;
  try { flag = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch {}
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const why = refusal(flag, input);
  if (why) { console.error(why); process.exit(2); } // exit 2 blocks the call and shows the session this text
}
