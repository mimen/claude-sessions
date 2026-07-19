# Hook failure contract — fail-open, mark the session degraded, self-heal; hook context is advisory

ADR-0017 (SessionStart = registration + arming) and ADR-0029 (each role owns its upkeep
via hooks) lean heavily on hooks that call ccs. Both design reviews asked the unanswered
question: what happens when ccs is slow, unavailable, or errors at the moment a hook
fires? A hook that blocks or crashes on a ccs hiccup would wedge session startup — the
opposite of the determinism this design promises. This ADR pins the failure contract.
Decided with Milad 2026-07-09.

## Decision — fail-open, flag degraded, self-heal

A ccs-backed hook NEVER blocks or breaks the session. Concretely:

1. **Fail-open.** If a hook can't reach ccs (down, slow past budget, errors), it logs and
   exits 0. The session ALWAYS starts / the turn ALWAYS proceeds. ccs being unavailable is
   never able to prevent a Claude session from running.
2. **Timeout budget.** Each hook has a hard budget (~2s) for its ccs call. Past the budget
   it gives up and fails-open rather than hanging the session on a wedged ccs.
3. **Mark degraded.** A session that started WITHOUT completing its registration/arming is
   recorded as `degraded` (unregistered / un-armed) — as soon as ccs is reachable enough to
   record even that, or on the next hook that does reach ccs. The TUI surfaces it (⚠
   degraded) so you can SEE which sessions didn't wire up correctly, instead of a silent
   half-armed session masquerading as fine.
4. **Self-heal.** Registration/arming retries on the next natural trigger — the next turn's
   hook, the next control/scout tick, the next `resume`. A degraded session that later
   completes its hook clears the flag automatically. No manual repair for the common
   transient case.

This is "fail-open + explicit degraded flag" (Milad 2026-07-09), chosen over "block on
critical hooks": a ccs outage must not stop you from working in a session, and a visible
degraded marker gives the determinism guarantee its teeth (you know when a session is not
fully wired) without making ccs a startup dependency.

## Hook-injected context is ADVISORY, not authoritative

ADR-0017's SessionStart can inject `additionalContext` (e.g. "you're unregistered, ask
your role"). A subtlety both reviews raised: a hook cannot truly converse or force
behavior — injected context is a PROMPT the agent may or may not act on, so anything whose
correctness depends on the agent obeying injected text is NOT deterministic.

Therefore:
- **Deterministic re-arming does NOT rely on injected context.** A loop comes back running
  because `resume-session` replays its `resume_command` (ADR-0015) — a mechanical
  invocation — not because a hook asked the agent to restart its loop. Injected context is
  at most a belt-and-suspenders nudge on top of the mechanical path.
- **Injected context is for the genuinely conversational case only** — an unregistered
  foreign session asking the human what role it should be. That's inherently interactive
  and can't be mechanical, so advisory context is the right (and only) tool there.
- The rule: if something must happen reliably, it's a mechanical ccs verb (replay,
  materialize, deliver), not a sentence injected into the model.

## Cosmetic vs. structural hooks

- **Structural** (registration, arming): fail-open + degraded flag as above.
- **Cosmetic** (statusline render, tab paint): fail-open silently — render `unknown` / an
  empty phase rather than hang or error. A display that can't reach ccs shows "unknown,"
  never a stale value asserted as current (ties to ADR-0031's `updated_at` + the staleness
  rendering the display uses).

## Consequences

- ccs is never a hard dependency for a session to run; determinism is delivered by
  mechanical replay + a visible degraded state, not by blocking hooks.
- The TUI needs a `degraded` indicator and the catalogue a way to record "started but not
  fully registered/armed." Small addition, high diagnostic value.
- Sharpens ADR-0017: its "inject context telling the agent to ask its role" is explicitly
  the advisory/conversational path; its re-arm guarantee routes through the mechanical
  `resume_command`, not the injected text.
- Reinforces ADR-0031: cosmetic reads render staleness/unknown from `updated_at`, so a hook
  that fails to refresh metadata degrades to an honest "unknown," not a confident stale
  lie.
