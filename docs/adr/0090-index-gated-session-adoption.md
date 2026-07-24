# Index-gated session adoption

## Decision

The index is an observation cache, not catalogue truth. A transcript found by scanning can be queried as `indexed-unattached`, but it does not acquire durable lifecycle or identity metadata until a human runs:

```sh
ccs session adopt <session-id> --identity=<existing-identity-key>
```

Adoption requires both a positive index row and a pre-existing identity. It creates one minimal catalogue row in an immediate transaction, carrying only the indexed resume identifier when present. It does not mint identities, infer legacy metadata, launch a process, or copy observation-derived lifecycle fields.

`ccs session set` only mutates an existing catalogue row. It never acts as implicit adoption and validates all requested fields before its atomic write.

## Rationale

ADR-0005 reserves reboot-surviving identity and lifecycle for the catalogue. An index row proves only that a transcript was observed; it cannot answer who owns it or what durable role it should have. Treating observation as catalogue truth would let reindexing manufacture metadata from arbitrary files.

The explicit boundary also keeps the index rebuildable and non-mutating to `catalogue.db`, while giving an operator a safe, inspectable path to attach an otherwise useful transcript.

## Consequences

- `ccs session <id>` has three outcomes: `catalogued`, `indexed-unattached`, or absent.
- Reindex deterministically selects one canonical transcript per duplicate session id and records the shadow paths as index diagnostics.
- A concurrent/adversarial second adopter loses to the catalogue row check inside the immediate transaction; it cannot overwrite the first adoption.
- Existing catalogue writes stay at the command layer, preserving ADR-0068's mutation boundary.
