# Catalogue self-healing verification — 2026-07-28

## Scope

- Bound source-index staleness with a five-minute `launchd` reindex sweep.
- Keep the on-demand catalogue daemon's intentional 30-second idle lifecycle.
- Add a strictly observational per-session source/index health check with a two-hour forward-change SLA.
- Self-heal and surface stale/recovered/unavailable state in the Go TUI; remain silent when healthy.
- Bound automatic health scans to five minutes and TUI recovery attempts to 15 seconds; give scheduled refreshes a 30-minute watchdog that hard-stops only a positively identified wedged daemon while leaving manual reindex unbounded.
- Feed the same host-local freshness signal into `ops-watch` in the separate vault change.

The fresh `origin/master` baseline did not contain the `STANDARDS.md` named in the handoff. Verification follows repository conventions and the loaded engineering-process contract.

## Real failure and recovery flow

### 1. Confirmed the real index was stale while the service was stopped

```text
ccs catalogue-service check --json
exit 1
healthy=false
service.running=false
sourceIndex.state=stale
sourceLatestMtimeMs=1785270254244
indexedLatestMtimeMs=1785258697252
lagMs=11556992  # 3.21h; SLA 2h
sourceFiles=5602
indexedSessions=5553
generation=66
```

The deployed diagnostic still reported `ccs: catalogue service stopped`. That state is normal for the intentionally on-demand daemon; source/index lag is the failure signal.

### 2. Confirmed the TUI warns when automatic recovery is unavailable

The real service was stopped and `CCS_BIN` was deliberately pointed at a missing executable so the TUI's recovery attempt could not start it. The TUI still rendered cached data and showed:

```text
catalogue stale · 3h lag · refresh failed · service stopped
```

Visual evidence was captured and inspected locally. It is intentionally excluded from this public repository because the real-data screen contains private fleet metadata; the implementation handoff provides the local artifact path.

### 3. Confirmed the TUI recovers the real stale index

With the real worktree binary restored, the same TUI preflight started the authority, refreshed, and reported:

```text
catalogue caught up · 46 indexed
```

The corresponding recovered-state capture was also inspected locally and excluded from the public repository for the same privacy reason.

A second render against the now-current index contained neither `catalogue stale` nor `catalogue caught up`, proving the healthy state is quiet.

### 4. Installed and loaded the periodic recovery job

Installed from `scripts/launchd/install-catalogue-refresh-agent.sh`:

```text
label: com.milad.ccs.catalogue-refresh
program: /opt/homebrew/bin/bun
ccs: /Users/mimen/Programming/Deployments/claude-sessions/bin/ccs
schedule: RunAtLoad + StartInterval 300
runs: 1
last exit code: 0
```

RunAtLoad log:

```text
Indexed 5602 sessions (4 GB) from /Users/mimen/.claude/projects [host: Milads-M3-2]
  8 parsed, 5571 unchanged, 0 removed (generation 68)
```

### 5. Killed the authority and confirmed scheduled recovery still works

```text
killed catalogue service pid 66339
ccs: catalogue service stopped
launchctl kickstart -k gui/501/com.milad.ccs.catalogue-refresh
runs: 2
last exit code: 0
```

Second job log:

```text
Indexed 5602 sessions (4 GB) from /Users/mimen/.claude/projects [host: Milads-M3-2]
  5 parsed, 5574 unchanged, 0 removed (generation 69)
```

Post-recovery health:

```text
healthy=true
service.running=false
sourceIndex.state=fresh
lagMs=49036
generation=69
lastError=null
```

The daemon returned to its normal stopped/idle state while the index remained healthy.

### 6. Rechecked the strengthened per-session diagnostic

The final implementation compares every canonical source session with its indexed row rather than only comparing global maxima. It detects lag in a non-newest transcript, deleted indexed rows, canonical-path changes, rollbacks, and same-mtime size drift. Newly created sessions receive the two-hour SLA when an index already exists; empty source + empty index is healthy, while one-sided readable state is stale.

A real read-only check after the final rebase returned:

```text
healthy=true
service.running=false
sourceIndex.state=fresh
lagMs=4713726
outOfSyncSessions=0
generation=85
lastError=null
```

## Programmatic verification

```text
bun test
1348 pass, 0 fail, 4153 expect() calls across 144 files

bun run typecheck
pass

go test ./...
pass

go test -race ./...
pass

go vet ./...
pass

go build ./...
pass

plutil -lint scripts/launchd/com.milad.ccs.catalogue-refresh.plist
OK

bash -n scripts/launchd/install-catalogue-refresh-agent.sh
pass

git diff --check
pass
```

The lifecycle suite includes a bounded-refresh fixture that serves health, hangs the refresh request, verifies exactly one request is issued, and confirms the lock-owned daemon is hard-stopped. The transport suite separately proves timeout rejection and the explicit unbounded title-maintenance path.

Two repository-wide static scripts remain red on the untouched baseline and are not regressions from this change:

- `lint:circular`: five existing cycles on both deployment baseline `1ee630a` and this branch.
- `lint:exports`: the same repository-wide existing unused-export inventory on baseline and branch; none of the new catalogue health exports appear in the findings.

## Reviewer reproduction delta

Covered by evidence; reviewers do not need to reproduce:

- real three-hour source/index lag detection;
- stopped-service stale warning;
- real TUI catch-up of 46 sessions;
- healthy quiet state;
- LaunchAgent install/RunAtLoad;
- forced service kill and successful second scheduled run;
- full TypeScript and Go verification suites.

Spot-check only:

- wording and hierarchy of the warning in the two screenshots;
- plist deployment path and five-minute cadence;
- read-only/canonical duplicate semantics of `catalogue-service check`.
