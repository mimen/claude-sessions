# "cluster" is the one public word; "system" and "constellation" are deprecated synonyms

Both design reviews flagged terminology drift as dangerous BEFORE building keys and paths:
earlier ADRs (0002, 0009, 0010, 0011) and the ccs code (`--system`, `resume <system>`,
`sessionsForSystem`) say **system**; ADR-0009 also coins **constellation**; the vision doc
and the newer ADRs (0022–0036) say **cluster**. The same concept has three names, and it's
about to appear in identity keys, state paths, and resume verbs — where a name split
becomes a real bug, not a cosmetic one. Decided with Milad 2026-07-09.

## Decision — "cluster" everywhere public

**cluster** is the single public term: a grouping of agent identities (a core of singleton
roles + a fleet of per-work-unit workers) that runs one operation. It is what appears in:

- **identity keys / state paths:** `pr-watch · role · work-unit`, `~/.ccs/clusters/pr-watch/`
- **verbs:** `ccs resume-cluster` (ADR-0015), cluster-scoped state (ADR-0025/0031)
- **the TUI + docs + vision:** the cluster view, "bring the cluster up as one"

**"system"** and **"constellation"** are DEPRECATED synonyms for the same concept:
- **constellation** (ADR-0009's astronomical framing) — retired entirely as public
  vocabulary. The core/fleet distinction survives; the word "constellation" does not.
- **system** — deprecated in docs, verbs, and any NEW field. It survives ONLY as the
  existing ccs code field name (`system` column, `--system` flag) to avoid a rename
  migration; that field IS the cluster and should be read as "cluster." A later,
  isolated rename can align the code; until then, code `system` ≡ public `cluster`, and
  this equivalence is documented at the field.

## Why not rewrite the historical ADRs

ADRs 0001–0013 genuinely used "system"/"constellation" — that's the historical record and
rewriting it would be dishonest and churny. They are not edited. This ADR is the pointer
that resolves their vocabulary: wherever an earlier ADR says "system" or "constellation,"
read "cluster." The vision doc (the current-truth artifact) IS swept to "cluster," because
it represents the present design, not history.

## Consequences

- One word in everything built from here: keys, paths, verbs, TUI, docs. No reader has to
  guess whether "system," "constellation," and "cluster" are the same thing — they are.
- The ccs `system` field is grandfathered as an internal alias; a rename to `cluster` is a
  tracked, optional cleanup, explicitly NOT a blocker.
- ADR-0009 stands for its core/fleet structure; its "constellation/system" naming is
  superseded by this ADR's "cluster."
