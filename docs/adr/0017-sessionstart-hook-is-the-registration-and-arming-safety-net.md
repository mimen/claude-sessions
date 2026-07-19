# The SessionStart hook is the registration + arming safety net (payload-authoritative, not env-var)

Completes the identity/arming family (ADR-0014 identity, 0015 arming, 0016
enumeration). Those make identity deterministic FOR SESSIONS ccs LAUNCHES. This ADR
covers everything else: a session started some other way (manual `claude`, a
`--resume` that bypassed ccs), and the "resumed dormant" case. Decided with Milad
2026-07-09 after confirming SessionStart hook mechanics against Claude Code docs.

## The reframe: the env-var fragility does NOT apply to a hook

Earlier ADRs flagged that in-session self-tagging (`ccs role . <x>`) silently no-ops
when `$CLAUDE_CODE_SESSION_ID` is unset. A SessionStart hook does NOT have this
problem: Claude Code passes the hook a stdin payload that includes `session_id`
directly, independent of any environment variable. The payload is authoritative. So a
hook always knows which session it is firing for — the exact thing the env-var-based
self-tag could not guarantee.

Confirmed hook facts (Claude Code docs):
- SessionStart stdin payload: `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `source` (`startup`|`resume`|`clear`|`compact`), and optionally
  `model`, `agent_type` (present when launched `--agent`), `session_title`.
- Fires on ALL starts (fresh, `--resume`/`--continue`, `--session-id`, `/clear`,
  compaction), gated by `source`.
- A hook is NON-INTERACTIVE (cannot prompt the user) BUT can emit `additionalContext`
  (text the agent sees before its first turn) and plain stdout also reaches the agent
  as context. No blocking.

## Decision — two jobs, gated by `source`

### Job 1: registration (all sources)
On every start the hook checks the catalogue for this `session_id`:
- **Registered** → silently refresh (touch/confirm role, resume_command). It has the
  id from the payload, so this always works — no env-var dependency.
- **Unregistered** (a session ccs did not launch) → the hook cannot ask the user
  directly, so it emits `additionalContext` instructing the AGENT to ask Milad its
  role/system and then self-register (`ccs role . <answer>` / `ccs system . <answer>`).
  The hook makes the agent ask; the human stays in control of labeling. This closes
  the one gap `ccs new-session` cannot: sessions born outside ccs.

### Job 2: arming safety net (source == resume)
If a loop session was resumed WITHOUT its command (e.g. someone ran a bare
`claude --resume`, bypassing `ccs resume`), the hook detects `source: resume` +
`resume_command` set (from ADR-0015) + the loop not running, and re-fires it (inject
the command as context / re-arm). This is belt-and-suspenders for arming: `ccs resume`
(ADR-0015) is the primary replay path; the hook catches resumes that bypassed ccs.

## Why both `ccs new-session` AND the hook

- `ccs new-session` (ADR-0014/0015) = deterministic identity + arming AT BIRTH for
  everything ccs launches. Primary. Correct before the process exists.
- SessionStart hook = the catch-all for what new-session can't see: foreign/manual
  sessions (register-or-ask) and resumes that bypassed ccs (re-arm). Payload-
  authoritative, so it never hits the env-var failure mode.

The two do not conflict: for an ccs-launched session the hook's registration is a
redundant refresh (a no-op confirmation); for a foreign session it is the only tagging
that happens.

## Consequences

- Every session, however it started, ends up registered — either at birth (ccs) or
  via the hook (ask-the-human). No untracked sessions accumulate silently.
- The env-var fragility is fully retired: identity/arming now flows through either the
  payload-authoritative hook or the id-at-birth launcher, never the fragile in-session
  `.`-resolution.
- A dormant resumed loop self-heals.
- The registration hook is a single GLOBAL SessionStart hook (in `~/.claude/settings.json`,
  like the worker Stop hook) — it must run for EVERY session to catch unregistered/foreign
  ones, so it is global by necessity and self-filters (a cheap no-op for sessions already
  registered / not ours). This is the one place self-filtering is inherent to the job. It
  does NOT preclude role-specific SessionStart hooks: those live in each role dir and MERGE
  with this global one — hooks stack across scopes, all fire (ADR-0018). So a role's own
  arming runs alongside global registration, not instead of it. Must be fast and fail-open
  (ADR-0035) — never block session start.
- `agent_type` / `cwd` in the payload MAY let the hook infer a role without asking (a
  per-role directory, ADR-0018, makes cwd a reliable role hint) — an optimization, not
  required.
