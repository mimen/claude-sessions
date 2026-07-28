package ui

import (
	"strings"
	"testing"

	"github.com/mimen/claude-sessions/tui-go/data"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func TestHeaderHidesHealthyCatalogueIncludingStoppedService(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Catalogue = data.CatalogueStatus{
		Checked: true,
		Healthy: true,
		Service: data.CatalogueServiceStatus{Running: false},
		SourceIndex: data.CatalogueSourceIndexStatus{
			State: "fresh",
		},
	}
	header := ansi.Strip(New(snapshot).renderHeader(100))
	if strings.Contains(header, "catalogue") {
		t.Fatalf("healthy header exposed catalogue state:\n%s", header)
	}
}

func TestHeaderShowsRecoveredCatalogueBriefly(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Catalogue = data.CatalogueStatus{
		Checked:  true,
		Healthy:  true,
		Recovery: data.CatalogueRefreshStats{Parsed: 3, Removed: 1},
		SourceIndex: data.CatalogueSourceIndexStatus{
			State: "fresh",
		},
	}
	model := New(snapshot)
	header := ansi.Strip(model.renderHeader(100))
	for _, want := range []string{"catalogue caught up", "3 indexed", "1 removed"} {
		if !strings.Contains(header, want) {
			t.Fatalf("recovered header missing %q:\n%s", want, header)
		}
	}
	updated, _ := model.Update(catalogueNoticeExpiredMsg{generation: model.catalogue.noticeGeneration})
	expired := updated.(Model)
	if header := ansi.Strip(expired.renderHeader(100)); strings.Contains(header, "catalogue caught up") {
		t.Fatalf("recovery notice remained after expiry:\n%s", header)
	}
}

func TestHeaderShowsPersistentStaleCatalogueDetail(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Catalogue = data.CatalogueStatus{
		Checked:      true,
		Healthy:      false,
		Failure:      "refresh failed",
		ServiceKnown: true,
		Service:      data.CatalogueServiceStatus{Running: false},
		SourceIndex: data.CatalogueSourceIndexStatus{
			State:             "stale",
			LagMs:             4 * 60 * 1000,
			OutOfSyncSessions: 2,
		},
	}
	header := ansi.Strip(New(snapshot).renderHeader(100))
	for _, want := range []string{"catalogue stale", "4m lag", "2 sessions out of sync", "refresh failed", "service stopped"} {
		if !strings.Contains(header, want) {
			t.Fatalf("stale header missing %q:\n%s", want, header)
		}
	}
}

func TestHeaderDistinguishesUnavailableCatalogue(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Catalogue = data.CatalogueStatus{
		Checked:      true,
		Healthy:      false,
		Failure:      "check failed",
		ServiceKnown: false,
		SourceIndex: data.CatalogueSourceIndexStatus{
			State: "unavailable",
		},
	}
	header := ansi.Strip(New(snapshot).renderHeader(100))
	for _, want := range []string{"catalogue unavailable", "source/index unreadable", "check failed", "service unknown"} {
		if !strings.Contains(header, want) {
			t.Fatalf("unavailable header missing %q:\n%s", want, header)
		}
	}
	if strings.Contains(header, "catalogue stale") {
		t.Fatalf("unavailable header was mislabeled stale:\n%s", header)
	}
}

func TestNarrowHeaderKeepsCatalogueWarningWithinWidth(t *testing.T) {
	const width = 24
	snapshot := testSnapshot(3)
	snapshot.Catalogue = data.CatalogueStatus{
		Checked:      true,
		Healthy:      false,
		ServiceKnown: true,
		Service:      data.CatalogueServiceStatus{Running: false},
		SourceIndex: data.CatalogueSourceIndexStatus{
			State: "stale",
			LagMs: 90 * 60 * 1000,
		},
	}
	header := New(snapshot).renderHeader(width)
	lines := strings.Split(header, "\n")
	if len(lines) != 2 {
		t.Fatalf("header lines = %d:\n%s", len(lines), header)
	}
	if !strings.Contains(ansi.Strip(lines[1]), "catalogue stale") {
		t.Fatalf("narrow warning was displaced:\n%s", ansi.Strip(header))
	}
	for index, line := range lines {
		if got := lipgloss.Width(line); got > width {
			t.Fatalf("line %d width = %d, want <= %d: %q", index, got, width, ansi.Strip(line))
		}
	}
}
