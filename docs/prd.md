# AI Software Factory — Product Requirements

A desktop app that turns tickets into merged, evidence-backed pull requests using AI agents. It keeps humans in control at whatever level of oversight the work needs. The product name is still undecided.

## 1. Problem

Engineers already use Claude and other agents to research, write tickets, write specs and write code. Four problems keep showing up:

- **Low PR throughput.** Picking up a ticket and getting to a reviewed, mergeable PR takes too long.
- **Review is the bottleneck.** The human can't review agent output as fast as agents produce it.
- **Humans lose the thread.** Constant context switching overwhelms the operator. Many end up handing all control to the agent. Not because they trust it, but because they are tired.
- **The loop is open.** When a reviewer asks for changes, the human has to copy those comments back into an agent session by hand.

Two more problems make it worse:

- **AI text is hard to read.** Even "concise" output buries the main point, and sometimes leaves out key information.
- **Self-learning by prompt does not scale.** Appending every lesson to the prompt bloats it until a five-hour Claude session fits only about two tickets.

## 2. Vision

The best engineers are fast because they have turned their judgment into systems: clear docs, clear ways to verify work, and a sharp sense of which review comments matter. The factory packages that judgment so any engineer gets it. It works at any autonomy level, from a human reviewing every line to loops that run unattended.

## 3. Goals and success metrics

| Goal | Metric | Direction |
| --- | --- | --- |
| Faster delivery | Time from ticket pickup to PR opened | Minimise |
| Higher quality | 7-day revert rate; change-failure rate | Minimise |
| Every PR is provable | Share of PRs with a complete evidence pack | 100% |
| Less review load | Time to first human review; comments per PR that need a human | Minimise |
| Loop closed | Review comments handled without manual copy-paste | Maximise |
| Learning without bloat | Base prompt size over time; tickets per session | Prompt stays flat; tickets per session rise |

The headline metric is time from pickup to PR, counting only PRs that pass verification and carry evidence.

## 4. Users and oversight modes

The factory is a product other engineers use, not one person's private setup. It supports three oversight modes:

| Mode | What the human does | Typical work |
| --- | --- | --- |
| Human in the loop | Approves plans and reviews every change | Auth, billing, public APIs, long-lived design |
| Human near the loop | Sees summaries and evidence, steps in when flagged | Most feature work |
| Human outside the loop | Only sees outcomes and exceptions | Lint fixes, dependency bumps, routine migrations |

&#91;embedded content: Oversight modes · 3 modes, set per type of work\]

The wizard sets where each type of work starts. After that, the track record moves it toward the human or away from them.

### 4.1 Autonomy levels

**Decided:** the factory works at whatever autonomy level a person is at, using Dan Shapiro's L0–L5 scale. Each level maps onto an oversight mode:

| Shapiro level | Oversight mode | What the factory does | What the person does |
| --- | --- | --- | --- |
| L0–L1: autocomplete, intern | Human writes | Review help, readable summaries, evidence | Writes the code |
| L2–L3: junior dev, developer | Human in the loop | Agents write the code | Reviews every change |
| L4: engineering team | Human near the loop | Agents build and review | Writes specs, approves plans |
| L5: dark factory | Human outside the loop | Specs in, verified PRs out | Owns outcomes and handles exceptions |

Rules:

- **Autonomy is capped by verification.** The user picks a level, but the factory only allows a level that the checks can back up. A loop with weak tests or no evidence can't run at L5, even if the user asks for it.
- **Levels apply per loop, not per person.** One user can run lint fixes at L5 and auth changes at L2.
- **Levels change with the track record,** as in the diagram above.

**Decided:** a setup wizard picks each user's starting mode based on their persona. After that, oversight varies by type of work, not just by user. The factory learns from past patterns which tasks are safe to automate and which need a human. Trust is earned: loops that keep passing review move toward more autonomy, and loops that fail move back toward the human.

## 5. Product principles

1. **Works with any harness.** A harness-agnostic agent control plane. Users bring any harness (Claude Code, Codex and others) with an easy learning curve.
2. **Learns without bloating.** Feedback turns into enforced checks and a scoped lesson store, never into an ever-growing prompt.
3. **Oversight adapts to the work.** The three modes above, set per type of work and adjusted by track record.
4. **Evidence over assertion.** Every output carries proof that it works, not just "tests passed".
5. **Readable by default.** Every output starts with its main point and follows a fixed template, so nothing is buried or missing.
6. **Owns its output until merged.** The factory watches its own PRs and closes the review loop itself.
7. **Reviews others too.** The same quality standards apply when the user reviews someone else's work.

## 6. Functional requirements

### 6.1 Default loop (ticket to PR)

- The factory ships with a default loop: ticket in, then spec, plan, implementation, verification, and a PR with evidence out.
- Most users run the default loop unchanged.
- Custom user loops are planned but out of scope for now (see section 9).

&#91;embedded content: Default loop · 7 steps, 1 retry loop\]

A failed verification sends the work back to the coding agents. Only work that passes the checks and the template check becomes a PR.

### 6.2 Evidence pack

- Every PR includes an evidence pack: tests run and their results, the acceptance checks that passed, plus logs or screenshots where relevant.
- A PR without a complete evidence pack doesn't count toward throughput.

### 6.3 Readable output template

- Every output (PR description, summary, review, status update) opens with one plain sentence stating its main point.
- A fixed template with required fields means nothing important gets left out. For a PR, the fields are: what changed, why, how it was verified, risk, and what the reviewer should check.
- A checker agent rejects output that skips a field or buries the point, and sends it back for a rewrite before a human sees it.

### 6.4 Self-learning without prompt bloat

- Feedback becomes something the system enforces wherever possible: a lint rule, a test or a scenario. A check costs no tokens until it is broken, and its error message tells the agent how to fix the problem.
- Lessons that can't be checks go into a lesson store, scoped to an area of the codebase or a type of work. They are loaded only when a ticket touches that area.
- A periodic cleanup job merges duplicate lessons and retires lessons that never fire.
- The base prompt stays a short map of the codebase and never grows into a manual.

### 6.5 Closing the review loop (authoring side)

- The factory watches every PR it opened and picks up review comments automatically. Nobody copy-pastes comments into a session.
- Each comment gets a verdict based on three questions: is it correct, is it required, and how risky is it. The possible verdicts are: fix, push back with reasoning, or escalate to a human.
- **Decided:** if a reviewer insists after a set number of pushbacks, the factory makes the change.
- **Proposed:** if a change the reviewer insists on breaks tests or evidence, the factory still makes it but flags the failure. It defers on opinion, never silently on quality.
- Comments that keep coming up feed the self-learning in section 6.4.

### 6.6 Reviewing others' work (reviewer side)

- The factory helps the user review other people's PRs, including PRs produced by other factories, in the same structured format:
  - read the PR and any evidence pack
  - re-run the checks independently instead of trusting the author's evidence
  - sort findings into must-fix, suggestion or noise
  - present a short draft review, main point first
  - learn from which comments the author accepted or rejected
- **Decided:** the factory posts review comments automatically when it owns that work. In other cases the user approves comments before they're posted.
- When both sides use the factory, the evidence format is shared, so reviews get faster.

### 6.7 Oversight and attention

- Decisions that need the human are batched rather than interrupting one at a time. Each one comes with a short summary and its evidence.
- The oversight level for each type of work adapts based on the review history, as described in section 4.

### 6.8 Voice interface

- **Decided:** the user can talk to the factory by voice, through the overwatch agent, as well as by chat.
- **Proposed:** voice suits status checks and quick decisions, like "what needs me?" or "approve the lint fix". Long outputs such as diffs and evidence stay on screen.
- **Proposed:** spoken answers follow the readable-output rule: the main point first, in one sentence.

### 6.9 Team layer

**Decided:** the factory fits into a team, not just one user. It knows which team a user is on and who the members are, tracks how the team is performing and what is missing, and adapts to that.

| Capability | What it means | Status |
| --- | --- | --- |
| Team awareness | Knows the team, its members and the repos it owns | Decided |
| Fit existing workflows | Teammates keep their own AI tools and workflows; nobody is forced onto the factory's loop | Decided |
| Team conventions | Learns how the team works from PR templates, past review comments and merge habits, so factory PRs look like the team's own | Proposed |
| Shared quality bar | Everything entering a shared repo meets the same evidence and template standard, whoever or whatever produced it | Proposed |
| Judgment capture | Learns from the team's fastest and most trusted reviewers and turns their judgment into checks and defaults for everyone | Proposed |
| Gap detection | Finds where PRs wait longest, which comments keep coming up and where rework happens, then adjusts, for example by adding a check or flagging review pile-ups | Proposed |

**Guardrail (proposed):** performance views measure the team's flow, not individuals. Ranking people makes them resist adoption.

### 6.10 Cost control

**Decided:** the factory always knows what each PR costs to create. Cost per PR is a headline metric, tracked next to time from pickup to PR.

**Lessons from FlowStack:**

- **Too much loaded at session start.** Profile context for every repo was injected at the start of every session, whatever the ticket was about.
- **Too much verification.** Even small changes ran heavy verification. That slowed ticket-to-PR, made test runs long, and produced huge test output that drove up token cost.

| Lever | What it means | Status |
| --- | --- | --- |
| Cost per PR | Tokens and money per PR created, split by stage: spec, plan, code, verify, review | Decided |
| Load context on demand | A session starts with only the profile slice for the repo its ticket touches; the rest stays in SQLite and is fetched only if needed | Proposed |
| Stable, cacheable start | Keep the small starting prompt identical across sessions so prompt caching makes it nearly free | Proposed |
| Proportional verification | Small changes run only the affected tests; the maintenance agent runs the full suite (section 7.5) | Proposed |
| Compact test results | Agents see pass/fail counts, the first failure and the relevant lines only; full logs go to SQLite as evidence | Proposed |
| Model routing | Easy tasks and sub-agents default to cheaper models; hard tasks get stronger ones | Proposed |
| Spend visibility | A live cost counter per PR, alerts as a PR nears its expected spend, and a flag on PRs that cost far more than similar ones | Proposed |

#### Session boundaries: one ticket, one session

**Decided:** every ticket runs in its own fresh session and its own git worktree. The factory creates both when it picks up the ticket and never reuses a session for unrelated work. When a ticket needs more, the factory creates a new session or worktree itself.

**Why:** FlowStack v1's cost report (6–20 Nov 2026, from ccusage) showed that long sessions, not output, drive cost.

- 96% of 344M tokens were cache reads, and output was only 1.48M. Every turn of a long session re-reads its whole context.
- The most expensive session cost $27.50: it read 66M cached tokens to write 275k.
- One task's trail ran from 1 to 19 Nov and picked up unrelated work. Its estimate, cost and human time were all "unknown".

| Rule | Status |
| --- | --- |
| One ticket = one session + one worktree, created by the factory at pickup | Decided |
| The factory creates a new session or worktree when the ticket needs one | Decided |
| A new session (context limit, crash, a new review round) resumes from the handoff in the same worktree; a new worktree only when the work splits into separate PRs | Proposed |
| Hard handoff at about 60% context: write the handoff, end the session, start fresh | Proposed |
| Record session → ticket → PR in SQLite, so cost per PR = the sum of its sessions' costs (ccusage reports cost per session) | Proposed |
| Orchestrator runs on Sonnet; Opus only for review and design (Opus was 78% of v1 spend) | Proposed |
| Fewer, fatter tool calls: one check script that returns a short summary, not dozens of separate calls | Proposed |
| Fan-out agents on cheap models, with a cap on how many run in parallel | Proposed |

### 6.11 Learning loop (optimization target)

**Decided:** the user picks what the factory optimizes for in settings, for example cost per PR created, per review loop, per implementation-agent loop, or per review cycle. The factory then turns on learning mechanisms aimed at that target. It treats itself as a reinforcement-learning setup:

| RL part | In the factory |
| --- | --- |
| State | The factory's loops, prompts, checks, model choices and context loading |
| Actions | Settings it can change: model per step, how much context to load, how deep to verify, loop length |
| Reward | The target the user picked, measured per PR or per loop |
| Constraint | A quality floor: evidence still passes and the revert rate doesn't rise |

**Proposed rollout:**

1. **Log every decision from day one.** Each decision the factory makes goes into a decision log in SQLite, with its outcome. This is modelled on FlowStack's decisions table. The same log feeds handoffs (section 7.3) and learning.
2. **Start with bandit-style experiments.** Try a few settings on similar work, compare them against the reward, and shift toward the winner. This works with very little data.
3. **Swap in small trained models later.** Once a narrow, repeated decision has thousands of labelled examples, replace the heuristic with a small classifier or a LoRA fine-tune. Candidates:
   - the review comment filter (must-fix, suggestion or noise)
   - routing tasks to a cheap or strong model
   - selecting which tests a change needs

**Guardrail:** optimizing one target must never cut quality. Without the floor, the cheapest way to lower cost per PR is to verify less.

## 7. Architecture and technical decisions

### 7.1 Components

| Component | Role | Knows about |
| --- | --- | --- |
| Desktop app | Hosts the factory locally | Everything; owns storage |
| SQLite database | System of record for tickets, ownership, decisions, handoffs, lessons and status | n/a |
| Agent control plane | Runs and monitors sessions on any harness; shows the user what is happening | All sessions |
| Worker sessions (Claude sessions) | Each owns specific tickets and PRs; can start their own sub-agents | The full detail of their own work |
| Overwatch agent | The user's personal agent and outer loop. The user talks to it in chat. It knows which session owns which PR and what state it's in | Ownership and status only |
| Babysitter agent | Watches every PR the factory owns. When a change comes in, it starts a fresh session with the handoff | Ownership and status only |

&#91;embedded content: Architecture · desktop app, 2 shallow agents, worker sessions, SQLite\]

The overwatch and the babysitter stay shallow: they only know ownership and status. Every detail of the work lives in the sessions and in SQLite, so a dead session loses nothing.

### 7.2 Decisions so far

| Decision | Status |
| --- | --- |
| Ship as a desktop app | Decided |
| Embed SQLite for core state; other storage optional, set by configuration | Decided |
| Harness-agnostic agent control plane | Decided |
| Multiple Claude sessions inside the factory, each owning its work | Decided |
| Worker sessions may start sub-agents | Decided |
| Overwatch agent stays shallow: an outer loop with no inner details | Decided |
| PRs are subscribed to the session that owns them | Decided |
| Babysitter never revives a dead session; it starts a new one from the handoff document and keeps prior decisions | Decided |
| Babysitter is a separate agent, not a sub-agent of the overwatch; the overwatch can ask it for status | Leaning |
| User talks to the overwatch through chat for now | Decided |
| Factory posts review comments automatically on work it owns | Decided |
| Reviewer insistence wins after a set number of pushbacks | Decided |
| Setup wizard sets the starting mode; oversight varies by work after that | Decided |
| Self-learning must not grow the prompt | Decided |
| One ticket = one session + one worktree; the factory creates new sessions or worktrees as the ticket needs (6.10) | Decided |

### 7.3 Handoff document

- Sessions die: they time out, run out of context or crash. So all state for a piece of work lives in SQLite, not inside a session.
- **Proposed:** each session appends to its handoff as it works (every decision, the reason for it, and what is still open), rather than writing a summary at the end. A dead session can't write its own handoff.
- **Proposed:** the overwatch can often get status by reading the babysitter's status table in SQLite, rather than messaging it.

### 7.4 Event flow for a review comment

1. A reviewer comments on a PR the factory owns.
2. The babysitter sees the comment and looks up the owning session in SQLite.
3. If that session is gone, the babysitter starts a new session and gives it the handoff document.
4. The session gives the comment a verdict and fixes, pushes back or escalates (section 6.5).
5. The session updates the evidence pack and the handoff, and the babysitter updates the PR's status.

&#91;embedded content: Review comment flow · 1 decision, 3 verdicts\]

A dead owner never blocks a comment: the babysitter starts a new session from the handoff. A pushback turns into a fix once the reviewer insists the set number of times.

### 7.5 Maintenance agent

**Decided:** a separate maintenance agent keeps the factory and the user's repositories healthy. Within the permissions the user grants, it handles drift and stale state on its own. It sits beside the overwatch and the babysitter and doesn't work on tickets.

| Job | What it does | Status |
| --- | --- | --- |
| Repair checks | Fixes or updates verification scripts that went stale as the repo changed | Proposed |
| Repo health | Runs the full suite on a schedule, so individual PRs don't have to | Proposed |
| Drift cleanup | Finds code that drifted from team conventions and opens small cleanup PRs | Proposed |
| Factory upkeep | Merges and prunes the lesson store so self-learning stays lean | Proposed |

Permissions follow the autonomy dial (section 4.1):

- **Low:** opens PRs for the user to approve.
- **High:** fixes low-risk drift and merges on its own.

This comes from lessons with FlowStack's "ready stamp", where:

- verification scripts went stale and broke
- checks needed the user's local services running
- even tiny PRs ran the whole suite

**Proposed fixes:**

- A broken check reports "check broken" instead of blocking the PR.
- Dependencies run in containers or as digital twins.
- A PR proves only its own change, with tests scaled to its risk. Repo health is the maintenance agent's job.

## 8. Open questions

- What does the setup wizard ask to work out a user's persona and starting mode?
- How many pushbacks before the factory defers to a reviewer? Is the number fixed or configurable?
- What rule separates a review comment that matters from noise?
- How exactly do the overwatch and babysitter communicate: shared tables, messages, or both?
- Which harnesses get supported first?
- What should the product be called?

## 9. Out of scope for now

- User-defined custom loops (the default loop comes first)
- The dashboard showing where every agent is (planned after chat)
- Final product name
