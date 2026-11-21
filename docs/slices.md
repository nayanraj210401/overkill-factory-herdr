# Slices: breaking the plan into shippable pieces

Draft for discussion. The idea: ship the whole factory **window** first, with every page in place. A page that can't work yet shows a "Coming soon" card naming the milestone that brings it. Each later milestone replaces one or more of those cards.

## Facts this rests on (from Herdr's mod guide, `herdr-app/defaults/AGENTS.md`)

- A layout is a tree of `block` / `row` / `column` / `stack` nodes. A `stack` shows one child, and `layout.select {stack, child}` switches it. That is the page switcher.
- A mod in a hidden stack child **does not start until it is first shown**, so placeholder pages cost nothing.
- Mods are gpui-kit JS: `div`/`h_flex`/`v_flex`, `TextView.markdown`, a read-only `Editor` with syntax highlighting, `image()`/`svg()`, virtual lists. No HTML and **no chart primitive**. Charts and graphs are SVG files a mod shows with `image()`; saving the SVG redraws it.
- Data: `readTextFile`, `watchFolder` (local only), `exec`, `fetch`, `shared()`/`setShared()` across mods, and `notify()` for toasts.
- Shipped mods are read-only. Changing one means `mod.clone` first, which records `cloned_from {name, version}`.
- `herdr-app check <mod>` loads and renders a mod headless and exits nonzero on errors. Use it as each slice's gate.
- A mod starts the first time it shows, then stays alive while its block is in the layout, shown or not; its timers keep running while hidden (local `AGENTS.md` ~l.896).
- `shared()` values are **persisted** (`shared.json`): at launch a view sees the last session's state until the data mod republishes. Keep shared payloads small, and stamp them with a time.
- ✓ Tested 2026-11-21 with `herdr-app 0.1.16`: a mod **cannot** import outside its folder, by relative path or by symlink ("resolves outside the application directory"). A real copy inside the folder passes `check`. `herdr-app check` exits 1 on failure, so it works as a CI gate.

## What roundup teaches (reference: NazzarenoGiannelli/herdr-roundup)

- **Pure logic and view in separate files.** `*-logic.js` / `model.js` / `parse.js` hold pure functions, and `tests/*.test.mjs` run them with plain `node --test` against JSON fixtures, no Herdr needed. Views stay thin. Copy this split: CI can then test every mod without the app.
- **`RECIPE.md`**: a pixel-level spec that is enough to rebuild the mod. The plan already lists one.
- **A config file next to the mod, validated with one-line errors** ("config.json: <problem>, using defaults").
- **Fetch only while on screen**: a cheap 3 s visibility check and a slower reload. Use the same pattern while there is no daemon to push changes.
- Folder name = identity (shared keys, popups), hence the plan's `factory-` prefix.

## The coming-soon pattern

One mod, `factory-soon`, used by every unbuilt page with props:

```json
{ "id": "page-reviews", "type": "block",
  "content": { "mod": "factory-soon",
    "props": { "page": "Reviews", "milestone": "M6", "what": "Teammates' PRs, risk-ordered, with a pending review drafted", "preview": "reviews.png" } } }
```

It draws the page title, "Coming in M6", one line on what the page will do, and the mockup PNG from `docs/layouts/` (copied into `mods/factory-soon/previews/` by `sync.sh`). When a milestone lands, the layout's `content.mod` changes from `factory-soon` to the real mod. That edit is one line. The keys stay bound throughout: an action that isn't built yet toasts "Coming in M2" instead of doing nothing.

## Page roadmap

| Page / part | M1 (window, fixtures) | Real in |
| --- | --- | --- |
| Sidebar: chrome, ticket groups, menu, budget bar | real, from fixtures | M1, live in M2 |
| Header bar, status bar | real, from fixtures | M1 |
| Home | real, from fixtures | M1, live in M2 |
| Ticket (timeline, md tabs `1`–`4`, `e` terminal) | real, from fixtures; `e` opens a plain terminal | M1, live in M2 |
| Ticket, cross-repo | coming soon | M2 |
| Tickets (list + filters) | real; Runs view (`r`) soon | M1 / Runs M2 |
| Config | real (read-only Editor on `.factory/*.yaml`); schema check soon | M1 / check M2 |
| Blueprint | **decide**: static graph SVG from YAML in M1, or coming soon | M1 or M2 |
| Overwatch | coming soon (it needs the overwatch agent) | M2 |
| Metrics: Throughput, Cost, Quality | coming soon | M2 |
| Metrics: Learning, Benchmarks | coming soon | M4 |
| Reviews | coming soon | M6 |
| Actions `n m x u p b`, cloud `shift-c/l` | keys bound, toast "Coming in M2/M3" | M2–M3 |

## M1 slices (each ends with `herdr-app check` + one smoke screenshot)

Progress 2026-11-21: S0–S4, S6 and S7 are built and pass `scripts/check.sh` and `scripts/smoke.sh`. Not built yet: S5 (Ticket page), S8 (Config) and S9 (`RECIPE.md`); the smoke script itself is done. Page keys are `cmd-1`…`cmd-7`, because Herdr documents no `g h` key chords.

| # | Slice | Done when |
| --- | --- | --- |
| S0 | **Data contract.** `schemas/status.json` + the ticket-folder shape, and `tests/fixtures/` with ~6 tickets covering every state (needs-you, running, ready, queue, parked, merged), seeded from flow-stack v1 task folders. | Schema validates every fixture in `node --test`. This is the daemon's future contract, so it goes first. |
| S1 | **Skeleton.** `layouts/factory.json` (sidebar / header / stack / status), `factory-soon` on **every** page, `themes/factory.json`, the `layout:factory` section of `keys.json`, `scripts/sync.sh`, `scripts/check.sh`. | `cmd-shift-f` toggles; `g h/t/o/b/m/c` switch stack children; every page shows its coming-soon card. |
| S2 | **Shared read layer.** `model.js`: read fixtures/`status.json`, group tickets, and a watch-or-poll loop, pure and tested. Copied into each mod by `sync.sh` (see Q1). | `node --test` passes on grouping and parsing. |
| S3 | **Sidebar.** `factory-chrome`, `factory-tickets` (clone of `spaces`), `factory-menu`. Agent dots from `agents()`. | Groups and counts match the fixtures; a menu click selects the page. |
| S4 | **Header + status bar.** `factory-header` (clone of `tabs`), `factory-status` (clone of `workspace-status`). | Breadcrumb follows the page; the status bar shows fixture totals. |
| S5 | **Ticket page + `factory-pane`.** Timeline from STATUS.md/HANDOFF.md, `TextView.markdown` tabs, `e` splits a terminal. | Every fixture ticket renders; `1`–`4` switch tabs. |
| S6 | **Home.** Needs you / Running / today's four numbers. | Matches the fixtures; `enter` opens the ticket. |
| S7 | **Tickets list.** Virtual list, state filters, search (roundup's patterns). | Filter and search reach every fixture. |
| S8 | **Config.** List the `.factory/` files, read-only `Editor`, `o` opens your editor. | Every fixture `.factory/` file renders. |
| S9 | **Smoke + RECIPE.** `scripts/smoke.sh` screenshots every page in a second window; `RECIPE.md`. | M1's "done when" in plan.md. |

S3–S8 depend only on S0–S2 and touch separate mod folders, so they can run in parallel.

## Later milestones as pieces (coarse; slice each when it starts)

- **M2, daemon** (TypeScript on Bun, decided 2026-11-21). Slices:
  - **D1 Core:** SQLite (WAL, migrations), the `factory` CLI (`init`, `ticket add/set`, `status`), and `factory run`, which rewrites `~/.factory/<name>/status.json` atomically after every change. The mods read it in place of the fixture. Done when the daemon's output passes `validateStatus` and the window shows the daemon's tickets.
  - **D1b Always on:** `factory service install|uninstall|status` installs a per-user LaunchAgent (`RunAtLoad`, `KeepAlive`, PATH captured at install time) that runs `factory run --all` for every factory under `~/.factory`. There's no server: the CLI writes SQLite, and the window watches `status.json`. Config's Daemon bar installs, restarts, uninstalls and shows logs through the same command.
  - **D2 Ticket folders:** the daemon writes STATUS.md and EVIDENCE.md from rows (`factory stage`, `factory evidence`), and the Ticket page re-reads them whenever status.json reloads. Built.
  - **D3 `.factory/` checks:** `factory validate` parses YAML with `Bun.YAML` and checks each file kind against a rule table in `daemon/validate.ts`. It flags unknown keys, wrong types, bad enums, duplicate keys, and blueprint stage references (`start`, `next`, `on_fail`). Config shows ✓/✗ per file and the errors. Built. These are hand-written rules, not JSON Schema; JSON Schemas for editor autocomplete can be generated from them later.
  - **D4a Start:** `factory start <id>` creates a worktree on `factory/<id>-<slug>`, enters the blueprint's first stage, and starts that stage's agent with `hc run --bg` (labels `factory.ticket`/`factory.stage`). The session is recorded, and `status.json` carries the terminal address. Built.
  - **D4b Advance:** `factory stage-done <id> [--fail reason]`. The daemon also notices an agent's terminal exiting (`hc get`). It runs check stages itself (`tests` and `lint` run `quality_floor`; `evidence` needs each check's latest result to PASS), follows `on_fail` up to `max_retries` and then parks, and marks `gate: human` stages ready. Built. Still to do: token counts per session, the orchestrator choosing among `next`, and a human-gate stage before the end.
  - **D5 Ready rules + PR:** at the pr stage the daemon checks `ready` from factory.yaml. `evidence`: every check's latest result passes and is newer than the last commit. `quality_floor`, `template` (PR.md opens with one sentence, then What changed / Why / How it was verified / Risk), and `budget` are checked too. `holdout` and `review` show as skipped until the checker and reviewer agents exist. When all pass, the daemon pushes the branch, runs `gh pr create --draft` with the rule results appended, records the PR, and moves on to merge (human gate → ready). `factory ready <id>` lists the results. Built.
  - **D6 Intake + grooming:** the GitHub Project Ready column, then triage, then questions.
  - **D7 Actions:** `n m x u p b e d` call the daemon, replacing the toasts. **`e` is built:** it runs `terminal.peek` on the ticket's open session terminal (from status.json), on Home, Tickets and Ticket. The Ticket page shows the terminal and an Open button. **`m` is built:** a ready ticket's PR merges after the `factory-ask` confirm dialog (`factory merge <id>`: `gh pr ready`, then `gh pr merge --squash`; the ticket becomes merged and the gate ends). Every later action asks through the same dialog (`lib/actions.js` builds its props). **`b` is built:** the dialog's optional text box holds the budget; `factory budget <id> 3M/200k` sets it. **`x` and `u` are built:** `factory send-back` (note → REVIEW.md, rerun the fix stage, the open PR is updated) and `factory answer` (answer → GATES.md, rerun where it parked). **`n` is built:** `factory new <issue link | #n | goal> [--start]` (`daemon/intake.ts`, which D6 grows). **`p` is built:** a new `paused` state (contract and Queue group); `factory pause|resume`. Still a toast: `d`.
  
  Together these replace the coming-soon cards for Overwatch, cross-repo Ticket, Runs, and Metrics Throughput/Cost/Quality.
- **M3, babysitter + away mode:** PR watcher, REVIEW.md verdicts, cloud move (`shift-c/l`).
- **M4, learning + benchmarks:** Metrics Learning and Benchmarks tabs.
- **M5, auto gates + maintainer:** revert rate on Home.
- **M6, reviews:** Reviews page.

## Open technical questions for discussion

Status 2026-11-21: Q1 is settled by test (copy `lib/` into each mod; a symlink is refused). Q4 is done (`herdr-app` 0.1.16 and `hc` are installed). Q2, Q3 and Q5 keep the recommendations from the discussion (one `factory-data` mod in an always-shown block; Blueprint coming soon until M2; hand-written fixtures plus one real v1 folder), pending your OK.

1. **Shared code across mods.** The guide shows `./ui.js` imports inside one mod, not imports across mod folders. Options: (a) `sync.sh` copies `lib/model.js` into each mod, (b) one big mod that draws every part, picking which by its props, (c) mods share only data via `shared()` and each reads its files on its own. My lean: (a). It keeps one mod per idea, and tests run once on `lib/`.
2. **Who reads files in M1.** Each mod uses `watchFolder` on the ticket folders, or one hidden `factory-data` mod reads and publishes them through `setShared`. The second gives one watcher and one parse, and the other mods render from `shared()` (re-renders are free).
3. **Blueprint in M1 or M2?** Plan M1's "done when" includes a blueprint picture. A static SVG from YAML (layout by a small script, or Graphviz `dot` via `exec`) is doable now, but it pulls in a graph-layout dependency early.
4. **Getting the app.** `herdr-app` isn't installed here. M1 can't be checked without it.
5. **Fixture source.** Use flow-stack v1 task folders as-is (real but messy), or hand-write a clean set first?
