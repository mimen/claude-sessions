# `ccs bump-session` is the one reliable wake primitive (abstract the cmux nudge)

Follows ADR-0023 (durable inbox) and ADR-0014 (ccs holds the session→cmux ref). A
non-looping worker needs to be WOKEN when new mail arrives; today that's a raw
`cmux send` + double `send-key Enter` + a screen-scrape "did it land?" check, hand-rolled
in `spawn-agent.sh`. Milad: abstract it into a ccs verb so waking is reliable in one
place. Decided 2026-07-09.

## The problem

Loops (control, scout) notice new inbox mail on their next tick. A worker (fleet) does
NOT loop — it acts, finishes, goes idle. So a sender that drops mail in a worker's inbox
must also wake the worker's live session. The current wake is fragile:
- raw `cmux send <text>` then `send-key Enter` (twice, with sleeps), because the input
  can race a still-booting session or be silently dropped (the "UNCONFIRMED dispatch"
  flake);
- a heuristic screen read to guess whether it landed;
- all of it duplicated wherever a sender wants to wake a worker.

This is exactly the kind of unreliable, copy-pasted plumbing ccs exists to absorb.

## Decision

Add a single ccs primitive for waking a session, and route all wakes through it:

- **`ccs bump-session <identity>`** — deliver-and-wake in one call. It writes the message
  to the inbox (durable, ADR-0023) AND wakes the session's live tab. ccs already resolves
  the identity → the current session's cmux ref (ADR-0014), so it owns the one reliable
  wake implementation: send, confirm it landed (retry on the known input-routing flake),
  and fall back gracefully when the session is closed (no tab to wake — fine, the mail is
  durable, it drains on next start). (`ccs send-message` / `ccs nudge` are acceptable
  names; the point is one owned verb, not per-caller `cmux send`.)
- Senders (control routing a task, scout routing a Slack message, any agent messaging
  another) call `ccs bump-session`; none of them touch `cmux send` directly.

## Guarantees / non-guarantees

- The MESSAGE is durable and exactly-once regardless (it's the inbox). `bump-session`
  never risks the payload — it only affects WHEN the recipient notices.
- The WAKE is best-effort but reliable-in-one-place: ccs retries + confirms, and a
  dropped wake just means the worker picks the mail up on its next start or next
  bump. Worst case is latency, never loss.
- If the session is closed, `bump-session` is a no-op wake (nothing to send to); the
  mail waits. Resuming the session drains it.

## Consequences

- `spawn-agent.sh`'s hand-rolled `cmux send` + `send-key` + screen-scrape retry is
  retired in favor of `ccs bump-session`. One implementation to harden, not N.
- Reliability improvements (better landing-confirmation, backoff) happen once, in ccs,
  and every sender benefits.
- Consistent with the model: ccs owns the session↔tab relationship, so ccs owns acting
  on a live tab. Systems express intent ("wake this identity"); ccs handles the cmux
  mechanics.
- Pairs with ADR-0027 (ccs owns the display surfaces): both are cases of "ccs owns the
  cmux-facing mechanics; the role/system just supplies intent + metadata."
