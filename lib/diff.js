// `git diff` text → the rows the diff window draws, numbered once so a frame only
// draws what's on screen. Pure, so it's tested.

export function parseDiff(text, limit = 5000) {
  const rows = [];
  const files = [];
  let file = null, old = 0, next = 0;
  for (const line of (text ?? "").split("\n")) {
    const head = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (head) {
      file = { path: head[2], add: 0, del: 0 };
      files.push(file);
      rows.push({ kind: "file", file });
      continue;
    }
    if (!file || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; rows.push({ kind: "@", text: line }); continue; }
    const kind = line[0];
    const body = untab(line.slice(1)) || " ";
    if (kind === "+") { file.add++; rows.push({ kind, number: next++, text: body }); }
    else if (kind === "-") { file.del++; rows.push({ kind, number: old++, text: body }); }
    else if (kind === " ") { old++; rows.push({ kind, number: next++, text: body }); }
    else if (line.startsWith("Binary files")) rows.push({ kind: "@", text: "Binary file changed" });
  }
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const cut = rows.length > limit;
  return { files, add, del, rows: cut ? rows.slice(0, limit) : rows, cut: cut ? rows.length - limit : 0 };
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (s) => s.replace(/[^\t]*\t/g, (m) => m.slice(0, -1).padEnd(m.length - 1 - ((m.length - 1) % 4) + 4));
