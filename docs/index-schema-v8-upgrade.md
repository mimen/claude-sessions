# Index schema v8 upgrade sequencing

Index v8 adds persistent duplicate-transcript diagnostics (`sessions.shadow_paths`). The v8 binary
upgrades compatible v6/v7 indexes in place; incompatible pre-v6 shapes are rebuildable caches and are
recreated safely.

## Deployment order

1. Merge and deploy the v8 reader/writer before invoking `ccs reindex` on a machine with an existing
   index. It performs the additive migration on first open.
2. Do not run an older ccs binary against a v8 index: older binaries do not recognise v8 and can rebuild
   the cache. Update all installed entrypoints together when the branch merges master.
3. A rebuild is recoverable from the transcript store, but the migration intentionally preserves the
   v6/v7 title cache to avoid an unnecessary title-generation backlog.
