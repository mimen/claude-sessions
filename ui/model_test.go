package ui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"ccsspike/data"

	"github.com/charmbracelet/lipgloss"
)

func testSnapshot(sessionCount int) data.Snapshot {
	sessions := make([]data.Session, 0, sessionCount)
	byID := make(map[string]int)
	for i := 0; i < sessionCount; i++ {
		id := fmt.Sprintf("session-%03d", i)
		byID[id] = i
		sessions = append(sessions, data.Session{
			ID:        id,
			ResumeID:  id,
			Title:     fmt.Sprintf("Session %03d", i),
			State:     "idle",
			Project:   fmt.Sprintf("project-%d", i/10),
			LastAt:    time.Date(2026, time.July, 22, 12, 0, 0, 0, time.UTC).Add(-time.Duration(i) * time.Minute),
			Duration:  "1h",
			TotalCost: float64(i),
		})
	}
	return data.Snapshot{
		Sessions: sessions,
		ByID:     byID,
		LoadedAt: time.Date(2026, time.July, 22, 12, 0, 0, 0, time.UTC),
		Stats:    data.Dash{Host: "test", Sessions: sessionCount},
	}
}

func TestDefaultGroupingPutsClustersBeforeNoSystemStates(t *testing.T) {
	snapshot := testSnapshot(4)
	snapshot.Sessions[0].Cluster = "event-watch"
	snapshot.Sessions[0].Role = "coordinator"
	snapshot.Sessions[0].State = "active"
	snapshot.Sessions[1].Cluster = "event-watch"
	snapshot.Sessions[1].Role = "worker"
	snapshot.Sessions[2].State = "parked"
	snapshot.Sessions[3].State = "completed"
	model := New(snapshot)

	var headers []string
	for _, candidate := range model.rows {
		if candidate.header {
			headers = append(headers, candidate.key)
		}
	}
	want := []string{"cluster:event-watch", "cluster:event-watch:coordinator", "cluster:event-watch:worker", "no-system", "no-system:parked", "no-system:done"}
	if fmt.Sprint(headers) != fmt.Sprint(want) {
		t.Fatalf("headers = %v, want %v", headers, want)
	}
}

func TestFuzzySearchIncludesTaskSubjects(t *testing.T) {
	snapshot := testSnapshot(2)
	snapshot.Sessions[1].TaskSubjects = []string{"Configure grok build runner"}
	rows := buildFlatRows(snapshot.Sessions, "grk bld")
	if len(rows) != 1 || rows[0].sIdx != 1 {
		t.Fatalf("rows = %+v, want only session 1", rows)
	}
}

func TestListWindowStaysViewportBound(t *testing.T) {
	model := New(testSnapshot(200))
	model.cursor = len(model.rows) - 1
	start, end := model.listWindow(17)
	if end-start != 17 {
		t.Fatalf("window size = %d, want 17", end-start)
	}
	if end != len(model.rows) {
		t.Fatalf("end = %d, want %d", end, len(model.rows))
	}
}

func TestNarrowViewDoesNotOverflowOrPanic(t *testing.T) {
	for _, size := range [][2]int{{100, 20}, {28, 12}, {20, 12}, {7, 4}} {
		model := New(testSnapshot(20))
		model.w = size[0]
		model.h = size[1]
		for _, overlay := range []Overlay{OverlayNone, OverlayHelp, OverlayRoute} {
			model.overlay = overlay
			view := model.View()
			lines := strings.Split(view, "\n")
			if len(lines) > model.h {
				t.Fatalf("%dx%d overlay %d rendered %d lines", model.w, model.h, overlay, len(lines))
			}
			for lineNumber, line := range lines {
				if width := lipgloss.Width(line); width > model.w {
					t.Fatalf("%dx%d overlay %d line %d width = %d", model.w, model.h, overlay, lineNumber+1, width)
				}
			}
		}
	}
}

func TestPreviewClassPreservesWorkBody(t *testing.T) {
	session := data.Session{SessionClass: "work_body"}
	if got := previewClass(session); got != "work_body" {
		t.Fatalf("previewClass() = %q", got)
	}
}

func TestViewStripsTerminalControlsFromSnapshot(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].Title = "first\nsecond\x1b[2J"
	snapshot.Sessions[0].Project = "proj\rother"
	snapshot.Sessions[0].CWD = "/tmp/x\ny"
	model := New(snapshot)
	view := model.View()
	if strings.Contains(view, "\x1b[2J") || strings.Contains(view, "second\n") {
		t.Fatalf("view retained terminal control input")
	}
}
