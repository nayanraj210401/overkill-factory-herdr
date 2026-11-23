# flow-stack skills for the factory

Which of [flow-stack](https://github.com/nayanraj210401/flow-stack)'s skills the factory should take, where each would go, and which to leave. Read against flow-stack `main` at `bb17992` (45 skills) on 2026-11-23.

## How a skill comes into the factory

Factory sessions start without the flow-stack plugin, so its hooks never run inside the factory (plan, "First run"). A skill comes in as a **factory skill**:

- **Shipped** under `examples/skills/<name>/` (its `SKILL.md` and scripts), next to the example agents.
- **Installed** into `~/.factory/skills/` by `factory init` and `factory setup`, never overwriting a file you edited. Your own skills there count too.
- **Given to an agent only when its frontmatter lists it** (`skills: [tour, deslop]`, from the M6 design). The brief carries only those.
- **Built (M7):** a session gets its listed skills as a plugin of its own (`claude --plugin-dir=<ticket folder>/.skills/<agent>`, seen as `factory:<name>`) and, when the agent lists `tools:`, only those tools (`claude --tools=…`). `factory validate` errors on a listed skill it can't find. `examples/skills/README.md` has the format and `commit-message` as a working example; the skills below still need porting.
- **No mid-work hooks.** Where flow-stack enforces a rule with a hook, the factory enforces it at a stage boundary or a ready rule instead.

## Take

| Priority | Skill | What it does | Where it goes in the factory |
| --- | --- | --- | --- |
| 1 | `tour` | ranks every hunk read / skim / skip, with net lines and an estimated review time | Peer review: one tour per PR, beside the chapters story; also on our own PR.md |
| 1 | `probe` | reverts the change (or hollows new code) and reruns a passing check; if it still passes, the check proves nothing (`TOOTHLESS`) | the checker stage, after a check passes; a ready rule refuses a PR whose key check is `TOOTHLESS` |
| 1 | `seal` | locks a ticket's approved acceptance checks so an agent can't loosen them to pass | the daemon hashes the sealed checks when the plan stage ends; a ready rule refuses the PR if any changed, unless you reseal (no edit hook) |
| 1 | blind checks (in `intent` and `verify`) | checks the builder never sees, run by someone else | the checker runs checks kept out of the builder's brief; their results go in EVIDENCE.md |
| 1 | `diagnose` | reproduce, 2–3 hypotheses with the observation that decides each, ask why to the root cause; the repro becomes the regression check | a `diagnose` stage at the head of the bugfix blueprint; repo health's failure tickets start there |
| 1 | `deslop` | removes narrating comments, dead code, defensive clutter, casts, needless abstraction, duplicate helpers | a cleanup step before `pr`, and a lens for the reviewer |
| 2 | `challenge` | a blind advocate designs from the goal alone, then attacks ours; always weighs delete / reuse / configure / don't build | when a ticket fails three rounds, it runs before a fourth fix; also in peer review for a PR that's a big net add |
| 2 | `claims` | tags each statement verified (with evidence) or assumed | the PR writer and the babysitter's replies |
| 2 | `unslop` | removes AI tells from prose | the PR writer, the review comment format, Overwatch replies |
| 2 | `debt` | a ledger of shortcuts with a cost and an event that should trigger repaying it | agents record shortcuts on the ticket; a fired trigger becomes a maintenance ticket |
| 2 | `make-verifier`, `make-runner` | build and self-test a repo's driver (run it like a user) and its install / start / reset commands | setup for a new repo: the `feat:<id>` scenarios get a driver, and repo health gets its `setup:` install command |
| 3 | `make-gates` | turns a repo's irreversible actions into deny / ask rules | setup proposes a repo's hard stops and never-unattended areas, as a maintainer PR |
| 3 | `reflect` | turns corrections into taste, lessons and calibration, and prefers a lint rule over prose | the learner already does this; take its "lint rule over prose" rule into the learner's prompt |
| 3 | `trace` | who decided what, estimate against actual | the Ticket page's decision log already holds this; take its estimate-against-actual view for Metrics |

Priority 1 makes every ticket's PR more trustworthy, or every review cheaper, and nothing else depends on it. Priority 2 is next. Priority 3 is small and folds into existing agents.

## Already in the factory

| flow-stack skill | Factory equivalent |
| --- | --- |
| `intent`, `slice` | the spec and plan stages: INTENT.md, SLICES.md |
| `handoff` | HANDOFF.md, the cloud hand-off and auto-resume |
| `feature-map`, `verify` | `verify: { features }` and the `feat:<id>` scenarios, EVIDENCE.md |
| `review` | the reviewer agent and review stage; M6's peer reviewer builds on its rules |
| `chapters` | M6: the chapters story per PR |
| `flow`, `loop`, `delegate`, `gate` | blueprints, stages, gates and `max_running`: the daemon orchestrates |
| `budget` | per-ticket and per-day budgets, the plan line |
| `board`, `wrap` | Home, Metrics and the away digest |
| `setup`, `profile`, `settings` | `factory setup`, `factory.yaml`, `~/.factory/config.yaml` |
| `make-routines` | the cloud babysitter routine |

## Leave

| Skill | Why |
| --- | --- |
| `brief`, `dojo`, `teach` | for a person in a live session, not an agent stage |
| `recall`, `how`, `why`, `what`, `map` | for a person exploring; agents get the repo map and lessons in their brief. Could be offered to Overwatch later |
| `make-skill`, `tend` | flow-stack's own skill tooling; the maintainer edits factory skills as PRs |
| `make-playbook` | playbooks become blueprints (the flow-stack migration already does this) |
| `principles` | the useful ones are already inside `diagnose`, `challenge` and `probe`; agents can list it if wanted |
| `setup-factory` | flow-stack's own factory setup; this repo replaces it |

## Building them

One sub-agent per skill, each with its own files, three at a time. The first one also adds the shared plumbing: `examples/skills/`, the install into `~/.factory/skills/`, and the `skills:` frontmatter field. Then:

1. `tour`, `probe`, `diagnose`
2. `seal` with blind checks, `deslop`, `challenge`
3. `claims` and `unslop` together, `debt`, `make-verifier` with `make-runner`

Each sub-agent copies the skill from flow-stack, drops what depends on flow-stack's hooks, `.flow/` paths or `task.sh`, and wires it to the factory's ticket files (INTENT.md, EVIDENCE.md, the decision log) and ready rules. Each lands with a test that fails without it.
