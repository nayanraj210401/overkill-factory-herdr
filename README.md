# overkill-factory-herdr

A software factory that runs inside the [Herdr app](https://herdr.dev) as its own mode. It takes a ticket from your GitHub queue (or a goal you type), grooms it, runs it through a blueprint of Claude Code agent stages in an isolated worktree, and hands you a PR that has already passed its ready rules. You review and merge. A babysitter handles review comments, and the factory learns from what you keep and change.

Everything runs on your Mac: a launchd daemon, SQLite as the store, and one Herdr window as the cockpit. Tickets can move to Claude Code cloud sessions when the laptop sleeps.

## Status

| Milestone | What | State |
| --- | --- | --- |
| M1 Layout | factory mode in Herdr: sidebar, Home, Tickets, Ticket, Config | built, proven live |
| M2 Default blueprint | daemon, queue, stages, ready rules, PRs | built, proven live |
| M3 Babysitter, away | review rounds, auto-resume after the plan limit, cloud hand-off | built, proven live |
| M4 Learning, benchmarks | lessons, bandit experiments, Learning tab | built; benchmark suite not run yet |
| M5 Auto gates, maintenance | `gate: auto`, broken checks, daily repo health, maintenance agent (off by default), lesson upkeep | built |
| M6 Peer review | reviewing teammates' PRs | Reviews page on sample data; design in [docs/plan.md](docs/plan.md) |
| M7 Agents with territories | Overwatch, maintainer, learner, babysitter; example agent library | built |

macOS only. Claude Code is the only agent harness.

## Set it up

The full guide is [docs/setup.md](docs/setup.md). The short version:

```sh
# 1. Tools: Xcode CLT, Homebrew, Bun 1.3+, Node 22+, gh (logged in), Claude Code (logged in), Herdr app + herdr-core (hc)
xcode-select --install
curl -fsSL https://bun.sh/install | bash
brew install gh node && gh auth login
npm install -g @anthropic-ai/claude-code && claude          # sign in once
# Herdr app and herdr-core: install from herdr.dev, then check: herdr-app --version && hc --version

# 2. The factory
gh repo clone nayanraj210401/overkill-factory-herdr ~/Project/overkill-factory-herdr
cd ~/Project/overkill-factory-herdr && git checkout develop
scripts/check.sh && scripts/sync.sh
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec "%s" "%s/daemon/cli.ts" "$@"\n' "$(command -v bun)" "$PWD" > ~/.local/bin/factory && chmod +x ~/.local/bin/factory

# 3. Point it at a repo
cd ~/code/<repo>
factory init && factory setup && factory setup trust
factory setup write --budget 2M/100k --budget-day 10M/1M --merge human --max-running 1
git merge factory/setup && factory validate
factory service install       # launchd error 5 the first time is common: run it again
factory setup                 # repeat until every line shows ✓
```

Then open Herdr on the repo's folder and press ⌘⇧F. Press `n` for a first ticket.

### On an office laptop

- **Accounts.** Agents push branches and open PRs as whoever `gh` is logged in as, and spend the plan `claude` is logged in to. Check both are allowed on work repos. Keep `--merge human`.
- **Start small.** `--max-running 1` and a low `--budget-day` until you know what a ticket costs. The maintenance agent ships off (`enabled: false` in `.factory/triggers/maintenance.yaml`), so nothing opens PRs on its own.
- **Device management.** If MDM blocks LaunchAgents, `codesign` or `clang`, run the daemon in a terminal with `factory run --all`. Only sleep-to-cloud needs the helper `clang` builds.
- **Dependencies for repo health.** The daily health run tests the default branch in a fresh worktree. If the suite needs an install step, add `setup: [npm ci]` to a `.factory/triggers/health.yaml` (see the setup guide).
- **Nothing carries over.** `~/.factory` (database, logs, agents) is per machine.

## Using it

| Key | Does |
| --- | --- |
| ⌘⇧F | factory mode on and off |
| ⌘1–⌘7 | Home, Tickets, Reviews, Overwatch, Blueprint, Metrics, Config |
| `n` | new ticket from an issue, `#number` or a one-line goal |
| `e` | peek at the ticket's live agent terminal |
| `m` | merge a ready PR |
| `x` / `u` | send a PR back with a note / answer a parked ticket |
| `p` / `b` / `d` | pause or resume / change the budget / diff |

You change the factory by asking Overwatch ("add a blueprint for migrations", "turn on the maintenance agent"). The maintainer does the work as a reviewable PR against `.factory/`.

## Updating

```sh
cd ~/Project/overkill-factory-herdr && git pull --ff-only
cp ~/.factory/<factory>/factory.db ~/.factory/<factory>/factory.db.bak-$(date +%s)
scripts/check.sh && scripts/sync.sh     # sync.sh restarts the service
```

## Docs

| Doc | What it is |
| --- | --- |
| [docs/setup.md](docs/setup.md) | Setting up on a new Mac: tools, install, pointing it at a repo, work-machine notes, troubleshooting |
| [docs/plan.md](docs/plan.md) | The plan: layout and pages, agents, blueprints, ready rules, review loop, learning, budgets, away mode, peer review, milestones |
| [docs/slices.md](docs/slices.md) | How each milestone was cut into slices |
| [docs/prd.md](docs/prd.md) | The product requirements the plan implements |
| [docs/research-software-factories.md](docs/research-software-factories.md) | Background research on AI software factories |
| [RECIPE.md](RECIPE.md) | How factory mode's layout and mods are built |
| [docs/layouts/](docs/layouts/) | Mockups of every page |

## Layouts

| | |
| --- | --- |
| ![Home](docs/layouts/01-home.png) | ![Ticket](docs/layouts/02-ticket.png) |
| ![Tickets](docs/layouts/03-tickets.png) | ![Reviews](docs/layouts/08-reviews.png) |
| ![Blueprint](docs/layouts/05-blueprint.png) | ![Metrics, Cost](docs/layouts/06b-metrics-cost.png) |

## Origin

This repo succeeds [flow-stack](https://github.com/nayanraj210401/flow-stack) v1 as the factory. It keeps the parts of flow-stack that check finished work (evidence, review, handoff) and leaves out the hooks that interrupt agents mid-work. flow-stack itself keeps working as a Claude Code plugin.
