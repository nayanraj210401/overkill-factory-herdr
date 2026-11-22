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
| Ticket, cross-repo | built: a card per repo and the cross check, on the Ticket page | M4 |
| Tickets (list + filters) | real; Runs view (`r`) soon | M1 / Runs M2 |
| Config | real (read-only Editor on `.factory/*.yaml`); the check runs `factory validate` | M1 / check M2 |
| Blueprint | built: `factory-blueprint` draws `blueprints.json` (stages in path order, 7-day run counts, gates, failure routes), which the daemon writes beside status.json | M2 |
| Overwatch | built: `factory-overwatch` starts (or reopens) the overwatch agent with `factory overwatch` and peeks its terminal | M2 |
| Metrics: Throughput, Cost, Quality | built: `factory-metrics` draws `metrics.json`, which the daemon writes beside status.json (7 or 30 days against the period before) | M2 |
| Metrics: Learning, Benchmarks | coming soon | M4 |
| Reviews | coming soon | M6 |
| Actions `n m x u p b e d`, cloud `shift-c/l` | built: each confirms in `factory-ask` and runs the `factory` CLI | M2–M3 |

## M1 slices (each ends with `herdr-app check` + one smoke screenshot)

Progress 2026-11-21: S0–S9 are built and pass `scripts/check.sh` and `scripts/smoke.sh`. Page keys are `cmd-1`…`cmd-7`, because Herdr documents no `g h` key chords.

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
  - **Herdr worktrees:** the ticket's checkout goes where Herdr app's New worktree puts one (`<worktrees.directory>/<repo>/<branch-slug>`, from the app's settings.json, default `~/.herdr/worktrees`) and opens as an unnamed space (`herdr-app do space.new`), which Herdr nests under the repo's space; each later stage is a tab there (`tab.new`). An agent in a tab runs in a shell that stays open, so a stage ends when the agent was seen in front (`hc get` `foreground`) and the shell is back. With the app not running (the daemon under launchd), the agent runs free-floating with `hc run` as before. Merging closes the space and removes the worktree; the branch stays. `factory start` reuses a branch or checkout a failed start left. (Herdr's TUI has `herdr worktree create`; the app has no worktree CLI, so this is what its `worktree` mod does.) Built.
  - **D4b Advance:** `factory stage-done <id> [--fail reason]`. The daemon also notices an agent's terminal exiting (`hc get`). It runs check stages itself (`tests` and `lint` run `quality_floor`; `evidence` needs each check's latest result to PASS), follows `on_fail` up to `max_retries` and then parks, and marks `gate: human` stages ready. Built. **The orchestrator chooses among `next`** (`daemon/orchestrate.ts`): when a passed stage offers several, one tool-free call to the blueprint's orchestrator agent (its model, INTENT.md, the latest checks, the options) answers `NEXT:` and `WHY:`; the choice and its reason go in the decision log, and anything unreadable takes the first `next`. Built. **`per: slice` is built** (`daemon/slices.ts`): such a stage runs once per open slice of SLICES.md (`##` sections, else numbered items), a fresh session each whose brief names only that slice; a slice is done when its session ends without failing (the `slices` table) or SLICES.md marks it ([x], ✓, done), and a handoff keeps the session's slice. No slices, or sent back after the last one: it runs once for the ticket. Still to do: token counts per session, and a human-gate stage before the end.
  - **D5 Ready rules + PR:** at the pr stage the daemon checks `ready` from factory.yaml. `evidence`: every check's latest result passes and is newer than the last commit. `quality_floor`, `template` (PR.md opens with one sentence, then What changed / Why / How it was verified / Risk), and `budget` are checked too. `holdout` and `review` read verdicts that agents record with `factory verdict <id> holdout|review pass|fail [detail…]`: each voter's latest verdict newer than the last commit counts; holdout needs every one to pass, review a majority. A stage whose agent has role `verify` (the checker) or `review` must end with a verdict: a FAIL, or none, fails the stage to its `on_fail`, and the blockers go into REVIEW.md. The rule is skipped only when the blueprint has no such stage. When all pass, the daemon pushes the branch, runs `gh pr create --draft` with the rule results appended, records the PR, and moves on to merge (human gate → ready). `factory ready <id>` lists the results. Built.
  - **D6 Intake + grooming:** the GitHub Project Ready column, then triage, then questions. **Grooming is built** (`daemon/groom.ts`):
    - `factory groom <id>` starts the triage agent (`grooming.agent`, default `triager`) in the ticket's folder, not a worktree, so its transcript counts for the ticket. It reads the issue and the repo by path.
    - It records `factory pick <id> <blueprint>` (one of `grooming.blueprints`) and `factory question <id> product|engineering <text>`.
    - When triage ends, open questions become `needs.kind = "question"` and GATES.md entries. When `grooming.questions` includes `issue`, they are posted as one issue comment that mentions the PO (`grooming.product_owner`, else the issue's author).
    - `u` (`factory answer`) answers the first open question, or the ones its `A2:` lines name, and posts the answer on the issue. The daemon reads `A1:` comments on the issue once a minute.
    - **The queue is built** (`pollQueue` in `daemon/intake.ts`): every 3 minutes (or `factory queue`), the daemon lists `queue.github_project`'s items with `gh project item-list`. The project is `owner/<number or title>`, and a title is looked up once. Issues in `queue.column` (default Ready), in this factory's repo and assigned to `queue.assignee` (`me` means your gh login) join as `grooming` tickets. Triage starts on them oldest first, with at most `max_running` triage agents at once. gh needs the `project` scope (`gh auth refresh -s project`).
    - With every question answered, the ticket is groomed (`groomed_at`). Groomed tickets start on their own, oldest first, while fewer than `max_running` (default 3) run. Tickets added with `n` still start at once, without grooming.
  - **Split** (`daemon/split.ts`): triage or any stage's agent proposes the parts in order (`factory split <id> add <title> --scope … [--keeps-work]`). At the stage's end the ticket stops for you (`tickets: { split: human }`, the default; `factory split <id> approve|reject`, or `u` with approve/reject) or the parts are made at once (`auto`). Each part becomes a sub-issue of the ticket's issue (a goal's parts are local tickets) and a groomed ticket on the parent's blueprint, waiting on the part before it. Work so far is committed and the part marked `--keeps-work` (else the first) branches from it. The parent waits paused and closes, with its issue, once every part is merged or closed. Built.
  - **Token recording:** each ticket's worktree has its own Claude Code transcript folder; the daemon reads it every tick into a `usage` table (one row per message, priced per model), attributes rows to the stage session running then, and sums them onto the ticket. `factory sessions <id>` shows tokens and cost per stage; status.json's today numbers (usd, tokens, cost per PR, time to PR) come from it. Built.
  - **D7 Actions:** `n m x u p b e d` call the daemon, replacing the toasts. **`e` is built:** it runs `terminal.peek` on the ticket's open session terminal (from status.json), on Home, Tickets and Ticket. The Ticket page shows the terminal and an Open button. **`m` is built:** a ready ticket's PR merges after the `factory-ask` confirm dialog (`factory merge <id>`: `gh pr ready`, then `gh pr merge --squash`; the ticket becomes merged and the gate ends). Every later action asks through the same dialog (`lib/actions.js` builds its props). **`b` is built:** the dialog's optional text box holds the budget; `factory budget <id> 3M/200k` sets it. **`x` and `u` are built:** `factory send-back` (note → REVIEW.md, rerun the fix stage, the open PR is updated) and `factory answer` (answer → GATES.md, rerun where it parked). **`n` is built:** `factory new <issue link | #n | goal> [--start]` (`daemon/intake.ts`, which D6 grows). **`p` is built:** a new `paused` state (contract and Queue group); `factory pause|resume`. **`d` is built:** `factory diff` plus the `factory-diff` window (not Herdr's changes panel, which follows the focused pane and shows only uncommitted work). D7 is done; `⇧C`/`⇧L` wait for M3.
  
  Together these replace the coming-soon cards for Overwatch, cross-repo Ticket, Runs, and Metrics Throughput/Cost/Quality.
- **M3, babysitter + away mode:** PR watcher, REVIEW.md verdicts, cloud move (`shift-c/l`).
  - **PR watcher is built** (`daemon/watch.ts`): every 2 minutes the daemon reads each ready, watched PR on GitHub (`gh pr view` for comments and reviews, `gh api …/pulls/<n>/comments` for inline ones). Merged or closed there, the ticket follows, and its worktree goes. New comments from anyone but your own gh login go into REVIEW.md and send the ticket back to its fix stage, whose agent fixes each one or replies with its reasoning; the pr stage then updates the PR. Your own comments are skipped, because the factory acts as you; use `x` for your notes. **Comment verdicts are built** (`daemon/comments.ts`): each new comment is stored once, by its GitHub id, as C1, C2… per ticket. Inline replies share their root comment's thread. The fix agent records `factory comment <id> C<n> fix|pushback|escalate <reason>`, and the stage fails while any comment lacks a verdict. An escalation parks the ticket in Needs you. A reviewer who replies again in a thread that already has `review.pushbacks` pushbacks (default 2) wins: that comment can't be pushed back. Not yet: a cheap model pre-judging each comment.
  - **Codex usage is recorded** (`parseCodex`, from `$CODEX_HOME/sessions`).
  - **Away mode is built** (`daemon/away.ts`): `factory away on|off`. While you're away, `away:` in factory.yaml applies:
    - `blueprints`: only these start.
    - `budget`: caps the ready rule's per-ticket budget (`1M/100k`).
    - `review_rounds`: after this many rounds, new comments park the ticket instead of starting another.
    - `never`: path globs that park a ticket touching them at its stage's end.
    - Pushbacks are refused, since the agreement benchmark doesn't exist yet.
    - Home shows a digest of what others decided while you were away, for a day after you're back (`status.json` `away`).
    - `min_agreement`: the agreement benchmark's bar, off unless set. The benchmark isn't built, so setting it refuses pushbacks while away and cloud moves.
    Not yet: turning digest corrections into lessons.
  - **Cloud move is built** (`daemon/cloud.ts`):
    - `⇧C` / `factory cloud <id>|--all` stops the local agent and writes `.factory-run/<id>/CLOUD.md` (where the ticket stands, the stages left, the rules, and what to report) plus copies of the ticket's files. It commits the work in progress, pushes the branch, and runs `claude --cloud "Continue the work described in .factory-run/<id>/CLOUD.md …"` in a terminal. The ticket shows "in cloud", and the daemon stops watching it; nothing is tracked there, by choice.
    - `⇧L` / `factory local <id>` fetches and fast-forwards the branch. It imports `RESULT.md` (evidence lines, notes as HANDOFF.md, questions park the ticket) and PR.md, removes the pack from the branch, and resumes at the stage the cloud reached.
  - **Multi-repo, plan option (a):** one factory per lead repo; other repos join only through cross-repo tickets. **The model is built:** migration 11 adds `repos` (the lead from `factory init`, others from `factory repo add owner/name --path dir`, which must be in factory.yaml's `repos:`) and `ticket_repos` (each ticket's worktree, branch and PR per repo, a lead row for every ticket so far). **The window shows them:** `· N repos` in the sidebar header, a repo badge on rows, a Repo filter on Tickets. **Cross-repo start is built:** triage (or you) records `factory repos <id> a/b c/d` while the ticket hasn't started; the start makes one worktree per repo on the same branch, opens each other repo as a shell tab in the ticket's space, and the brief lists every worktree. When the PR is over, every worktree goes. **Cross-repo PRs are built:** the tests check also runs factory.yaml's `cross_check` (in the lead's worktree, each repo's worktree in `FACTORY_REPO_<NAME>`), and a cross-repo ticket's ready rules add `cross_check`. The pr stage opens one draft PR per repo, each body naming the others (a PR the branch already has is reused, so a failed run never opens two). `m` merges them in merge order (`factory merge-order <id> a/b c/d`; by default the others, then the lead), stops at the first failure, and goes on from it next time. The watcher reads every repo's PR and sends their new comments back as one round. ⇧C pushes every branch (CLOUD.md names the others); ⇧L fast-forwards each. `d` shows every repo's changes under its name. **The Ticket page shows a cross-repo ticket:** a card per repo (lead or linked, branch, PR, its place in the merge order) and the cross check, replacing the coming-soon card.
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
