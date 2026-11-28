---
name: seal
description: "Lock acceptance checks so they cannot be weakened to get a pass. Use once the ticket's checks are settled, and verify before presenting work as done."
---

# seal: the goalposts don't move

Agents under pressure to pass make checks easier: they loosen an assertion, special-case an input, or skip a test. Sealing makes that impossible to do silently.

```bash
scripts/seal.sh add <path>…    # after the checks are settled
scripts/seal.sh verify         # before presenting work as done; non-zero exit = tampering
scripts/seal.sh list
```

The hashes go to `SEALS` in the ticket folder (set `FACTORY_TICKET_DIR` from your brief, or `SEALS` directly), never into the repo. Seal the files that hold the checks: test files, the checks section of INTENT.md, a driver script.

## What sealing means here

- The factory has no mid-work hooks, so nothing interrupts an edit. Instead, `verify` runs before the stage counts as done: the checker runs it blind, and a ready rule can refuse a PR whose seals don't hold.
- A `CHANGED` or `MISSING` line is not for you to fix by resealing. It means the check moved after the ticket started: say so to the person in your terminal — what changed, and whether the check or the code should give — and record it in HANDOFF.md under Decisions.
- `reseal` is only for after an approved change to a check. Never run it on your own to make a pass.

## When a sealed check really is wrong

It happens: the check itself has a bug, or the requirement changed. Then:
1. Say so in one message to the person: what is wrong with the check, the proposed change, and why the code shouldn't change instead.
2. After they answer, edit it, run `seal.sh reseal`, and record the decision in HANDOFF.md.
3. If the check came from a ticket criterion, say which line of INTENT.md changed so the ticket's author can be told.
