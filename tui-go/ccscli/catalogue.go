package ccscli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/mimen/claude-sessions/tui-go/data"
)

type catalogueRunner func(context.Context, ...string) (string, error)

type catalogueCheckEnvelope struct {
	Healthy     *bool                            `json:"healthy"`
	Service     *data.CatalogueServiceStatus     `json:"service"`
	SourceIndex *data.CatalogueSourceIndexStatus `json:"sourceIndex"`
}

type catalogueRefreshEnvelope struct {
	Stats *data.CatalogueRefreshStats `json:"stats"`
}

// CataloguePreflight checks freshness, attempts an if-stale recovery, and fails open.
func CataloguePreflight(ctx context.Context) data.CatalogueStatus {
	return cataloguePreflight(ctx, Run)
}

// LoadSnapshot runs the catalogue preflight before reading the immutable caches.
func LoadSnapshot(ctx context.Context, options data.LoadOptions) (data.Snapshot, error) {
	catalogue := CataloguePreflight(ctx)
	snapshot, err := data.Load(options)
	if err != nil {
		return data.Snapshot{}, err
	}
	snapshot.Catalogue = catalogue
	return snapshot, nil
}

func cataloguePreflight(ctx context.Context, run catalogueRunner) data.CatalogueStatus {
	initial, initialErr := runCatalogueCheck(ctx, run)
	if initialErr == nil && initial.Healthy {
		return initial
	}
	if initialErr != nil {
		initial = data.CatalogueStatus{Checked: true, Failure: "check failed"}
	}

	refresh, refreshErr := runCatalogueRefresh(ctx, run)
	if refreshErr != nil {
		initial.Failure = "refresh failed"
		return initial
	}

	final, finalErr := runCatalogueCheck(ctx, run)
	if finalErr != nil {
		initial.Recovery = refresh
		initial.Failure = "recheck failed"
		return initial
	}
	final.Recovery = refresh
	if !final.Healthy {
		final.Failure = "recovery incomplete"
	}
	return final
}

func runCatalogueCheck(ctx context.Context, run catalogueRunner) (data.CatalogueStatus, error) {
	output, commandErr := run(ctx, "catalogue-service", "check", "--json")
	if output != "" {
		status, decodeErr := decodeCatalogueCheck(output)
		if decodeErr == nil {
			// The check command deliberately exits non-zero for a valid unhealthy
			// report; its JSON remains the source of truth for recovery and display.
			return status, nil
		}
		if commandErr == nil {
			return data.CatalogueStatus{}, decodeErr
		}
	}
	if commandErr != nil {
		return data.CatalogueStatus{}, commandErr
	}
	return data.CatalogueStatus{}, errors.New("ccs catalogue-service check returned no JSON")
}

func runCatalogueRefresh(ctx context.Context, run catalogueRunner) (data.CatalogueRefreshStats, error) {
	output, err := run(ctx, "catalogue-service", "refresh", "--if-stale", "--json")
	if err != nil {
		return data.CatalogueRefreshStats{}, err
	}
	var envelope catalogueRefreshEnvelope
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		return data.CatalogueRefreshStats{}, fmt.Errorf("decode catalogue refresh: %w", err)
	}
	if envelope.Stats == nil {
		return data.CatalogueRefreshStats{}, fmt.Errorf("decode catalogue refresh: missing stats")
	}
	return *envelope.Stats, nil
}

func decodeCatalogueCheck(output string) (data.CatalogueStatus, error) {
	var envelope catalogueCheckEnvelope
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		return data.CatalogueStatus{}, fmt.Errorf("decode catalogue check: %w", err)
	}
	if envelope.Healthy == nil || envelope.Service == nil || envelope.SourceIndex == nil {
		return data.CatalogueStatus{}, fmt.Errorf("decode catalogue check: missing required fields")
	}
	switch envelope.SourceIndex.State {
	case "fresh", "stale", "unavailable":
	default:
		return data.CatalogueStatus{}, fmt.Errorf("decode catalogue check: unsupported source state %q", envelope.SourceIndex.State)
	}
	return data.CatalogueStatus{
		Checked:      true,
		Healthy:      *envelope.Healthy,
		ServiceKnown: true,
		Service:      *envelope.Service,
		SourceIndex:  *envelope.SourceIndex,
	}, nil
}
