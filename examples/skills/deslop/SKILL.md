---
name: deslop
description: "Remove code slop from a diff: narrating and history comments, dead code, defensive clutter, casts and suppressions, needless abstraction, duplicate helpers. Use before the PR stage, or when asked to clean a change up."
---

# deslop

Scope: only the lines this ticket changed (`git diff <base>` plus uncommitted changes). Don't reformat the world.

## Cut

- **Narrating comments**: `// increment counter`, `// loop over users`, and comments that restate the next line or the commit message. Keep comments that explain a *why* the code can't show (an external constraint, a non-obvious invariant, a link to an issue).
- **Defensive clutter**: null checks on values the type system or a validated boundary already guarantees; try/catch that only logs and rethrows; `|| {}` fallbacks masking bugs. Guards belong at system boundaries (HTTP, config, external APIs, user input); internal code trusts its types.
- **Needless abstraction**: one-caller wrappers, interfaces with one implementation, config for things that never vary, factories that build one thing.
- **Reinvention**: new helpers that duplicate existing ones. Search the repo for the verb and noun before accepting a new util.
- **Leftovers**: debug prints, commented-out code, unused imports, variables, and params, TODOs with no owner (record them in HANDOFF.md under Open items).
- **Over-handling**: catching errors that can't happen, retry loops nobody asked for, logs at every line.
- **Comments standing in for structure**: history ("previously this…", "X said never do this"), "keep in sync with …", "do not remove", "IMPORTANT". Encode the constraint (derive the type, add a test or lint), or delete the comment and report the constraint as open. A paragraph defending a workaround means the code is wrong: fix the code.
- **Silenced compiler**: `as`/`any` casts, `!`, `@ts-ignore`, `eslint-disable`, `# type: ignore`. Parse at the boundary instead. A suppression stays only when the rule is wrong for that line, with the reason on it.
- **Loose shapes**: optional-field bags and booleans that must agree where one discriminated union would do; a `switch` with no exhaustive default.
- **Nesting**: three levels deep where early returns would read flat.
- **Fixed sleeps** in scripts and tests (`sleep 2`): poll for the condition with a timeout.
- **Half migrations**: an old function kept beside its replacement. Move every caller and delete the old one in the same change.
- **Style drift**: anything against the conventions the surrounding code already follows.

## Method

1. List the findings as `file:line · type · fix`.
2. Apply fixes that don't change behavior directly.
3. Re-run the checks that covered the slice (the commands from your brief). Deslop must not change behavior. If a check fails, revert that fix.
4. Report the count: `deslop: −47 lines (12 comments, 3 wrappers, 1 duplicate helper → utils/date.ts:12)`.

If the same slop pattern shows up across tickets, record it in HANDOFF.md under Open items; it may deserve a lint rule rather than prose.
