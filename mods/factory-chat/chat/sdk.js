// Vendored from herdr-chat (MIT, github.com/naruse/herdr-chat @ 05ef3ed, mods/chat/sdk.js).
// Changed for the factory: only what the side chat uses (control, sessionOf, askSide); the
// command list, sessions list and Codex's app-server are gone.
// Asks Claude Code things the way the Claude app does: a short-lived
// `claude -p` in stream-json mode, sent control requests, read for their
// answers. With a session id it works on a read-only fork of that session,
// so the agent in the terminal is never touched or interrupted.
import { exec } from "herdr";

// Sends each request in argv[3] (a JSON array) and prints the answers, plus
// the newest command list Claude announced: it adds plugins' and MCP servers'
// commands a moment after starting, so with settle > 0 it waits that long for them.
const PY = `
import json, subprocess, sys, threading, time, select
folder, sid, reqs, timeout, settle, delay = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]
if sid: args += ["--resume", sid, "--fork-session"]
p = subprocess.Popen(args, cwd=folder or None, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
threading.Timer(timeout, p.kill).start()
time.sleep(delay)
for i, r in enumerate(reqs):
    p.stdin.write(json.dumps({"type": "control_request", "request_id": "r%d" % i, "request": r}) + "\\n")
p.stdin.flush()
out = [None] * len(reqs)
commands, done = None, None
while True:
    if done is not None:
        left = done + settle - time.time()
        if left <= 0 or not select.select([p.stdout], [], [], left)[0]: break
    line = p.stdout.readline()
    if not line: break
    try: d = json.loads(line)
    except ValueError: continue
    if d.get("type") == "system" and d.get("subtype") == "commands_changed": commands = d.get("commands")
    if d.get("type") != "control_response": continue
    r = d.get("response", {}); i = int(str(r.get("request_id", "r-1"))[1:] or -1)
    if 0 <= i < len(out): out[i] = r.get("response") if r.get("subtype") == "success" else {"error": r.get("error", "failed")}
    if done is None and all(x is not None for x in out):
        done = time.time()
        if settle <= 0: break
print(json.dumps({"out": out, "commands": commands})); sys.stdout.flush()
try: p.stdin.close()
except Exception: pass
p.kill()
import os; os._exit(0)
`;

export async function control(folder, session, requests, { on = null, timeout = 45, settle = 0, delay = 0, withCommands = false } = {}) {
  const r = await exec("python3", ["-c", PY, folder ?? "", session ?? "", JSON.stringify(requests), String(timeout), String(settle), String(delay)], { on });
  let res;
  try { res = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { res = { out: requests.map(() => ({ error: r.stderr.trim() || "no answer" })), commands: null }; }
  return withCommands ? res : res.out;
}

// The session a Claude log belongs to: its file name.
export const sessionOf = (file) => /([0-9a-f-]{36})\.jsonl$/.exec(file ?? "")?.[1] ?? null;

// A side question about the session, with the earlier ones in this side chat.
export async function askSide(folder, session, question, history, on) {
  const req = { subtype: "side_question", question, ...(history.length ? { history } : {}) };
  const [a] = await control(folder, session, [req], { on, timeout: 60 });
  if (!a || a.error) return { error: a?.error ?? "No answer" };
  if (a.response == null || a.synthetic) return { error: "No answer available for this side question. Try again." };
  return { text: a.response };
}
