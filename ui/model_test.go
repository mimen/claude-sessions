package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ccsspike/data"
	"ccsspike/inference"
	"ccsspike/skills"
	"ccsspike/transcript"

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
			assertViewFits(t, model, fmt.Sprintf("overlay %d", overlay))
		}
		model.overlay = OverlayNone
		model.reader = &transcriptReader{title: "reader", document: transcript.Document{Lines: []transcript.Line{{Kind: transcript.KindUser, Text: strings.Repeat("long ", 100)}}}}
		assertViewFits(t, model, "transcript reader")
		model.reader = nil
		model.confirmation = &confirmation{kind: confirmCleanup, title: "cleanup", items: []confirmationItem{{title: strings.Repeat("session ", 20), detail: strings.Repeat("reason ", 20), enabled: true}}}
		assertViewFits(t, model, "confirmation")
		model.confirmation = nil
		model.fleetResults = &fleetResults{query: strings.Repeat("question ", 20), matches: []inference.AskMatch{{Title: strings.Repeat("match ", 20), Answer: strings.Repeat("answer ", 20), Reason: strings.Repeat("reason ", 20)}}}
		assertViewFits(t, model, "fleet results")
		model.fleetResults = nil
		model.mode = ModeSkills
		model.skills = skills.Snapshot{Skills: []skills.Skill{{Name: strings.Repeat("skill ", 20), Description: strings.Repeat("description ", 20), Category: "dev", Home: "global"}}}
		model.rebuildSkillRows()
		assertViewFits(t, model, "skills mode")
	}
}

func assertViewFits(t *testing.T, model Model, label string) {
	t.Helper()
	view := model.View()
	lines := strings.Split(view, "\n")
	if len(lines) > model.h {
		t.Fatalf("%dx%d %s rendered %d lines", model.w, model.h, label, len(lines))
	}
	for lineNumber, line := range lines {
		if width := lipgloss.Width(line); width > model.w {
			t.Fatalf("%dx%d %s line %d width = %d", model.w, model.h, label, lineNumber+1, width)
		}
	}
}

func TestSkillsRowsGroupByCategoryAndSearchDescription(t *testing.T) {
	registry := []skills.Skill{
		{Name: "alpha", Category: "dev", Description: "build the gateway"},
		{Name: "beta", Category: "events"},
		{Name: "gamma", Category: "dev"},
	}
	rows := buildSkillRows(registry, skillViewCategory, "gateway")
	if len(rows) != 2 || !rows[0].header || rows[0].label != "dev" || rows[1].sIdx != 0 {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestFleetCandidateRankingUsesIndexedSkeleton(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Sessions[2].Skeleton = "user: configured the grok build runner"
	indexes := fleetCandidateIndexes(snapshot.Sessions, "grok build", 3)
	if len(indexes) == 0 || indexes[0] != 2 {
		t.Fatalf("indexes = %v, want session 2 first", indexes)
	}
}

func TestDefaultResumeUsesOriginBackendAndResumeID(t *testing.T) {
	root := t.TempDir()
	config := `
[[launcher]]
name = "claude"
binary = "claude"
serves = ["*"]

[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-*"]
`
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_ROOT", root)
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].CWD = t.TempDir()
	snapshot.Sessions[0].ResumeID = "internal-id"
	snapshot.Sessions[0].Models = []string{"gpt-5.6-sol"}
	model := New(snapshot)
	updated, command := model.resumeDefault()
	if command == nil {
		t.Fatal("resumeDefault returned no quit command")
	}
	final := updated.(Model)
	handoff, ok := final.Handoff()
	if !ok || strings.Join(handoff.Argv, " ") != "claude-gpt --resume internal-id" {
		t.Fatalf("handoff = %+v, ok=%v", handoff, ok)
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
