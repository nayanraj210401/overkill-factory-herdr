# Setting up the factory on a new Mac

This guide installs the factory on a Mac that has never run it and points it at one repo. It takes about 20 minutes. The factory runs only on macOS: its daemon is a launchd login item.

## 1. Install the tools

| Tool | Why | Install |
| --- | --- | --- |
| Xcode command-line tools | `git`, and `clang` for the sleep/wake helper | `xcode-select --install` |
| Homebrew | installs `gh` | see brew.sh |
| Bun 1.3+ | runs the daemon and the CLI | `curl -fsSL https://bun.sh/install \| bash` |
| Node 22+ | `scripts/gen.mjs`, `scripts/sync.sh` and the tests | nvm or `brew install node` |
| GitHub CLI, logged in | tickets, PRs and merges | `brew install gh && gh auth login` |
| Claude Code, logged in | every agent runs `claude` | `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in |
| Herdr app (`herdr-app`) and herdr-core (`hc`) | the window, and the agents' terminals | from herdr.dev |

Check them:

```sh
bun --version && node --version && gh auth status && claude --version && hc --version && herdr-app --version
```

## 2. Get the factory

The repo is private, so `gh` must be logged in to an account that can read it.

```sh
gh repo clone nayanraj210401/overkill-factory-herdr ~/Project/overkill-factory-herdr
cd ~/Project/overkill-factory-herdr
git checkout develop
scripts/check.sh   # unit tests, generated files, and herdr-app check on every mod
scripts/sync.sh    # installs the layout, mods, theme and keys into ~/.config/herdr-app
```

On a new machine `~/.config/herdr-app/keys.json` doesn't exist yet, so `sync.sh` writes the factory keys into it. On a machine that already has one, run `scripts/sync.sh --keys` to merge them (it keeps a backup).

Nothing in the repo puts `factory` on your PATH. Make a small wrapper:

```sh
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec "%s" "%s/daemon/cli.ts" "$@"\n' "$(command -v bun)" "$HOME/Project/overkill-factory-herdr" > ~/.local/bin/factory
chmod +x ~/.local/bin/factory
factory help       # ~/.local/bin must be on PATH
```

## 3. Point it at a repo

Run these in the repo you want the factory to work on:

```sh
cd ~/code/<repo>
factory init            # the factory is named after this folder; the repo slug comes from origin
factory setup           # the checklist: what is missing, and the fix for each
factory setup trust     # Claude Code trusts the factory's folders, so agents don't stop to ask
factory setup write --budget 2M/100k --budget-day 10M/1M --merge human --max-running 1
git merge factory/setup # setup write commits .factory/ to this branch and leaves your checkout alone
factory validate
factory service install # if launchctl fails with error 5, run it again
factory setup           # run it until every line shows ✓
```

- `--budget` is per ticket and `--budget-day` is for the whole day, as input/output tokens. Start low until you know what a ticket costs.
- `--queue <owner>/<project number>` connects a GitHub Project's Ready column. Leave it out to make tickets by hand with `n`.
- If `setup write` finds no test command, add one to `.factory/factory.yaml`, for example `quality_floor: [bun test]`. The tests check and its ready rule need it.
- The first `factory init` or `factory setup` writes the factory agents to `~/.factory/agents/` and the example agents to `~/.factory/examples/agents/`. It never overwrites a file that is already there, and adds examples a newer factory ships.
- `setup write` copies into the repo's `.factory/agents/` only the agents its blueprints and grooming name, each from your own example in `~/.factory/examples/agents/` if you wrote one, else the shipped one. The examples themselves never run.

## 4. Open it

1. Start Herdr and open a space on the repo's folder. The folder name is how the window finds the factory.
2. Press ⌘⇧F to switch to factory mode. ⌘⇧F again goes back to Herdr.
3. Open Config (⌘7). The daemon dot is green when the service runs.
4. Press `n` and give a small goal, or an issue number, for a first ticket.

## What runs without you

- **Repo health:** once a day the daemon runs the repo's `quality_floor` on the default branch, in a throwaway worktree, with no agent and no tokens. The first run is a day after setup; `factory health` runs it now. A failure files one queued `bugfix` ticket that waits for you to start it. The next pass closes it if nobody started it. The last result shows on Home. A fresh worktree has no installed dependencies, so if the suite needs them, add `.factory/triggers/health.yaml` with `on: schedule`, `every: 1d`, `run: health`, `blueprint: bugfix` and `setup: [npm ci]` (or your install command).
- **Lesson upkeep:** every day near-duplicate lessons are merged and unused ones are retired. `factory learn restore <id>` undoes either.
- **The maintenance agent is off.** When it is on, it makes one small drift fix a day (a patch bump, lint drift, dead config) as a normal PR. To turn it on, ask Overwatch ("turn on the maintenance agent"), or set `enabled: true` in `.factory/triggers/maintenance.yaml`. Its merge gate stays `human` until you change it.

## On a work machine

- **Device management.** A managed Mac may block LaunchAgents, ad-hoc `codesign` or `clang`. If `factory service install` fails, `factory run --all` runs the daemon in a terminal instead. Without the sleep helper, only `cloud.on_sleep` stops working.
- **Whose accounts.** Agents push branches and open PRs as the account `gh` is logged in to, and spend the plan `claude` is logged in to. Check both are allowed for your work repos, and keep `--merge human`.
- **PATH is fixed at install.** The service keeps the PATH from when you ran `factory service install`. After installing a new tool, run it again.
- **Nothing carries over.** `~/.factory` (the database, logs and agents) is per machine, so a new Mac starts with an empty history.

## Updating

```sh
cd ~/Project/overkill-factory-herdr
git pull --ff-only
cp ~/.factory/<factory>/factory.db ~/.factory/<factory>/factory.db.bak-$(date +%s)
scripts/check.sh && scripts/sync.sh   # sync.sh restarts the service
```

## If something is wrong

- `factory setup` lists every missing step with its fix.
- `factory service status` shows whether the daemon runs. Its logs are in `~/.factory/logs/`, and `daemon.err.log` should be quiet.
- `factory validate` checks `.factory/`, `~/.factory/config.yaml` and the factory agents.
- `factory claude` shows which `claude` the agents run.
