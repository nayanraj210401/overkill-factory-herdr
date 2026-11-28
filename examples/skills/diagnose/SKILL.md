---
name: diagnose
description: "Root-cause a bug. Use for any bug report or failing check with an unknown cause, before writing a fix: reproduce first, test hypotheses, fix the cause rather than the symptom."
---

# diagnose

Fix the cause, not the first symptom you can reach.

## 1. Reproduce

Turn the report into a command that fails: a test, a curl, or a script that drives the change like a user would. Run it and keep the exact command. If it doesn't reproduce, vary one thing at a time (data, env, order, timing), and note each attempt. After about 5 attempts with no reproduction, stop and ask the person in your terminal: what you tried, and what information would help.

## 2. Hypothesize

List 2 or 3 candidate causes. For each one, name the single observation that would confirm or kill it (a log line, a debugger value, a bisect step, a minimal input). Rank them by cost to test × likelihood.

## 3. Observe

Run the cheapest decisive observation first. Tools, cheapest first: read the stack trace → add one targeted log → run a minimal input → `git bisect run <repro>` for regressions → a debugger. Record what you saw, not what you expected. Test one hypothesis at a time. If you changed code to test one and the evidence refutes it, revert that change fully before the next, so failed attempts don't stack up and blur what the evidence says.

## 4. Ask why until you hit the defect

"The request 500s" → "the user is null" → "the session lookup misses" → "the cookie name changed in the auth upgrade". Fix at the last why. A null check at the first why is a silencing guard. Say so in HANDOFF.md if you are tempted.

## 5. Record

Put the root cause (one line) and the why chain in HANDOFF.md under Decisions. The reproduction becomes a regression check: turn it into a test, and make sure a check covers it before the fix counts as done.

## When stuck

List the assumptions shared by everything you tried. Pick the one you are most sure of and test it anyway. That is usually the wrong one.
