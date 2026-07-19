# Each role owns its own upkeep, via its materialized hooks — no central babysitter

Consolidates a principle that emerged across ADR-0022 (materialization), ADR-0027
(ccs owns the display surfaces), and ADR-0028 (bump-session). Decided with Milad
2026-07-09.

## The principle

Because a role's hooks + settings are materialized into place (ADR-0022), a role is
responsible for keeping its OWN METADATA current — its phase, its statusline, its cmux
tab, its inbox handling, its arming. There is no central process whose job is to walk
the fleet and refresh everyone's metadata; each role's own hooks do it. ccs provides the
mechanisms (the metadata store, the display renderers, the verbs); the role wires them
via its hooks and is accountable for its own legibility.

Scope note (2026-07-09): "no central babysitter" is specifically about METADATA UPKEEP —
who keeps a role's phase/statusline/tab/inbox current. It is NOT a claim that nothing is
centralized: ccs centrally MATERIALIZES the hooks (ADR-0022/0034) and centrally RENDERS
the tab via `sync-tabs` (ADR-0027), and control still centrally ROUTES and OBSERVES the
fleet. The precise claim is "each role owns updating its own metadata," not "there is no
central component."

## Why this over a central updater

A single central "sync everything" pass is the thing that drifts, forgets a case, or
silently stops running (the exact failure mode that hid a role earlier, and the
founding "mechanical work as prose an agent forgets" trap). Making upkeep the role's
own hooks means: it happens as a side-effect of the role doing its work, it's local to
the role's definition (so adding a role adds its upkeep), and there's no single point
whose failure leaves the whole board stale.

## The role-definition checklist

Defining a new role means deciding how it satisfies each of these; ccs materializes
the wiring, the role's hooks perform the upkeep:

1. **Keep its ccs metadata fresh** — update phase (and pr_number / work-item / epic if
   they change) as it works, so the catalogue always reflects reality. This is the
   source both display surfaces read.
2. **Keep its statusline current** — falls out of (1): the materialized `statusLine`
   command (ADR-0027) reads that metadata each turn.
3. **Keep its cmux tab current** — also falls out of (1): the tab is painted from the
   same metadata.
4. **Drain its inbox** at the top of each task / on resume; **self-report** on turn-end
   (a worker drops a result event; a loop advances its own state).
5. **Re-arm on start** — a loop's SessionStart hook restarts its loop; any role
   registers/refreshes its identity (ADR-0017).

## Consequences

- Upkeep is distributed to the roles and happens by construction; no central updater to
  run, forget, or watch. A role stays legible whether or not anything else is looking.
- Ties the earlier decisions together: 0022 delivers the hooks, 0027 makes the display a
  read of role-maintained metadata, 0028 gives the wake primitive — and this ADR states
  the responsibility line: the role owns keeping itself current.
- Practical: the checklist above is the acceptance criteria for "is this role fully
  defined?" — a role missing any item is a role that will go stale or stall.
