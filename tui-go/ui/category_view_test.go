package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestCategoryColumnWidthFallbackAndPreview(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].CategoryName = "Events, Booking & Live Production"
	snapshot.Sessions[0].CategoryCompact = "Events"
	snapshot.Sessions[0].CategoryColor = "#692EC2"
	model := New(snapshot)

	if header := ansi.Strip(model.renderListHeader(81)); strings.Contains(header, "CATEGORY") {
		t.Fatalf("narrow header exposed category: %q", header)
	}
	if header := ansi.Strip(model.renderListHeader(82)); !strings.Contains(header, "CATEGORY") {
		t.Fatalf("wide header omitted category: %q", header)
	}
	if row := ansi.Strip(model.renderSessionRow(82, snapshot.Sessions[0], 0, false)); !strings.Contains(row, "Events") {
		t.Fatalf("wide row omitted category: %q", row)
	}
	if preview := ansi.Strip(model.renderPreview(64, 40)); !strings.Contains(preview, "Events, Booking & Live Production") {
		t.Fatalf("preview omitted full category: %q", preview)
	}
}

func TestCategoryPreviewUsesExplicitUncategorizedFallback(t *testing.T) {
	snapshot := testSnapshot(1)
	model := New(snapshot)
	if preview := ansi.Strip(model.renderPreview(64, 40)); !strings.Contains(preview, "Uncategorized") {
		t.Fatalf("preview omitted fallback: %q", preview)
	}
}
