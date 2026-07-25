# Skill Benchmark: new

**Skill**: `/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/ccs-new-router/plugins/ccs/skills/new/SKILL.md`
**Executor**: Sonnet override; exact model ID was not reported
**Date**: 2026-07-24
**Coverage**: 3 scenarios, 1 run per scenario per configuration

## Summary

| Metric | With skill | Without skill | Delta |
|---|---:|---:|---:|
| Deterministic assertion pass rate | 100% | 7% | +93 points |
| Offline agent wall time | 64.6s mean | 44.2s mean | +20.5s |
| Reported tokens | unavailable | unavailable | unavailable |

## Latency boundary

The agent wall-time comparison includes skill reading, tool orchestration, artifact writes, and the offline fixture. It is not production launcher latency.

A direct benchmark of the deterministic registry path, loading, parsing, and matching the real 30-location registry 1,000 times, completed in 1,265.944 ms total: **1.2659 ms per route**.

## Analyst notes

- The skill passed all 17 routing assertions across clear Mini placement, laptop-only placement, and material ambiguity.
- The baseline passed only the shared safety assertion that no forbidden launch command was used in the ambiguity case.
- That safety assertion is intentionally non-discriminating. It checks restraint, not skill lift.
- One run per scenario is enough for a bounded behavioral check, not a flake-rate claim.
- The evaluation used a copy of the production `SKILL.md` with a deterministic no-side-effect wrapper. It tested conversational routing and receipts without spawning a live session.
- Agent notifications did not report token counts, so the benchmark records them as unavailable rather than treating output characters as tokens.
