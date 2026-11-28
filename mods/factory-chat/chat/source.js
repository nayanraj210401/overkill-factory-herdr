// Vendored from herdr-chat (MIT, github.com/naruse/herdr-chat @ 05ef3ed, mods/chat/source.js).
// Changed for the factory: only the log reader. The factory knows each session's transcript
// (its sessions rows), so finding the log from the terminal's process, and Codex, are gone.
import { exec } from "herdr";
import { Buffer } from "buffer";

// Start this far from the end of a long log; earlier history is skipped.
const TAIL_BYTES = 4 * 1024 * 1024;

const sh = (script, args, on) => exec("sh", ["-c", script, "sh", ...args], { on });

// Reads complete new lines from `file` since the last call.
export class Tail {
  constructor(file, on) {
    this.file = file;
    this.on = on;
    this.offset = null;
  }

  async read() {
    let skipFirst = false;
    if (this.offset === null) {
      const r = await sh('wc -c < "$1"', [this.file], this.on);
      const size = parseInt(r.stdout.trim(), 10) || 0;
      this.offset = Math.max(0, size - TAIL_BYTES);
      skipFirst = this.offset > 0;
      this.truncated = skipFirst;
    }
    const r = await exec("tail", ["-c", `+${this.offset + 1}`, this.file], { on: this.on });
    // Not written yet (a session that opened idle logs nothing before its first message): empty for now.
    if (r.code !== 0 && /No such file/i.test(r.stderr)) { this.offset = null; return []; }
    if (r.code !== 0) throw new Error(r.stderr.trim() || "can't read the session log");
    const s = r.stdout;
    const cut = s.lastIndexOf("\n");
    if (cut < 0) return [];
    const chunk = s.slice(0, cut + 1);
    this.offset += Buffer.from(chunk, "utf8").length;
    const lines = chunk.split("\n").filter(Boolean);
    if (skipFirst) lines.shift();
    return lines;
  }
}
