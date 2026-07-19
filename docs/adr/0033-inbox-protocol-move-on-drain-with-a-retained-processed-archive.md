# Inbox protocol — atomic write, move-on-drain, retained `processed/` archive (the event-watch design)

ADR-0023 established a durable inbox keyed by responsibility. This ADR pins its exact
protocol. It is NOT invented here: it is the **proven event-watch implementation**
(`lib/session_inbox.py` + `scripts/inbox.py`), which runs in production and works well.
An earlier draft of this ADR proposed a more elaborate "read-in-place, ack-on-Stop"
protocol; that is retracted in favor of the shipped design, which is simpler AND stronger
on the property ADR-0032 depends on. Decided with Milad 2026-07-09.

## The protocol (as event-watch implements it)

- **Deliver = atomic write.** `write_message` writes the body to a `.tmp` file and
  `os.replace`s it into `inbox/` — a reader never sees a half-written message. The filename
  is a UTC timestamp + sanitized sender, with a `-N` suffix to disambiguate collisions, so
  filenames sort chronologically. Delivery is durable and independent of whether the
  recipient is running.
- **Drain = read + move, in one step ("move-on-drain").** `drain()` reads each pending
  message's body AND moves the file to `inbox/processed/` in the same pass, returning the
  bodies to the caller. The reader has the content in hand the instant it is moved.
- **Idempotent by construction.** Once a message is moved to `processed/`, it is never
  returned by a later drain. Two drains don't double-deliver; a re-run is safe.
- **`processed/` is retained as the audit trail.** Moved messages are kept, not deleted —
  the durable record of everything the identity was told. (Consistent with "completed state
  is retained, not thrown away.")
- **Ordered.** Chronological by the stamped filename; a drainer handles oldest first.

## Delivery semantics — exactly-once in the happy path, never lost

- In the normal path each message is delivered to the reader **exactly once** (drain is
  idempotent, so nothing is re-read or double-processed).
- The message content is **never lost**: even if the reader crashes after the move but
  before acting, the body is durably in `processed/`, and the agent recovers its working
  context by rehydrating from full state on restart (ADR-0038) — not by re-reading the
  inbox.
- So the crash window is "an effect not yet applied," never "a message gone." It is covered
  by retention + rehydration, deliberately NOT by redelivery.

## Why move-on-drain beats read-in-place here

- **It's what makes ADR-0032's safety net real.** move-on-drain is atomically exclusive:
  the `os.replace`/move succeeds for exactly one caller, so if two embodiments ever drain
  the same inbox concurrently (the foreign-pane case), each message goes to exactly one of
  them — no double-delivery. A read-in-place protocol would let BOTH read the same message,
  which would have contradicted ADR-0032's "atomic drain is the safety net." This ADR and
  0032 are now consistent.
- **No poison-message loop.** Because a message is moved BEFORE the agent acts and is never
  re-read, a message that crashes the agent mid-turn does not get redelivered forever — it's
  already in `processed/`. So the elaborate re-read counter + `poison/` quarantine the
  earlier draft added are unnecessary; move-on-drain sidesteps the trap entirely.
- **It's proven.** event-watch runs this exact code in production; we adopt a working design
  rather than a theoretical one.

## The ccs-level primitive

Promoted to a ccs verb set usable by any cluster (ADR-0023): `ccs inbox send`
(deliver, atomic) and `ccs inbox drain` (read + move-to-processed, returns the bodies) —
directly mirroring event-watch's `scripts/inbox.py` (`send` / `drain`). Both sit on the
ADR-0031 storage layer (atomic writes, `updated_at`). Senders never touch files directly.

## Consequences

- ADR-0023's "exactly-once via move-to-processed" is now precise: move-on-drain, idempotent,
  with a retained `processed/` archive; exactly-once delivery in the happy path, never-lost
  by retention + rehydration.
- Reconciles with ADR-0032: the atomic move IS the concurrency safety net (one drainer wins
  per message), so best-effort embodiment detection is enough — no lease needed.
- Pairs with ADR-0038: a mid-task crash recovers via full-state rehydration, which is why
  the inbox doesn't need to re-deliver.
- Build: port event-watch's `session_inbox.py` (`write_message` / `pending_messages` /
  `drain`) into ccs as the shared inbox primitive; expose `ccs inbox send|drain`. pr-watch's
  own file-inbox converges onto it.
