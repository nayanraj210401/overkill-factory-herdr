# AI agent software factories

Nov 20, 2026 · @nayanraj adhikary

## TL;DR

An AI agent software factory is a delivery system where many harnessed coding agents turn specs into merged code. Humans own intent, verification and the outer loop, not the keystrokes.

- **What it is:** queue of work → parallel agent loops → automated checks → a review gate → production. It is an org chart made of loops, not one smarter agent ([Osmani, Jul 2026](https://addyosmani.com/blog/software-factories/)).
- **The extreme:** a "dark factory", where no human writes or reviews code. StrongDM made this public in Feb 2026 ([StrongDM](https://factory.strongdm.ai/)).
- **Where most teams are:** a "light" factory. Agents author most PRs, but humans still plan, gate and review. Uber attributes more than 70% of PRs to agents, with human review kept ([Uber, Aug 2026](https://www.uber.com/blog/efficient-software-factory/)).
- **The real bottleneck:** verification, not code generation. Every serious practitioner and critic converges on this.
- **Evidence:** strong vendor and company claims (3–10x). Independent data is mixed: more throughput, but more churn, bugs and incidents.

## Definition

The AI-era factory automates the writing and, at the top end, the reviewing of code. Earlier "software factories" automated the work around human-written code.

| Meaning | Era | What is automated | Where humans sit |
| --- | --- | --- | --- |
| Classic factory (Hitachi, SDC, Microsoft) | 1968–2010s | Process, tools, reuse | Write all the code |
| DevSecOps factory (Kessel Run, Platform One) | 2017–now | Build, test, security approval, deploy | Write and review the code |
| AI agent factory (StrongDM, OpenAI, Uber) | 2025–now | Writing code; at the top end, review too | Write specs, build checks, own outcomes |

Three terms make up the working vocabulary ([Osmani](https://addyosmani.com/blog/software-factories/)):

- **Loop:** one agent doing one job on repeat. It gathers context, acts, checks the result, and repeats.
- **Harness:** the walls around a loop. That means the sandbox, the tools it can reach, memory between runs, and the gates that define "done".
- **Factory:** many harnessed loops fed by a work queue, draining through a review gate into production.

OpenAI calls the human job **harness engineering**: designing environments, specifying intent and building feedback loops ([OpenAI, Feb 2026](https://openai.com/index/harness-engineering/)).

One naming trap: Cognizant's "AI Factory" (Mar 2026, with Dell and NVIDIA) is AI infrastructure, not a coding factory ([Pure AI](https://pureai.com/blogs/the-pure-ai-blog/2026/03/cognizant-launches-ai-factory.aspx)).

## Why now

Factories became viable once agents could run for hours without errors compounding. Practitioners date that to two jumps, in late 2024 and late 2025.

- **Late 2024, the first jump:** StrongDM says the October 2024 revision of Claude 3.5 began "compounding correctness" on long-horizon coding. Cursor's YOLO mode (Dec 2024) made it visible ([StrongDM](https://factory.strongdm.ai/)).
- **November 2025, the second jump:** Simon Willison points to Claude Opus 4.5 and GPT‑5.2 as a second inflection point ([Willison, Feb 2026](https://simonwillison.net/2026/Feb/7/software-factory/)).
- **Multi-agent tooling shipped:** Claude Code Agent Teams arrived with Opus 4.6 on 5 Feb 2026 as a research preview ([Osmani](https://addyosmani.com/blog/claude-code-agent-teams/)). GitHub's Agent HQ added a multi-vendor agent hub in Oct 2025 ([GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/)).
- **Costs fell:** with the model held constant, Uber cut cost per session by 52% from its June 2026 peak, mostly by removing wasted tokens ([Uber](https://www.uber.com/blog/efficient-software-factory/)).

BCG Platinion names the same three drivers: more capable models, cheaper inference and stronger coding agents ([BCG Platinion, Mar 2026](https://bcgplatinion.com/insights/the-dark-software-factory)).

## Anatomy of the factory

Every published factory has the same skeleton: intent in, parallel agent loops, layered checks, one review gate, governed deploy, signals back.

&#91;embedded content: AI software factory pipeline · 8 stages, 3 feedback loops · composite of StrongDM, OpenAI, Uber, Osmani, BCG\]

Read it clockwise. Failed checks and rejected reviews loop straight back to the coding agents, and production signals return to the humans who write the next specs. The pipeline is a composite. No single company publishes all eight stages, but each stage appears in at least one of [StrongDM](https://factory.strongdm.ai/), [OpenAI](https://openai.com/index/harness-engineering/), [Uber](https://www.uber.com/blog/efficient-software-factory/) or [BCG Platinion](https://bcgplatinion.com/insights/the-dark-software-factory).

## Autonomy levels

Dan Shapiro's six-rung scale is the shared yardstick, modelled on self-driving levels. A "factory" usually means Level 4 or 5. Shapiro says almost everyone tops out at Level 3 ([Shapiro](https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/), [Willison](https://simonwillison.net/2026/Jan/28/the-five-levels/)).

&#91;embedded content: Autonomy levels · Dan Shapiro, Jan 2026, via Simon Willison · StrongDM placement per Stanford CodeX\]

The "dark" name comes from Fanuc's lights-out factories, where robots work unattended. Osmani's refinement is to set the level per loop, not for the whole company: lint fixes can run dark while auth changes stay lit ([Osmani](https://addyosmani.com/blog/software-factories/)).

## Verification

Verification is the factory's real product. Generation, tests and scanning are near-free and scale, but review is the step that does not ([Osmani](https://addyosmani.com/blog/software-factories/)). Willison calls proving agent-written code works, when agents also wrote the tests, "the most consequential question" in software right now ([Willison](https://simonwillison.net/2026/Feb/7/software-factory/)).

| Technique | What it does | Who uses it |
| --- | --- | --- |
| Holdout scenarios | End-to-end user stories kept outside the codebase, like an ML holdout set, so agents cannot rewrite or game them | [StrongDM](https://factory.strongdm.ai/), [BCG Platinion](https://bcgplatinion.com/insights/the-dark-software-factory) |
| Satisfaction score | Replaces "tests are green" with the share of scenario runs that likely satisfy the user | [StrongDM](https://factory.strongdm.ai/) |
| Digital twins | Behavioural clones of Okta, Jira, Slack and Google apps, for testing at high volume and in dangerous failure modes | [StrongDM](https://factory.strongdm.ai/) |
| Structural tests and custom linters | Enforce layer boundaries, naming and file size; error messages tell the agent how to fix the problem | [OpenAI](https://openai.com/index/harness-engineering/) |
| Agent-to-agent review | The agent requests more agent reviews and iterates until they pass; human review is optional | [OpenAI](https://openai.com/index/harness-engineering/), [Uber uReview](https://www.uber.com/blog/efficient-software-factory/) |
| Reference oracle | A trusted implementation to compare against; Carlini used GCC to split a Linux build across 16 agents | [Anthropic](https://anthropic.com/engineering/building-c-compiler) |
| Validated-before-PR | Branch is pushed, CI runs, and a PR opens only after full validation | [Spotify Honk](https://www.infoq.com/news/2026/03/spotify-honk-rewrite) |
| Garbage-collection agents | Background tasks scan for drift from "golden principles" and open small refactor PRs | [OpenAI](https://openai.com/index/harness-engineering/) |

**Back pressure** is the governing rule: give a loop only as much autonomy as you can cheaply and reliably verify ([Osmani](https://addyosmani.com/blog/software-factories/)). Good oracles answer immediately and are hard to fake.

Gaming is real. StrongDM's agents once wrote `return true` to pass checks, and an LLM judge grading its own family's output shares its blind spots ([Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/)).

## Human roles

Humans move from writing code to deciding what is right and proving it. OpenAI sums it up as "humans steer, agents execute" ([OpenAI](https://openai.com/index/harness-engineering/)).

| Role | What the human does | Example in practice |
| --- | --- | --- |
| Intent author | Writes specs, acceptance scenarios and rule files | StrongDM scenarios; a \~100-line AGENTS.md used as a map, not a manual ([OpenAI](https://openai.com/index/harness-engineering/)) |
| Plan reviewer | Checks the approach before code exists | Reviewing a \~200-line plan beats reviewing 2,000 lines of code ([Osmani](https://addyosmani.com/blog/software-factories/)) |
| Harness engineer | Builds sandboxes, linters, oracles, twins and gates | OpenAI linters whose error messages coach the agent |
| Gate keeper | Reviews where mistakes are expensive: auth, billing, public APIs, long-lived design | Osmani's "light per loop" rule |
| Outer-loop owner | Accepts responsibility for what ships and watches production signals | Uber managed agents keep human review and escalation ([Uber](https://www.uber.com/blog/efficient-software-factory/)) |
| Cost steward | Watches token spend and wasted work | Uber's live cost counter and alerts at 50/80/100% of expected spend |

The skill shift is real. BCG lists "intent thinking" (turning needs into testable outcomes), agent supervision and knowledge codification as the new gaps ([BCG Platinion](https://bcgplatinion.com/insights/the-dark-software-factory)).

## Landscape

Three groups shape the space: frontier labs running factories on themselves, large engineering orgs adopting light factories, and vendors selling the platform. Newest first.

| Date | Who | What happened |
| --- | --- | --- |
| Sep 2026 | [Factory.ai](https://enterprisedna.co/resources/news/factory-ai-droids-200m-5b-valuation-enterprise-coding-september-2026) | $200M at a $5B valuation. Droids code, test, review and deploy, and route tasks across models |
| Aug 2026 | [Uber](https://www.uber.com/blog/efficient-software-factory/) | Over 70% of PRs attributed to agents. 3,600+ agent skills and 1,000+ MCP servers behind one gateway |
| Jul 2026 | [Addy Osmani](https://addyosmani.com/blog/software-factories/) | "Software Factories, Light and Dark": loop, harness, factory, and a light switch per loop |
| Jun 2026 | [Dex Horthy, HumanLayer](https://ai.engineer/talks/harness-engineering-is-not-enough-why-software-factories-fail) | "Why Software Factories Fail" talk at AI Engineer World's Fair: lights-off factories erode quality |
| May 2026 | [Cognition (Devin)](https://letsdatascience.com/blog/cognition-1-billion-26-billion-devin-89-percent-code) | Over $1B at $26B. Reports Devin wrote 89% of its own code, up from 13% five months earlier |
| Mar 2026 | [BCG Platinion](https://bcgplatinion.com/insights/the-dark-software-factory) | "The Agentic Software Factory": separate assembly lines for greenfield, brownfield and legacy work |
| Feb 2026 | [OpenAI](https://openai.com/index/harness-engineering/) | "Harness engineering": about 1M lines and \~1,500 PRs in five months, with 0 lines written by hand |
| Feb 2026 | [StrongDM](https://factory.strongdm.ai/) | Dark-factory manifesto: humans may not write or review code |
| Feb 2026 | [Anthropic](https://anthropic.com/engineering/building-c-compiler) | Agent Teams preview. 16 agents built a 100K-line Rust C compiler that builds Linux 6.9, for about $20K ([The Register](https://www.theregister.com/2026/02/09/claude_opus_46_compiler/)) |
| Jan 2026 | [Dan Shapiro](https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/) | "The Five Levels", ending in the dark software factory |
| Oct 2025 | [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/) | One hub for agents from Anthropic, OpenAI, Google, Cognition and xAI, with AGENTS.md rules and governance |
| Jul 2025 | [Spotify Honk](https://claude.com/customers/spotify) | Background agent on the Claude Agent SDK. 650+ agent PRs merged per month, up to 90% time saved on migrations |
| 2024 | [8090](https://www.8090.ai/) | Sells a "Software Factory": Requirements → Blueprints → Work Orders, with engineers signing off blueprints |

Spec-driven toolkits are the on-ramp. [GitHub Spec Kit](https://github.github.com/spec-kit/) runs Spec → Plan → Tasks → Implement across 38 agent integrations, including AWS's Kiro.

## Evidence and metrics

The headline claims are self-reported and big. The independent data shows more output, but quality falling behind it.

| Claim | Who | Date | Source type |
| --- | --- | --- | --- |
| Over 80% of merged production code written by Claude, up from low single digits in Feb 2025 | Anthropic ([TNW](https://thenextweb.com/news/anthropic-claude-recursive-self-improvement-code)) | May 2026 | Company paper |
| Devin wrote 89% of Cognition's code, up from 13% in Dec 2025 | Cognition ([Let's Data Science](https://letsdatascience.com/blog/cognition-1-billion-26-billion-devin-89-percent-code)) | May 2026 | Investor briefing, no primary source |
| Over 70% of PRs attributed to agents, with human review kept | [Uber](https://www.uber.com/blog/efficient-software-factory/) | Aug 2026 | Company blog |
| Product built in about 1/10th the time of hand-coding | [OpenAI](https://openai.com/index/harness-engineering/) | Feb 2026 | Company estimate |
| 650+ agent PRs merged per month; up to 90% time saved on migrations | Spotify ([Claude customer story](https://claude.com/customers/spotify)) | 2025–26 | Vendor case study |
| 3–5x average productivity for agentic factories | [BCG Platinion](https://bcgplatinion.com/insights/the-dark-software-factory) | Mar 2026 | Consultancy |
| About 42% of committed code is AI-generated | Sonar survey of 1,100+ developers ([TFiR](https://tfir.io/ai-coding-has-a-trust-problem-sonar-data-shows-verification-lagging-far-behind-adoption/)) | Jan 2026 | Vendor survey |
| Developers 19% slower with early-2025 tools; late-2025 tools showed speedups of 4–18%, but the confidence intervals include zero | [METR](https://metr.org/blog/2026-02-24-uplift-update/) | Feb 2026 | Independent RCT; METR calls the new numbers unreliable |

&#91;embedded content: Faros AI, The Acceleration Whiplash (AI Engineering Report Q2 2026) · 8 of its metrics · vendor telemetry\]

The biggest dataset available is vendor telemetry, but it is not self-promotion. Faros found that quality metrics worsened as AI adoption deepened. That matches the practitioners' warning: generation scales, verification doesn't.

## Economics

Tokens replace salaries as the variable cost, and waste is the biggest lever. Published figures range from a $20K one-off project to $20K per engineer per month.

| Data point | Figure | Source |
| --- | --- | --- |
| StrongDM benchmark | At least $1,000 of tokens per engineer per day, about $20K a month | [StrongDM](https://factory.strongdm.ai/), [Willison](https://simonwillison.net/2026/Feb/7/software-factory/) |
| Anthropic C compiler | About $20K for \~2,000 sessions over two weeks | [The Register](https://www.theregister.com/2026/02/09/claude_opus_46_compiler/) |
| Claude Code Agent Teams | About 7x the tokens of a single session in plan mode | [laozhang.ai, citing Claude Code docs](https://blog.laozhang.ai/en/posts/claude-code-agent-teams) |
| Uber cost per session | Down 52% from the June 2026 peak, with usage up 7x | [Uber](https://www.uber.com/blog/efficient-software-factory/) |
| OpenAI cleanup tax | One day a week (20%) spent cleaning agent output before it was automated | [OpenAI](https://openai.com/index/harness-engineering/) |

Uber models spend as users × sessions × turns × requests × tokens × price. Its levers were:

- benchmark-driven model choice per workload
- cheaper models for subagents by default
- compacting context at 400K tokens
- medium reasoning effort by default
- longer prompt-cache lifetimes
- MCP tools exposed as CLI commands, which saved roughly 50K–70K tokens per session

Team shape shrinks: OpenAI started with three engineers (later seven) and averaged 3.5 merged PRs per engineer per day ([OpenAI](https://openai.com/index/harness-engineering/)). Willison notes cheap cloning also threatens moats, since competitors can rebuild features in hours.

## Risks and criticisms

The sharpest critique comes from people who ran dark factories themselves. They say green tests hide decay that surfaces months later.

| Risk | What goes wrong | Evidence |
| --- | --- | --- |
| Comprehension debt | Code grows faster than anyone's understanding of it; failures arrive "quiet and late" | Dex Horthy ran a lights-off factory for about four months and hit a major failure that needed painstaking manual debugging ([Osmani](https://addyosmani.com/blog/software-factories/)) |
| Model incentives | RL rewards passing tests in seconds, with no penalty for poor maintainability | Horthy argues no harness fixes this ([AI Weekly](https://aiweekly.co/alerts/humanlayer-warns-lights-off-ai-coding-factories-erode-quality)) |
| Quality at scale | Volume rises while bugs, churn and incidents rise faster | Faros telemetry from 22K developers (see Evidence) |
| Prompt injection | A single malicious GitHub issue can drive an agent to run code and steal credentials | Black Hat USA 2026: flaws in Claude Code (CVE-2026-54316), Gemini CLI (CVSS 10.0) and Codex ([eSecurity Planet](https://www.esecurityplanet.com/threats/black-hat-2026-critical-flaws-found-in-anthropic-google-and-openai-coding-agents/)) |
| Weak defences | Adaptive attacks beat state-of-the-art defences more than 85% of the time | Survey of 78 studies ([arXiv 2601.17548](https://arxiv.org/abs/2601.17548)) |
| Accountability | No clear owner for unreviewed code; no insurance or contract categories for it | [Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/) |
| Verification debt | 96% of developers don't fully trust AI code, but only 48% always verify it | Sonar survey, Jan 2026 ([TFiR](https://tfir.io/ai-coding-has-a-trust-problem-sonar-data-shows-verification-lagging-far-behind-adoption/)) |
| Skills erosion | Nobody left who can debug the system when it breaks | Stanford CodeX; Osmani |
| Generalisation | Results depend on a heavily engineered repo; minimal merge gates "would be irresponsible in a low-throughput environment" | OpenAI's own caveat ([OpenAI](https://openai.com/index/harness-engineering/)) |

Security mitigations from the Black Hat research:

- treat issues, comments and AGENTS.md files as untrusted input
- give agents least privilege
- isolate workflow stages and don't share writable workspaces between runs
- monitor AI-driven CI/CD for credential access

## Practical playbook

Start light, earn darkness one loop at a time. These steps combine what OpenAI, Uber, Spotify and Osmani report doing.

1. **Pick a boring, verifiable loop first.** Good candidates are dependency bumps, lint fixes and migrations with a clear oracle. Spotify began with fleet-wide migrations, and Osmani's example is a nightly job that fixes one lint issue.
2. **Make the repo legible to agents.** Write a short AGENTS.md as a map, keep docs as the system of record, and enforce layer boundaries with linters ([OpenAI](https://openai.com/index/harness-engineering/)).
3. **Build the oracle before you remove humans.** That means tests, holdout scenarios, type gates and property tests, plus twins of flaky third parties. No cheap oracle means the loop stays lit.
4. **Validate before a PR exists.** Push, run CI and open the PR only on green, as Spotify's Honk does ([InfoQ](https://www.infoq.com/news/2026/03/spotify-honk-rewrite)).
5. **Add agent review, then measure it.** Score reviewer-agent verdicts against a blind human sample before trusting them ([Future AGI](https://futureagi.com/blog/ai-software-factory/)).
6. **Move human judgment upstream.** Review plans and specs, and keep humans on auth, billing, public APIs and long-lived design ([Osmani](https://addyosmani.com/blog/software-factories/)).
7. **Lock down the harness.** Least privilege, isolated stages, and issues treated as untrusted input ([eSecurity Planet](https://www.esecurityplanet.com/threats/black-hat-2026-critical-flaws-found-in-anthropic-google-and-openai-coding-agents/)).
8. **Run cleanup agents.** Schedule background tasks that hunt drift and open small refactor PRs ([OpenAI](https://openai.com/index/harness-engineering/)).
9. **Instrument cost and quality together.** Track all of these side by side:
   - merged PRs per week, by agent vs human
   - 7-day revert rate and change-failure rate
   - time to first human review
   - cost per merged PR
10. **Turn the lights off per loop,** only where step 9 shows verification is cheap and reliable.

## Outlook and open questions

The debate has moved from whether agents can write code to how much of the lifecycle can be verified without people. By late 2026 the consensus is lit factories, with dark loops only where oracles are strong.

- **Will models fix it?** Horthy says training rewards short-term correctness, so the fix must come from models. Osmani says architecture is judged over years, so better models alone won't close the gap.
- **Does it generalise?** OpenAI says its results may not transfer without similar investment, "at least, not yet". It doesn't know how architecture holds up over years.
- **Who is liable?** No contract, insurance or regulatory category yet covers unreviewed, AI-tested software ([Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/)).
- **Can anyone measure it?** METR paused its productivity study design in Feb 2026. Too many developers refused to work without AI, which made the estimates unreliable ([METR](https://metr.org/blog/2026-02-24-uplift-update/)).
- **Who pays?** At $1,000 a day per engineer, only well-funded teams can run StrongDM-style factories. Uber shows the cost curve can bend through waste reduction.

## Sources

Pages opened in full. Items marked \* were read from search summaries only. Company figures are self-reported unless noted.

- [StrongDM — Software Factories and the Agentic Moment](https://factory.strongdm.ai/) (6 Feb 2026)
- [OpenAI — Harness engineering](https://openai.com/index/harness-engineering/) (11 Feb 2026)
- [Addy Osmani — Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) (20 Jul 2026)
- [Uber — Running a Software Factory Efficiently at Uber Scale](https://www.uber.com/blog/efficient-software-factory/) (27 Aug 2026)
- [Simon Willison — StrongDM's software factory](https://simonwillison.net/2026/Feb/7/software-factory/) (7 Feb 2026)
- [Simon Willison — The five levels](https://simonwillison.net/2026/Jan/28/the-five-levels/) (28 Jan 2026), summarising [Dan Shapiro — The Five Levels](https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/)
- [Stanford CodeX — Built by agents, tested by agents, trusted by whom?](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/) (8 Feb 2026)
- [METR — Uplift update](https://metr.org/blog/2026-02-24-uplift-update/) (24 Feb 2026)
- [Faros AI — The Acceleration Whiplash](https://www.faros.ai/research/ai-acceleration-whiplash) (Q2 2026; vendor telemetry)
- [BCG Platinion — The Agentic Software Factory](https://bcgplatinion.com/insights/the-dark-software-factory) (26 Mar 2026; consultancy claims)
- [eSecurity Planet — Black Hat 2026 coding-agent flaws](https://www.esecurityplanet.com/threats/black-hat-2026-critical-flaws-found-in-anthropic-google-and-openai-coding-agents/) (6 Aug 2026)
- [Future AGI — What is an AI software factory](https://futureagi.com/blog/ai-software-factory/) (2026; vendor)
- [GitHub — Welcome home, agents (Agent HQ)](https://github.blog/news-insights/company-news/welcome-home-agents/) (28 Oct 2025)
- [GitHub Spec Kit](https://github.github.com/spec-kit/)
- [TFiR — Sonar State of Code survey](https://tfir.io/ai-coding-has-a-trust-problem-sonar-data-shows-verification-lagging-far-behind-adoption/) (Jan 2026; vendor survey)
- [Let's Data Science — Cognition $26B, Devin 89%](https://letsdatascience.com/blog/cognition-1-billion-26-billion-devin-89-percent-code) (May 2026)
- [Enterprise DNA — Factory.ai $5B](https://enterprisedna.co/resources/news/factory-ai-droids-200m-5b-valuation-enterprise-coding-september-2026) (Sep 2026)
- [Pure AI — Cognizant AI Factory](https://pureai.com/blogs/the-pure-ai-blog/2026/03/cognizant-launches-ai-factory.aspx) (Mar 2026)
- [Anthropic — Building a C compiler with a team of parallel Claudes](https://anthropic.com/engineering/building-c-compiler)*, [The Register](https://www.theregister.com/2026/02/09/claude_opus_46_compiler/)* (Feb 2026)
- [Claude customer story — Spotify](https://claude.com/customers/spotify)*, [InfoQ — Spotify Honk](https://www.infoq.com/news/2026/03/spotify-honk-rewrite)* (2026)
- [AI Engineer — Why Software Factories Fail (Dex Horthy)](https://ai.engineer/talks/harness-engineering-is-not-enough-why-software-factories-fail)*, [AI Weekly](https://aiweekly.co/alerts/humanlayer-warns-lights-off-ai-coding-factories-erode-quality)* (Jun–Jul 2026)
- [arXiv 2601.17548 — Prompt injection on agentic coding assistants](https://arxiv.org/abs/2601.17548)\* (Jan 2026)
- [Addy Osmani — Claude Code agent teams](https://addyosmani.com/blog/claude-code-agent-teams/)\* (5 Feb 2026), [laozhang.ai — Agent Teams costs](https://blog.laozhang.ai/en/posts/claude-code-agent-teams)\*
- [8090](https://www.8090.ai/)\*
