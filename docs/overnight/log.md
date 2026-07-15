# Overnight harden — tick log

One line per tick: `<iso> | <status> | <what> | <commit>`.

2026-07-15T07:37Z | fixed | mark() refuses lifecycle on unknown session id (no more phantom rows via ensureRow) | f269500
2026-07-15T08:07Z | ruled-out | `identity set --unknown_field=x` already errors on both core & fleet; added CLI regression tests | 94f0145
2026-07-15T08:37Z | fixed | mintIdentity TOCTOU race — atomic INSERT ... ON CONFLICT DO NOTHING (barrier-synced race test) | 667475b
2026-07-15T09:07Z | fixed | `ccs resume <bogus>` on fresh CCS_ROOT crashed with raw SQLITE_CANTOPEN before zero-match handling could run | 24871e4
2026-07-15T09:37Z | ruled-out | ambiguous `#N` across repos is resolved-by-design; count surfaced in CLI, dedup in resumeMany; regression test added | 3640f05
2026-07-15T10:07Z | ruled-out | board --recompose-all on fresh cluster already writes {status:'OK', rows:[]}; regression test added | 6b29d84
