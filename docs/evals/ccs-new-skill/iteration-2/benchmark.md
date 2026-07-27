# Skill Benchmark: new

**Skill**: `/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/ccs-new-router/plugins/ccs/skills/new/SKILL.md`
**Executor**: `gpt-5.6-luna` through the Agent sonnet-alias evaluation route
**Date**: 2026-07-24
**Coverage**: 6 scenarios, 1 clean run per scenario per configuration

## Summary

| Metric | With skill | Without skill | Delta |
|---|---:|---:|---:|
| Deterministic assertion pass rate | 100% (36/36) | 13.9% (5/36) | +86.1 points |
| Offline agent wall time | 141.3s mean | 69.4s mean | +72.0s |
| Reported tokens | unavailable | unavailable | unavailable |

## Coverage added in iteration 2

- preferred Mini placement versus the match call's current validation host;
- browser-auth and local-user-state capability forwarding;
- material location ambiguity without early launch;
- exact current-worktree preservation and no ephemeral registration;
- post-success registration ordering for an explicit path;
- hostile prompt isolation through structured staging with no shell interpolation;
- exact local and pending-remote receipt contracts.

## Analyst notes

- The skill passed all 36 assertions. The baseline passed five restraint-only assertions and none of the managed birth contracts.
- Evaluation surfaced two useful prompt-contract clarifications during iteration: candidate `host` is not the placement recommendation, and remote receipts report only the receipt fields. Both were added before the clean scored runs.
- The deterministic fixture creates no real CCS session. Production behavior is independently covered by the 1,063-test CCS suite, including fake-`CMUX_BIN` end-to-end local receipt tests and source/target remote route forwarding tests.
- The first parallel attempt was discarded because sibling agents inherited one `CLAUDE_SESSION_ID` and collided in prompt staging. Clean runs used unique synthetic IDs.
- Agent wall time includes skill reading, orchestration, and artifact writes. The measured production `ccs location match` path averages about 138 ms, with a 168 ms observed maximum in the 10-sample benchmark.
- Agent notifications exposed no token totals. Output characters were not substituted as token counts.
