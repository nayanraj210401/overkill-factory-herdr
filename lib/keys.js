// What a bare key does on a factory page while the page has focus. Pure, so it's
// tested; the mods turn "soon" into a toast until the milestone builds the action.

export const ACTIONS = {
  p: { label: "Pause or resume", milestone: "M2" },
  d: { label: "Diff in Changes", milestone: "M2" },
  "shift-c": { label: "Move to cloud", milestone: "M3" },
  "shift-l": { label: "Bring back to local", milestone: "M3" },
};

// e: gpui's KeyEvent ({key, modifiers}). Chords with cmd/ctrl/alt belong to keys.json.
export function keyAction(e) {
  const mod = e.modifiers ?? {};
  if (mod.platform || mod.control || mod.alt || mod.function) return null;
  const name = (mod.shift ? "shift-" : "") + e.key;
  if (name === "j" || name === "down") return { kind: "move", delta: 1 };
  if (name === "k" || name === "up") return { kind: "move", delta: -1 };
  if (name === "enter") return { kind: "open" };
  if (name === "e") return { kind: "terminal" };
  if (name === "n") return { kind: "new" };
  if (name === "m") return { kind: "merge" };
  if (name === "b") return { kind: "budget" };
  if (name === "x") return { kind: "send-back" };
  if (name === "u") return { kind: "answer" };
  const a = ACTIONS[name];
  return a ? { kind: "soon", ...a } : null;
}

export const clamp = (i, n) => (n ? Math.max(0, Math.min(n - 1, i)) : 0);
