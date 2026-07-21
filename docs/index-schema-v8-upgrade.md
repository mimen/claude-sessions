# Index schema v8 upgrade sequencing

Index v8 adds persistent duplicate-transcript diagnostics (`sessions.shadow_paths`). The v8 binary
upgrades complete v7 indexes in place. Version 6 is deliberately invalidated because its cost accounting
predates the v7 semantics; incompatible pre-v6 shapes are also rebuildable caches and are recreated safely.

## Deployment order

1. Merge and deploy the v8 reader/writer before invoking `ccs reindex` on a machine with an existing
   index. It preserves complete v7 rows and performs the additive migration on first open. A v6 or
   older cache is intentionally rebuilt, then populated by the normal reindex pass.
2. Do not run an older ccs binary against a v8 index: older binaries do not recognise v8 and can rebuild
   the cache. Update all installed entrypoints together when the branch merges master.
3. A rebuild is recoverable from the transcript store. Only v7 title cache data is intentionally retained
   to avoid an unnecessary title-generation backlog.
4. Schema open/migration uses SQLite `BEGIN IMMEDIATE` plus a five-second busy timeout, so simultaneous
   ccs processes serialize the upgrade rather than racing table creation or alteration.
