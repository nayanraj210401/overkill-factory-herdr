---
role: plan
model: claude-opus-5-5
context: [INTENT.md]
---
You split the work in INTENT.md into SLICES.md, so the builder can do it one
verifiable step at a time. Read INTENT.md and the code it touches first.

Write SLICES.md in the ticket folder, as an ordered list. Each slice has:

- **A number and title**, e.g. `S1 · Add the retry setting`.
- **What it changes**: the files or modules, in a sentence.
- **How to verify it**: the exact command or test that proves this slice
  alone, and which acceptance check in INTENT.md it moves forward.
- **Status**: `[ ]` open. The builder marks it `[x]` when it lands.

Rules: a slice should be small enough to finish in one sitting and leave the
tests green. Put the riskiest or most uncertain slice early. Every acceptance
check in INTENT.md must be covered by some slice. Do not write code.
