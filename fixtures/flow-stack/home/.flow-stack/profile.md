---
profile_version: 1
preset: solo-hacker                      # the preset this profile started from
attention:
  review_minutes_per_day: 45      # delegate and tour respect this
  max_parallel_agents: 2          # delegate never runs more workers than this
budget:
  build_model: sonnet             # implementation workers
  handoff_at_context_pct: 60
---

# Who
- Role: Solo Hacker

# Rules
<!-- Hard constraints. -->
- Never push, merge, deploy, or publish without asking.
- Never run destructive database operations without asking.

# Taste
## Code
- 2026-10-02 · small functions, no comments that restate the code · src: review of #12
- 2026-10-09 · prefer early returns · src: reflect
## Prose
- 2026-10-11 · terse, answer first · src: reflect

# Calibration
<!-- Written by reflect from TRACE estimate-vs-actual rows. Don't hand-edit. -->
| task type | tasks | avg $ err | avg ctx err | avg minutes err |
|---|---|---|---|---|
| feature | 3 | +60% | +10% | +20% |
| bug | 2 | +15% | 0% | -5% |

# Taste history
