# Overnight harden — tick log

One line per tick: `<iso> | <status> | <what> | <commit>`.

2026-07-15T07:37Z | fixed | mark() refuses lifecycle on unknown session id (no more phantom rows via ensureRow) | f269500
2026-07-15T08:07Z | ruled-out | `identity set --unknown_field=x` already errors on both core & fleet; added CLI regression tests | 94f0145
2026-07-15T08:37Z | fixed | mintIdentity TOCTOU race — atomic INSERT ... ON CONFLICT DO NOTHING (barrier-synced race test) | 667475b
2026-07-15T09:07Z | fixed | `ccs resume <bogus>` on fresh CCS_ROOT crashed with raw SQLITE_CANTOPEN before zero-match handling could run | 24871e4
2026-07-15T09:37Z | ruled-out | ambiguous `#N` across repos is resolved-by-design; count surfaced in CLI, dedup in resumeMany; regression test added | 3640f05
2026-07-15T10:07Z | ruled-out | board --recompose-all on fresh cluster already writes {status:'OK', rows:[]}; regression test added | 6b29d84
2026-07-15T10:37Z | fixed | `catalogue export` on fresh CCS_ROOT crashed with SQLITE_CANTOPEN; added ensureDataDir() + subprocess regression + queued systematic sweep | 1389b39
2026-07-15T11:07Z | fixed | `session set --identity=` refused unknown key (FK-like guard); no more dangling identity refs from typos/retired keys | dd86f2d
2026-07-15T11:37Z | ruled-out | `--parent=<self>` and `--parent=<non-uuid>` already rejected; `<uuid-nonexistent>` is intentional forward-ref; 3 regression tests | 9772edf
2026-07-15T12:07Z | ruled-out | session-complete mirror uses setIdentityFields (explicit UPDATE), not completeIdentity — archived stays 1; regression test | b7f1afb
2026-07-15T12:37Z | ruled-out | TUI empty groups omitted; retire-cascade groups show total + `✓ done · N` fold; 2 regression tests | c6d7051
2026-07-15T13:07Z | ruled-out | TUI archive is session-driven; identity-active + all-sessions-archived → hidden (correct); regression test | a727dc9
2026-07-15T13:37Z | ruled-out | `inbox drain <key>` on 0 messages exits clean at library + CLI layers; 2 regression tests | 69588c9
2026-07-15T14:07Z | ruled-out | `cluster init` twice refuses cleanly and leaves existing files untouched; different --role also refused; 2 regression tests | e6cf405
2026-07-15T14:37Z | ruled-out | `whoami` outside a session already exits 1 with clear stderr; added tests for both branches (env-set and env-unset) | 5eb2fec
2026-07-15T15:07Z | fixed | mintIdentity accepted empty/whitespace/control-char identity_keys — real data-integrity bug; added `assertIdentityKeyOk` guard + 7 tests | 1a29d06
2026-07-15T15:37Z | ruled-out | live DBs (catalogue+index+skills) integrity_check=ok; 0 dangling FKs; 0 malformed keys; acceptance-#6 also verified; lock-in test | 39bdd4f
2026-07-15T16:07Z | ruled-out | symlinked catalogue writes durably to real file (regression test); NFS/SMB documented as known WAL limitation | 9b59817
2026-07-15T16:37Z | ruled-out | no local-tz APIs in src/; full suite passes under UTC+14 and UTC-11; lock-in test flips process.env.TZ | b36a8ec
2026-07-15T17:07Z | ruled-out | --role without --cluster inherits cluster from role registry for cluster-scoped roles; standalone-role gap queued | 7415b90
2026-07-15T17:37Z | ruled-out | cross-cluster role-name collision: cluster-scoped resolveRole is safe; legacy call warns loudly + picks first; 2 regression tests | 3ce3989
2026-07-15T18:07Z | ruled-out | identity scratch dir recreation idempotent — deterministic path survives user rm -rf; lifecycle regression test | 0270231
2026-07-15T18:37Z | fixed | resume-cluster shouldPin called resolveRole(role, cluster) with cluster undef — real bug (silent runtime throw, TS error); 4/13 typecheck errors resolved | c40a9ed
2026-07-15T19:07Z | fixed | remaining typecheck errors — 2 more real bugs (default-composer.workUnit, session-command stale setParked import) + mechanical fixes; ACCEPT #1+#2 now hold | 312b87f
2026-07-15T19:37Z | added | acceptance #4 lifecycle round-trip test — mint→attach→complete→archive→unarchive traced end-to-end | 1d132d6
2026-07-15T20:07Z | added | acceptance #7 + #8 CLI-driven core-vs-fleet mirror tests — core session-archive stays per-session; fleet session-complete cascades | 43f43d0
2026-07-15T20:37Z | added | acceptance #9 supersede-keeps-identity-alive test — 2nd worker archives 1st but shared fleet identity stays active | 9cb9b7a
2026-07-15T21:07Z | fixed | dedup-sessions-per-identity was NOT idempotent — flipped direction on each run (setArchived bumps updated_at); real bug fixed with active-only keeper selection | d06c4c0
2026-07-15T21:37Z | added | acceptance #11 backfill-identity-from-cwd idempotency test — script already correct, regression pinned via subprocess | 868a74b
