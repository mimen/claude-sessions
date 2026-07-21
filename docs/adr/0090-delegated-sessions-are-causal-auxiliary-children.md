# ADR-0090: Delegated sessions are causal auxiliary children

**Status:** accepted (2026-07-20)
**Scope:** ccs session catalogue, delegation, visibility, and cost accounting

## Context

Claude Code's native Agent tool records subagents as sidechains beneath the parent transcript. Cross-backend seat definitions instead launched nested `claude-native -p` or `claude-gpt -p` processes. Those processes produced ordinary root transcripts: they had no durable causal parent, appeared beside independent work sessions, and their costs could not be attributed to the session that requested the work.

Provider is not the distinction. A GPT-backed session can be a deliberately managed top-level work body, while a Claude-backed session can be an implementation-detail helper. Likewise, archive/completion state cannot represent presentation visibility: those fields retire work and affect resume behavior.

## Decision

### Session class

Add a nullable first-class catalogue field:

```text
session_class = work_body | auxiliary | null
```

- `work_body` is independently managed work and is visible by default.
- `auxiliary` is work spawned to serve another session. It is hidden by default but remains directly inspectable and resumable when auxiliary rows are explicitly revealed.
- `null` preserves legacy and plain-Claude sessions. It never implies auxiliary.

Tags may mirror the class for discovery, but the typed field governs behavior.

### Explicit creation intent

Every `ccs session new` invocation declares exactly one mode:

```bash
ccs session new --top-level ...
ccs session new --child-of <session-uuid|.> ...
```

`--top-level` writes `work_body` with no causal parent. `--child-of` writes `auxiliary` and a causal parent before Claude starts. `.` resolves through `CLAUDE_CODE_SESSION_ID`. Missing or conflicting intent fails before a UUID or catalogue row is created.

Plain `claude` remains outside this creation contract; newly observed null-class sessions stay visible and receive an unclassified warning.

### Parent semantics

`parent_session_id` means:

> This session was causally spawned by that session, and its execution cost belongs to that parent.

It does not represent cluster membership, durable identity, grouping, portfolio ownership, fork history, or organizational authority. Those relationships use their dedicated fields and entities.

### Delegation boundary

`ccs delegate` is the stable launch interface for Claude and GPT seats. It:

1. loads one canonical seat definition;
2. validates the seat, provider/model, parent, cwd, and prompt;
3. reserves an auxiliary child and its causal edge before launch;
4. compiles the seat to process-local Claude Code `--agents` JSON;
5. invokes `claude-native` or `claude-gpt` with `--agent`, `--agents`, `--session-id`, and `-p` using argument arrays;
6. runs synchronously and preserves stdout, stderr, and exit status.

The child receives the full Claude Code environment. `--bare` and `CLAUDE_CODE_SUBAGENT_MODEL` are not used. A launch failure leaves a zero-cost auxiliary record with failure metadata rather than deleting the evidence.

Canonical delegated seat definitions live outside auto-discovered `.claude/agents` paths. Native same-provider sidechains may later optimize the implementation behind `ccs delegate`, but they do not change its contract.

### Visibility

Flat list, search, and tree views hide auxiliary rows by default. TUI key `u` and CLI flag `--auxiliary` reveal them for the current invocation only. Revealed rows carry an `AUX` badge. Auxiliary visibility is independent from archive filtering.

### Cost

Per-session cost exposes physical self cost and recursive execution total. The recursive closure traverses the union of:

- native Agent-tool sidechain edges from the transcript index;
- causal auxiliary edges from the catalogue.

Traversal is alias-aware, cycle-safe, recursive, and deduplicates a physical transcript reachable through both edge sources. Hidden descendants still contribute to the parent's total. Provider-family breakdown comes from observed served-model usage, not launcher intent. Store-wide spend remains the direct sum of physical transcript rows; rolled-up totals are never summed as independent spend.

## Consequences

- Delegated helpers no longer crowd normal CCS views.
- Independently launched GPT sessions remain visible when explicitly created as top-level work.
- Parent assignment is deterministic enough for recursive cost ownership.
- Archive and completion retain lifecycle meaning.
- Legacy ambiguity remains visible rather than being hidden by speculative migration.
- Historical detached children require a separate evidence-based report and reviewed exact-only backfill; the report alone never authorizes automatic mutation. The manifest-pinned `ccs historical-backfill detached-children` command is dry-run first, transactional, audited, idempotent, and rejects conflicts rather than overwriting newer catalogue truth.

## Deferred

- Agent-view-backed background supervision: status, logs, send/reply, stop, respawn, and attach/resume.
- Matching-provider execution through the native Agent tool behind the same delegation interface.
- Generic execution records for Grok, agy, and other non-Claude-Code substrates.
