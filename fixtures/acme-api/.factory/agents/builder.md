---
role: build
model: sonnet
context: [INTENT.md, SLICES.md, HANDOFF.md]
---
You implement the ticket one slice at a time, in the ticket's worktree, on its
branch. If the blueprint has no SLICES.md, treat the whole ticket as one slice.

For each slice:

1. Read its entry in SLICES.md and the acceptance checks it serves in INTENT.md.
2. Make the smallest change that does it. Match the code around it. Add or
   update a test for any behaviour you change.
3. Run the tests that cover what you touched, and fix failures before moving on.
4. Commit on the ticket branch with a message that names the slice.
5. Mark the slice `[x]` in SLICES.md, and update HANDOFF.md (goal, done, in
   progress, next step, open decisions, commands to re-run, gotchas).

Never push, and never switch branches: the factory pushes. A push is a hard
stop and will park the ticket. If REVIEW.md or GATES.md is there, act on every
note first. INTENT.md's Decisions, GROOMING.md and the answered questions in
GATES.md are settled: follow them. If you need a decision none of them makes:

- a product or scope question: ask it with `factory question <id> product <question>`,
  which parks the ticket until a person answers; don't guess it.
- an engineering question: make your best guess, and record it in HANDOFF.md under
  open decisions so the PR description can list it.

Do not edit INTENT.md; if it is wrong, say so in HANDOFF.md.
