package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestCategoryColumnWidthFallbackAndPreview(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].CategoryName = "Events, Booking & Live Production"
	snapshot.Sessions[0].CategoryCompact = "Personal Apps"
	snapshot.Sessions[0].CategoryColor = "#692EC2"
	model := New(snapshot)

	if header := ansi.Strip(model.renderListHeader(81)); strings.Contains(header, "CATEGORY") {
		t.Fatalf("narrow header exposed category: %q", header)
	}
	if header := ansi.Strip(model.renderListHeader(82)); !strings.Contains(header, "CATEGORY") {
		t.Fatalf("wide header omitted category: %q", header)
	}
	if row := ansi.Strip(model.renderSessionRow(82, snapshot.Sessions[0], 0, false)); !strings.Contains(row, "Personal Apps") {
		t.Fatalf("wide row truncated 13-character category: %q", row)
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

func TestCategoryRepairNoticeAndPreviewExposeFindingAndProvenance(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Warnings = []string{"category resolution failures: cycle=1, missing-parent=2"}
	snapshot.Sessions[0].CategoryName = "Category ancestry cycle"
	snapshot.Sessions[0].CategoryCompact = "Cycle"
	snapshot.Sessions[0].CategoryFinding = "cycle"
	snapshot.Sessions[0].CategorySource = "manual"
	snapshot.Sessions[0].CategoryFrom = "retained-root"
	model := New(snapshot)

	header := ansi.Strip(model.renderHeader(120))
	if !strings.Contains(header, "category repair needed") || !strings.Contains(header, "cycle=1") {
		t.Fatalf("header omitted category repair notice: %q", header)
	}
	preview := ansi.Strip(model.renderPreview(64, 40))
	for _, expected := range []string{"Category ancestry cycle", "Repair required: ancestry cycle", "manual · via retained-root · repair required"} {
		if !strings.Contains(preview, expected) {
			t.Fatalf("preview omitted %q: %q", expected, preview)
		}
	}
}

func TestInheritedCategoryPreviewNamesOrigin(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].CategoryName = "Events"
	snapshot.Sessions[0].CategoryCompact = "Events"
	snapshot.Sessions[0].CategoryFinding = "inherited"
	snapshot.Sessions[0].CategorySource = "birth"
	snapshot.Sessions[0].CategoryFrom = "parent-session"
	preview := ansi.Strip(New(snapshot).renderPreview(64, 40))
	for _, expected := range []string{"Inherited assignment", "birth · via parent-session"} {
		if !strings.Contains(preview, expected) {
			t.Fatalf("inherited preview omitted %q: %q", expected, preview)
		}
	}
}

func TestCategoryFailureLabelsFitColumnBudget(t *testing.T) {
	for _, label := range []string{"No registry", "Bad category", "No parent", "Too deep", "Aux no parent"} {
		if len([]rune(label)) > categoryTextWidth {
			t.Fatalf("failure label %q exceeds category text width", label)
		}
	}
}
