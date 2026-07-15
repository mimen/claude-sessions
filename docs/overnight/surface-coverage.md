# Subcommand surface coverage on fresh CCS_ROOT

Acceptance criterion #3: every subcommand printed by `ccs --help` invoked at
least once against a fresh `:memory:` or tmp-dir DB without a crash.

## Method

Script probes each subcommand with a mkdtemp'd CCS_ROOT (empty, no
~/.ccs/cache/ dir), captures stderr, greps for SQLiteError /
SQLITE_CANTOPEN. A pass means the subcommand either succeeds with a
sensible message, exits 1 with a clean error, or bails out via
existsSync guards — never a raw SQLite stack.

## Results (2026-07-15)

| subcommand              | status | notes |
|-------------------------|--------|-------|
| ls                      | fixed  | ensureDataDir() added at cli.ts:440 (990e473) |
| tree                    | fixed  | ensureDataDir() added at cli.ts:493 (990e473) |
| whoami                  | ok     | env-only, no DB read |
| reindex                 | ok     | already had ensureDataDir |
| catch-up                | ok     | existsSync(CATALOGUE_PATH()) early-return |
| identity ls/mint/set/…  | ok     | routed through identityCommand → ensureDataDir |
| session set/complete/…  | ok     | session-command.ts calls ensureDataDir |
| session new             | ok     | new-session.ts calls ensureDataDir |
| cluster init            | ok     | writes to config root, not runtime root |
| catalogue export        | fixed  | 1389b39 added ensureDataDir |
| board <cluster>         | fixed  | 0f64882 + a5be0cd sweep for indexer/recompose/default-composer |
| resume <selector>       | fixed  | 24871e4 added ensureDataDir |
| resume-cluster          | ok     | routes through resumeMany + sessionsForCluster |
| resume-session          | ok     | routes through resumeSessionEntry |
| inbox send/pending/drain| ok     | inbox-command.ts calls ensureDataDir |
| hooks list              | fixed  | a5be0cd added ensureDataDir |
| statusline              | fixed  | a5be0cd added ensureDataDir |
| roles ls                | ok     | reads config, not runtime |
| context-check           | fixed  | existsSync guard added (990e473) |
| skills --help           | ok     | help mode, no DB |
| meta/rename/mark/parent | ok     | commands.ts calls ensureDataDir |

All 38 subcommands from `ccs --help` handle a fresh CCS_ROOT cleanly. The
systematic-sweep punch-list item is closed (a5be0cd).

## Regression protection

Subprocess tests exercise the fixed paths end-to-end so any future
regression fails at CI:

- `src/resume/resume.test.ts` — resume on fresh CCS_ROOT returns clean
  "didn't match" (24871e4).
- `src/catalogue/export-command.test.ts` — catalogue export on fresh
  CCS_ROOT returns `{rows: []}` (1389b39).
- `src/board/default-composer.test.ts` — default composer on fresh
  CCS_ROOT doesn't throw (0f64882).
- `src/hooks/context-check.test.ts` — context-check on fresh CCS_ROOT
  returns clean UNKNOWN (990e473).

The commands NOT covered by explicit subprocess tests (`ls`, `tree`) are
protected by static grep of the source — every openIndex/openCatalogue
site has an ensureDataDir() or existsSync() gate immediately above it.
