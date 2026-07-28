package ccscli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

const healthyCatalogueCheck = `{
  "healthy": true,
  "service": {"running": false, "pid": 0},
  "sourceIndex": {
    "state": "fresh",
    "sourceLatestMtimeMs": 1722168000123,
    "indexedLatestMtimeMs": 1722168000123,
    "lagMs": 0,
    "staleAfterMs": 30000,
    "sourceFiles": 42,
    "indexedSessions": 40,
    "outOfSyncSessions": 0,
    "generation": 7,
    "indexedAt": "2026-07-28T12:00:00Z",
    "refreshedAt": "2026-07-28T12:00:01Z",
    "lastErrorAt": null,
    "lastError": null
  }
}`

const staleCatalogueCheck = `{
  "healthy": false,
  "service": {"running": false, "pid": 0},
  "sourceIndex": {
    "state": "stale",
    "sourceLatestMtimeMs": 1722168060123,
    "indexedLatestMtimeMs": 1722168000123,
    "lagMs": 60000,
    "staleAfterMs": 30000,
    "sourceFiles": 42,
    "indexedSessions": 40,
    "outOfSyncSessions": 2,
    "generation": 7,
    "indexedAt": "2026-07-28T12:00:00Z",
    "refreshedAt": "2026-07-28T12:00:01Z",
    "lastErrorAt": "2026-07-28T12:00:02Z",
    "lastError": "refresh interrupted"
  }
}`

func TestDecodeCatalogueCheckParsesFreshnessPayload(t *testing.T) {
	status, err := decodeCatalogueCheck(healthyCatalogueCheck)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Checked || !status.Healthy || status.Service.Running {
		t.Fatalf("status = %+v", status)
	}
	if status.SourceIndex.SourceLatestMtimeMs != 1722168000123 ||
		status.SourceIndex.IndexedLatestMtimeMs != 1722168000123 ||
		status.SourceIndex.StaleAfterMs != 30000 ||
		status.SourceIndex.SourceFiles != 42 ||
		status.SourceIndex.IndexedSessions != 40 ||
		status.SourceIndex.OutOfSyncSessions != 0 ||
		status.SourceIndex.Generation != 7 ||
		status.SourceIndex.IndexedAt == "" || status.SourceIndex.RefreshedAt == "" {
		t.Fatalf("source index = %+v", status.SourceIndex)
	}
}

func TestCataloguePreflightLeavesHealthyStoppedServiceAlone(t *testing.T) {
	calls := make([]string, 0, 1)
	run := func(_ context.Context, args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		return healthyCatalogueCheck, nil
	}
	status := cataloguePreflight(context.Background(), run)
	if !status.Healthy || status.Service.Running {
		t.Fatalf("status = %+v", status)
	}
	if got := strings.Join(calls, ","); got != "catalogue-service check --json" {
		t.Fatalf("calls = %q", got)
	}
}

func TestCataloguePreflightRecoversStaleIndexAndReportsChanges(t *testing.T) {
	calls := 0
	run := func(_ context.Context, args ...string) (string, error) {
		calls++
		switch calls {
		case 1:
			return staleCatalogueCheck, errors.New("exit status 1")
		case 2:
			if got := strings.Join(args, " "); got != "catalogue-service refresh --if-stale --json" {
				return "", fmt.Errorf("refresh args = %q", got)
			}
			return `{"stats":{"scanned":42,"parsed":3,"skipped":39,"removed":1}}`, nil
		case 3:
			return healthyCatalogueCheck, nil
		default:
			return "", fmt.Errorf("unexpected call %d", calls)
		}
	}
	status := cataloguePreflight(context.Background(), run)
	if !status.Healthy || status.Recovery.Parsed != 3 || status.Recovery.Removed != 1 || status.RecoveredRows() != 4 {
		t.Fatalf("status = %+v", status)
	}
	if calls != 3 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestCataloguePreflightKeepsStaleStateWhenRefreshFails(t *testing.T) {
	calls := 0
	run := func(_ context.Context, _ ...string) (string, error) {
		calls++
		if calls == 1 {
			return staleCatalogueCheck, errors.New("exit status 1")
		}
		return "", errors.New("refresh unavailable")
	}
	status := cataloguePreflight(context.Background(), run)
	if status.Healthy || status.SourceIndex.State != "stale" || status.SourceIndex.LagMs != 60000 || status.Failure != "refresh failed" {
		t.Fatalf("status = %+v", status)
	}
}

func TestCataloguePreflightKeepsWarningWhenRecheckIsUnhealthy(t *testing.T) {
	calls := 0
	run := func(_ context.Context, _ ...string) (string, error) {
		calls++
		switch calls {
		case 1, 3:
			return staleCatalogueCheck, errors.New("exit status 1")
		case 2:
			return `{"stats":{"scanned":42,"parsed":0,"skipped":42,"removed":0}}`, nil
		default:
			return "", fmt.Errorf("unexpected call %d", calls)
		}
	}
	status := cataloguePreflight(context.Background(), run)
	if status.Healthy || status.Failure != "recovery incomplete" || status.SourceIndex.State != "stale" {
		t.Fatalf("status = %+v", status)
	}
}
