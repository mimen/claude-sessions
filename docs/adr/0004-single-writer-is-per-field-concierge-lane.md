# Single-writer is enforced per-field; the concierge gets a reserved lane

The concierge must dispatch workers live (a snappy live-review property Milad chose),
but dispatching writes sessions.json (inFlightTask, lastDispatchStatus), which the
control plane otherwise solely owns. Per-file single-writer and live dispatch
therefore collide.

Decision: enforce single-writer PER FIELD, not per file. Control owns board/gate/
pending and each session's lifecycle fields (liveness, revival handles). The
concierge writes only a reserved sub-object `sessions[key].concierge`
(lastLiveDispatch, inFlightTask, ...) plus the worker inbox; control reads that lane
to know a live relay happened and never re-dispatches on top of it. This mirrors the
existing §8.1 split of pr-<n>.sensed.json (scripts) vs pr-<n>.judgment.json (worker).

Considered and rejected: (b) concierge never writes and round-trips every dispatch
through control (loses the live snappiness the ability was chosen for); (c) concierge
dispatches directly and accepts the race (the multi-writer-on-one-file situation
§8.1 forbids; registry races already bite per the bootstrap misrouting incident).

## Amendment (ADR-0005)
The concierge lane stays in sessions.json — it is LIVE-only routing state
(last live dispatch, in-flight task), which ADR-0005 assigns to the registry, not
the durable catalogue. Per-field single-writer holds within sessions.json; the
catalogue holds identity/lifecycle separately. So this ADR is unchanged in
substance, just scoped: "reserved concierge sub-object" = a sessions.json field,
not a catalogue field.
