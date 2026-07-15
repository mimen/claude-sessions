# Overnight harden — tick log

One line per tick: `<iso> | <status> | <what> | <commit>`.

2026-07-15T07:37Z | fixed | mark() refuses lifecycle on unknown session id (no more phantom rows via ensureRow) | f269500
2026-07-15T08:07Z | ruled-out | `identity set --unknown_field=x` already errors on both core & fleet; added CLI regression tests | 94f0145
2026-07-15T08:37Z | fixed | mintIdentity TOCTOU race — atomic INSERT ... ON CONFLICT DO NOTHING (barrier-synced race test) | 667475b
