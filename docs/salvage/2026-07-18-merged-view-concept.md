# The Merged View — multi-Host session catalogue (C1 concept explainer)

**Date:** 2026-07-18
**Status:** concept only. NOT implemented in this branch. Origin's
implementation on `preservation/fleet-view-2026-07-18` is preserved as
reference; a port to our post-ADR-0089 schema is future work.

## The problem this solves

Today, each machine has its own `~/.ccs/cache/catalogue.db`. If you run
sessions on laptop A and later switch to laptop B, laptop B's ccs sees
none of laptop A's sessions. `ccs ls` on B lists ~200 rows; A has ~1200.
That's fine for "browse local" but wrong for "browse everything I've
ever run."

The catch: sessions can't just be *copied* between machines. A session's
transcript lives on the machine that ran it (`~/.claude/projects/…`).
Copying rows without transcripts gives you dangling references. Copying
transcripts across machines duplicates them and thrashes disk.

The Merged View is: **each machine owns its own rows, but there's a
combined READ view of everyone's rows, and a queued EDIT protocol for
touching another machine's rows.**

## The mental model

Origin's commit `1fc8241 feat(catalogue): the Merged View — one
fleet-wide catalogue, Host-owned rows, edit intents` frames it as three
distinct pieces:

### 1. MERGE — the read view

- **`ccs merge`** — on your primary Host, this unions every Host's
  catalogue + Index snapshot into a `merge.db` file.
- **`ccs merge --pull`** — on a spoke, fetches `merge.db` from the
  primary.
- **`ccs ls --fleet`** — reads from `merge.db`, so you see rows from
  every machine.

The merge is one-way READ. Spokes don't merge upward (that would
clobber their pulled view and disable the ownership guards below).

Sources are **snapshot-copied before opening**. The `-shm` gotcha
(commit `b694b74`) is critical: never copy `.db + .wal + .shm` — a
stale `.shm` makes sqlite skip un-checkpointed WAL frames on the
reader. Copy `.db + .wal` only; sqlite rebuilds `.shm` from the WAL
header.

The whole rebuild is one transaction (200x less fsync churn) and
lands via temp-file + rename so readers never see a half-built view.
A torn source (corrupt catalogue on some Host) is skipped with a
note, never fatal.

### 2. OWNERSHIP — who can write

**Rule:** each row is owned by whichever Host holds its transcript.
NOT owned by whoever recorded the earliest timestamp; NOT owned by
the machine currently reading it. Owner = "the Host whose Index
contains this session's transcript path."

Host identity uses **`scutil LocalHostName`**, NOT `hostname`. This is
load-bearing. Origin's PR flagged that `hostname` on a laptop defaults
to the DHCP-assigned name (`Mac.attlocal.net` at home,
`Milad-MBP-15.local` at the office). That would flip your Host identity
every time your network changed and lock you out of your own rows.
`scutil LocalHostName` is a stable user-set identifier.

Every write path (CLI + TUI + the natural-language editor + mark
keybinds) refuses to mutate another Host's row directly. Instead, it
suggests you use an **intent** (below).

### 3. INTENTS — how to edit someone else's rows

**`ccs intent <session_id> <op> <value>`** emits a reserved
edit-intent envelope into the owning Host's inbox. The envelope
carries: target host, target session, op, value, source host,
timestamp, and a body-schema version.

The owning Host **selectively consumes** its intents:
`ccs apply-intents <state-dir>` reads envelopes addressed to itself
(`body.host === my host`), applies them, and ledgers them. Envelopes
addressed to *other* Hosts stay in the shared inbox for the intended
recipient. This is critical: `fleet drain --mark` piped blindly would
consume everyone else's intents into your dedupe ledger, permanently
losing them (protocol law 4).

Malformed envelopes and refused-foreign mutations dead-letter with
reasons. Value normalization runs on BOTH ends (a `completed yes`
transiting the fleet must not un-complete a session on arrival).
Envelope bodies are boundary-validated: a poison shape skips one
envelope, not the whole batch.

## Why we're taking the ideas but not the code

Origin's implementation assumes a schema shape we've moved away from:

- **`role`, `substrate`, `identity`** as free-string columns on
  sessions. Our post-ADR-0089 world has `identity_key` structured
  keys pointing at per-role attribute tables, an `identities` table
  with lifecycle + grouping FK, etc. Rows in origin's schema flatten
  our two-table normal form.
- **`event`** — origin still uses this legacy field for grouping.
  We dropped it in v33.
- **`fleet-commands.ts`, `intents.ts`, `ownership.ts`** — all wired
  to origin's row shape.

A port would rewrite ~all three files. Not this week.

## Ideas we've already banked (elsewhere in the salvage)

- **The `-shm` copy pitfall** (from `b694b74`). Filed as a follow-up
  in the salvage plan; audit our scratch-copy code in the overnight
  harden loop before we ever build a merger.
- **Ownership by transcript-holder** (not timestamp). This is the
  key insight and it belongs in an ADR when we're ready to build.
- **`scutil LocalHostName` vs `hostname`.** Same.
- **Snapshot-copy-then-open pattern.** Even without a merger, this is
  a good pattern for any tooling that reads catalogue live — we should
  adopt it in the scratch-copy paths in the overnight loop.

## If we do build this (future ADR)

The order that would make sense on our schema:

1. **Host identity primitive.** A tiny module (`src/host.ts`) that
   returns `scutil LocalHostName` (macOS) / `hostname` (fallback),
   cached. Exposed as `ccs whoami --host`.
2. **Snapshot-copy helper.** `src/catalogue/snapshot.ts` — `db + wal`
   only, temp-file + rename, callable from anywhere.
3. **`ccs merge` command.** Consumes a config (list of Host state
   directories) + snapshot-copies each + unions their `catalogue`
   and `identities` and `identity_*` tables under a Host-namespaced
   view. Idempotent, deterministic; a torn source is skipped.
4. **`ccs ls --fleet` reader.** Reads `merge.db` if present, falls
   back to local catalogue.
5. **Ownership guards.** Every write CLI + hook checks
   `row.host === myHost || fail with intent-suggestion`.
6. **Intent envelope + queue.** Reuse the inbox mechanism from
   ADR-0033. Envelopes are just inbox messages with a reserved
   `kind: "edit-intent"` shape.
7. **`ccs intent send / apply-intents`.** Selective consumption keyed
   by `body.host === myHost`.

Each of these is small and independently valuable. Steps 1-4 give you
the merged read view alone (no ownership yet). Steps 5-7 add the write
protocol. You can stop after 4 and still have a huge win.

## Estimated effort

- **Steps 1-4 (read-only merge):** 2-3 days if done cleanly.
- **Steps 5-7 (ownership + intents):** another 3-5 days, and needs a
  real ADR because the intent envelope shape is a durable protocol
  (a future ccs on either side must still speak the same protocol).

**When to do it:** when you have >1 machine you actively run sessions
on AND you feel the pain of "which machine did I run that on?" hit you
weekly. Until then it's premium infrastructure for a hypothetical.

## Reference material

Origin's implementation is preserved on
`origin/preservation/fleet-view-2026-07-18`. Reading it in order:

- `docs/session-catalogue-layer.md` — the design spec (points at a
  vault path; the vault has the canonical version).
- `src/catalogue/merge.ts` — the read-view union logic.
- `src/catalogue/ownership.ts` — Host identity + row-owner rules.
- `src/catalogue/intents.ts` — envelope shape, dead-letter policy.
- `src/catalogue/fleet-commands.ts` — CLI verbs.
- Commit `1fc8241` PR body — the design rationale.
- Commit `b694b74` — the `-shm` bug + fix.

If you decide to build it, don't reimplement from scratch — read the
origin's code, extract the algorithms + protocol shape, port them onto
our post-ADR-0089 tables.
