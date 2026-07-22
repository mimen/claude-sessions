# CCS managed session and subagent launches

This is the operational contract for creating Claude Code work through CCS. It covers human launches, native subagents, delegated Claude/GPT children, durable workers, and automation.

Architecture and rollout record: [mandatory-session-admission.html](./mandatory-session-admission.html).

## Core rule

Every **persistent Claude Code process** must be born through a CCS-managed path. Do not launch a nested persistent `claude`, `claude-native`, or `claude-gpt` process directly.

Non-persistent API/inference calls are not sessions and remain outside this contract.

CCS stores two independent facts:

- `session_class`: `work_body` or `auxiliary` — whether the session is independently managed and visible by default.
- creator provenance: `creator_kind`, `creator_ref`, and `launch_channel` — who caused the session and through which path.

`parent_session_id` means causal/cost ancestry only. It is not ownership, identity, grouping, or fork lineage.

## Choose the launch path

| Need | Use | Result |
|---|---|---|
| Short same-backend task inside the current Claude session | Native `Agent` tool | Native sidechain; CCS infers the transcript parent and hides it with auxiliary work |
| Full Claude Code helper using a canonical model/role seat | `ccs delegate` | Persistent auxiliary child with exact creator, route, and causal parent |
| Persistent supporting session without a seat | `ccs session new --child-of .` | Persistent auxiliary child whose spend rolls into the current session |
| New durable session Milad will manage independently | `ccs session new --top-level` | Root `work_body`; visible by default; no cost parent |
| Tiny classification/routing decision inside a script | Raw local gateway call | No Claude Code harness and no persistent session |
| Resume existing work | `ccs resume <selector>` or `ccs resume-session <id>` | Re-embodies the existing session; does not create a new birth |

## Canonical commands

### Delegated seat

Use this for reviews, implementation helpers, copywriters, and other full-harness work assigned to a registered seat:

```bash
ccs delegate <seat> \
  --child-of . \
  --cwd <absolute-target-directory> \
  --prompt '<bounded task>'
```

Use a seat's declared backup only as an explicit new launch:

```bash
ccs delegate <seat> --fallback \
  --child-of . \
  --cwd <absolute-target-directory> \
  --prompt '<bounded task>'
```

CCS never automatically retries a launched child. A retry or fallback is a separate auxiliary session because the first process may already have changed state.

### Supporting child without a seat

```bash
ccs session new \
  --child-of . \
  --cwd <absolute-target-directory> \
  --prompt '<task>'
```

Use this only when no canonical seat fits. Prefer `ccs delegate` when model, role, tools, or fallback behavior should be deterministic.

### Independently managed work body

```bash
ccs session new \
  --top-level \
  --cwd <absolute-target-directory> \
  --prompt '<task>'
```

An agent may create a top-level work body only when the new session is genuinely something Milad will manage directly. It has no causal/cost parent; `creator_ref` still records the launching session.

### Automation-created work

A daemon that makes repeated synchronous requests should reserve one stable top-level anchor. The anchor needs no Claude process or transcript of its own; CCS synthesizes it as a zero-self-cost root when rolling up indexed child costs:

```bash
ANCHOR_ID="$(
  CCS_CREATOR_KIND=automation \
  CCS_CREATOR_REF='<stable-job-or-daemon-id>' \
  ccs session new \
    --top-level \
    --cwd <absolute-target-directory> \
    --title '<automation name>' \
    --print-id
)"
```

Persist `ANCHOR_ID` in the daemon's own durable configuration. Each full-harness request is a synchronous delegated child:

```bash
CCS_CREATOR_KIND=automation \
CCS_CREATOR_REF='<same-stable-job-or-daemon-id>' \
ccs delegate <seat> \
  --child-of "$ANCHOR_ID" \
  --cwd <absolute-target-directory> \
  --prompt '<bounded request>'
```

The child records `creator_kind=automation` and the stable daemon id while `parent_session_id` independently points at the anchor for causal cost rollup. Creator environment variables are consumed for that one birth and removed before the child harness starts, so descendants are not misattributed to the daemon.

`CCS_CREATOR_KIND=automation` requires a non-empty `CCS_CREATOR_REF` and fails before reservation otherwise. Parentless hidden automation auxiliaries are not supported; use an anchor. An automation that genuinely needs a persistent root Claude process may omit `--print-id` and provide `--prompt` instead.

### Non-persistent micro-decision

For an in-script classification or routing decision, use the raw local gateway seam described in the global model-routing policy:

- endpoint: `http://127.0.0.1:8317/v1/messages`
- model: `gpt-5.6-luna(low)`
- key: `~/.cli-proxy-api-key`

This has no Claude Code harness, transcript, or CCS session. Prefer it over spawning `claude -p` for one small decision.

## Native Agent versus CCS delegate

Use the native `Agent` tool when all of these are true:

- same Claude backend is acceptable;
- the work is subordinate to the current turn/session;
- no independently resumable Claude Code process is needed;
- no canonical cross-provider seat is required.

Use `ccs delegate` when any of these are true:

- the child must use a specific Claude or GPT seat;
- the work should have its own persistent transcript and cost record;
- the child may need a different model, effort, tools, or fallback route;
- the task is long enough to deserve an independently inspectable execution.

The native `Agent` tool is not a replacement for seats. `ccs delegate` is not a replacement for cheap in-process fan-out.

## Prohibited patterns

Agents and automations must not create persistent children with:

```bash
claude ...
claude-native ...
claude-gpt ...
```

They must not shell-launch nested Claude/GPT harnesses to imitate `ccs delegate`, invent parent IDs, or assign `creator_kind` directly.

The installed shim blocks obvious unmanaged nested launches. Uncommon bypasses remain visible through the integrity doctor rather than being silently hidden or deleted.

## Visibility and lifecycle

- `work_body`: visible in normal CCS views.
- `auxiliary`: hidden by default; reveal with `u` in the TUI or `--auxiliary` in CLI views.
- Native subagent runs remain separately toggleable with `a`.
- Failed reservations and launches are retained as evidence; CCS does not delete or automatically retry them.
- Fork lineage uses `forked_from_session_id`, never `parent_session_id`.

## Diagnostics

```bash
ccs doctor sessions --json        # post-rollout unmanaged/missing-provenance findings
ccs ls --auxiliary                # include delegated/supporting children
ccs tree --auxiliary              # inspect causal parentage
ccs session <session-id> --json   # inspect one catalogue/index record
```

A clean doctor report means observed post-rollout persistent sessions have a management class and complete birth provenance. It is an integrity signal, not a hostile-code security guarantee.

## Current scope

Phase 1 is a managed birth registry and integrity monitor. It protects against accidental and policy-compliant session litter. It intentionally does not implement claim tokens, fail-closed SessionStart, cryptographic automation identity, arbitrary same-user bypass prevention, exhaustive Agent SDK enforcement, or a full launch-event state machine.
