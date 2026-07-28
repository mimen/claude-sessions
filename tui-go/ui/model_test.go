package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mimen/claude-sessions/tui-go/data"
	"github.com/mimen/claude-sessions/tui-go/inference"
	"github.com/mimen/claude-sessions/tui-go/skills"
	"github.com/mimen/claude-sessions/tui-go/transcript"

	tea "github.com/charmbracelet/bubbletea"
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
	// Sessions sit directly under the cluster header — no role sub-sections
	// (role is shown in its own column).
	want := []string{"cluster:event-watch", "no-system", "no-system:parked", "no-system:done"}
	if fmt.Sprint(headers) != fmt.Sprint(want) {
		t.Fatalf("headers = %v, want %v", headers, want)
	}
}

func TestFuzzySearchIncludesTaskSubjects(t *testing.T) {
	snapshot := testSnapshot(2)
	snapshot.Sessions[1].TaskSubjects = []string{"Configure grok build runner"}
	rows := buildFlatRows(snapshot.Sessions, "grk bld", sortRecency, taskFilterAll, nil)
	if len(rows) != 1 || rows[0].sIdx != 1 {
		t.Fatalf("rows = %+v, want only session 1", rows)
	}
}

func TestCostAndMessageSortOrderRowsDescending(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Sessions[0].TotalCost = 3
	snapshot.Sessions[1].TotalCost = 9
	snapshot.Sessions[2].TotalCost = 5
	snapshot.Sessions[0].Messages = 20
	snapshot.Sessions[1].Messages = 4
	snapshot.Sessions[2].Messages = 12

	costRows := buildFlatRows(snapshot.Sessions, "", sortCost, taskFilterAll, nil)
	if got := []int{costRows[0].sIdx, costRows[1].sIdx, costRows[2].sIdx}; fmt.Sprint(got) != "[1 2 0]" {
		t.Fatalf("cost order = %v", got)
	}
	messageRows := buildFlatRows(snapshot.Sessions, "", sortMessages, taskFilterAll, nil)
	if got := []int{messageRows[0].sIdx, messageRows[1].sIdx, messageRows[2].sIdx}; fmt.Sprint(got) != "[0 2 1]" {
		t.Fatalf("message order = %v", got)
	}
}

func TestMemorySortOrdersByLiveFootprint(t *testing.T) {
	snapshot := testSnapshot(3)
	tests := []struct {
		name       string
		footprints map[string]uint64
		useNil     bool
		want       []int
	}{
		{
			name: "descending footprint",
			footprints: map[string]uint64{
				snapshot.Sessions[0].ID: 3,
				snapshot.Sessions[1].ID: 9,
				snapshot.Sessions[2].ID: 5,
			},
			want: []int{1, 2, 0},
		},
		{
			name: "sessions without a process sort last",
			footprints: map[string]uint64{
				snapshot.Sessions[2].ID: 1,
			},
			want: []int{2, 0, 1},
		},
		{
			name:   "nil accessor is safe",
			useNil: true,
			want:   []int{0, 1, 2},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var footprint func(data.Session) uint64
			if !test.useNil {
				footprint = func(session data.Session) uint64 {
					return test.footprints[session.ID]
				}
			}
			rows := buildFlatRows(snapshot.Sessions, "", sortMemory, taskFilterAll, footprint)
			got := make([]int, len(rows))
			for index, candidate := range rows {
				got[index] = candidate.sIdx
			}
			if fmt.Sprint(got) != fmt.Sprint(test.want) {
				t.Fatalf("memory order = %v, want %v", got, test.want)
			}
		})
	}
}

func TestTaskFiltersDistinguishUnfinishedAndInterrupted(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Sessions[0].TasksDone, snapshot.Sessions[0].TasksTotal = 1, 2
	snapshot.Sessions[0].TasksInProgress = 1
	snapshot.Sessions[1].TasksDone, snapshot.Sessions[1].TasksTotal = 0, 1
	snapshot.Sessions[1].TasksInProgress = 1
	snapshot.Sessions[1].State = "active"
	snapshot.Sessions[2].TasksDone, snapshot.Sessions[2].TasksTotal = 1, 1

	unfinished := buildFlatRows(snapshot.Sessions, "", sortRecency, taskFilterUnfinished, nil)
	if len(unfinished) != 2 {
		t.Fatalf("unfinished rows = %+v", unfinished)
	}
	interrupted := buildFlatRows(snapshot.Sessions, "", sortRecency, taskFilterInterrupted, nil)
	if len(interrupted) != 1 || interrupted[0].sIdx != 0 {
		t.Fatalf("interrupted rows = %+v", interrupted)
	}
}

func TestViewOptionSortAppliesLiveAndPreservesSelection(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	model := New(testSnapshot(4))
	selected, ok := model.selectedSession()
	if !ok {
		t.Fatal("no selected session")
	}
	model.view = ViewFlat
	model.rebuildRowsPreserving(selected.ID)
	model.viewOptionCursor = int(viewOptionSort)
	updated, command := model.adjustViewOption(1)
	if command != nil {
		t.Fatal("sort adjustment unexpectedly required I/O")
	}
	model = updated.(Model)
	if model.options.sort != sortCost {
		t.Fatalf("sort = %s", model.options.sort)
	}
	current, ok := model.selectedSession()
	if !ok || current.ID != selected.ID {
		t.Fatalf("selection = %+v, want %s", current, selected.ID)
	}
}

func TestAutoRefreshTickSchedulesReloadAndNextTick(t *testing.T) {
	model := New(testSnapshot(2))
	updated, command := model.Update(autoRefreshMsg{generation: model.tickerGeneration})
	model = updated.(Model)
	if command == nil || !model.refreshInFlight {
		t.Fatalf("command=%v refreshInFlight=%t", command, model.refreshInFlight)
	}
	updated, staleCommand := model.Update(autoRefreshMsg{generation: model.tickerGeneration + 1})
	if staleCommand != nil || updated.(Model).tickerGeneration != model.tickerGeneration {
		t.Fatal("stale autorefresh tick was not ignored")
	}
}

func TestCatalogueCheckThrottleAllowsOneStoreScanPerFiveMinutes(t *testing.T) {
	checkedAt := time.Date(2026, time.July, 28, 12, 0, 0, 0, time.UTC)
	state := catalogueViewState{checkedAt: checkedAt}
	if state.shouldCheck(checkedAt.Add(catalogueCheckInterval - time.Second)) {
		t.Fatal("catalogue check was due before the five-minute interval")
	}
	if !state.shouldCheck(checkedAt.Add(catalogueCheckInterval)) {
		t.Fatal("catalogue check was not due at the five-minute interval")
	}
	if !(catalogueViewState{}).shouldCheck(checkedAt) {
		t.Fatal("never-checked catalogue did not request a check")
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
		for _, overlay := range []Overlay{OverlayNone, OverlayHelp, OverlayRoute, OverlayViewOptions} {
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

func TestTranscriptPeekDeduplicatesTailLoadAndFullReaderLoadsSeparately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	old := `{"type":"user","message":{"role":"user","content":"` + strings.Repeat("old", 200_000) + `"}}` + "\n"
	recent := `{"type":"assistant","message":{"role":"assistant","content":"recent answer"}}` + "\n"
	if err := os.WriteFile(path, []byte(old+recent), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].Path = path
	model := New(snapshot)
	peekCmd := model.loadSelectedTranscriptCmd()
	if peekCmd == nil {
		t.Fatal("first peek load returned no command")
	}
	if duplicate := model.loadSelectedTranscriptCmd(); duplicate != nil {
		t.Fatal("in-flight peek load was not deduplicated")
	}
	peekMsg, ok := peekCmd().(transcriptLoadedMsg)
	if !ok || peekMsg.full || peekMsg.err != nil || !peekMsg.document.Truncated {
		t.Fatalf("peek message = %+v", peekMsg)
	}
	updated, _ := model.Update(peekMsg)
	model = updated.(Model)
	if len(model.transcripts[snapshot.Sessions[0].ID].Lines) == 0 {
		t.Fatal("peek document was not cached")
	}

	updated, fullCmd := model.openTranscriptReader()
	model = updated.(Model)
	if fullCmd == nil || model.reader != nil {
		t.Fatal("reader reused the bounded peek instead of loading the full transcript")
	}
	fullMsg, ok := fullCmd().(transcriptLoadedMsg)
	if !ok || !fullMsg.full || fullMsg.err != nil || fullMsg.document.Truncated {
		t.Fatalf("full message = %+v", fullMsg)
	}
	updated, _ = model.Update(fullMsg)
	model = updated.(Model)
	if model.reader == nil || len(model.reader.visual) == 0 {
		t.Fatal("full transcript reader did not precompute visual rows")
	}
}

func TestSkillScanWarningsRemainVisibleWithoutHidingResults(t *testing.T) {
	model := New(testSnapshot(1))
	updated, _ := model.Update(skillsLoadedMsg{snapshot: skills.Snapshot{
		Skills:   []skills.Skill{{Name: "visible"}},
		Warnings: []string{"skill scan was partial: timeout"},
	}})
	model = updated.(Model)
	if model.skillWarning == "" || len(model.skillRows) == 0 {
		t.Fatalf("warning=%q rows=%+v", model.skillWarning, model.skillRows)
	}
}

func TestSkillRescanCommandBypassesCacheLoader(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, "Documents", "custom", "skills", "fresh", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nname: fresh\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	message, ok := scanSkillsCmd()().(skillsLoadedMsg)
	if !ok || message.err != nil {
		t.Fatalf("rescan message = %+v", message)
	}
	if message.snapshot.Source != "filesystem scan" || len(message.snapshot.Skills) != 1 || message.snapshot.Skills[0].Name != "fresh" {
		t.Fatalf("rescan snapshot = %+v", message.snapshot)
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

func TestSkillsNameAndActivityViewsRetainDuplicateAndUsageSignals(t *testing.T) {
	now := time.Now()
	registry := []skills.Skill{
		{Name: "shared", Home: "codex", Usage: skills.Usage{LastUsed: now.Format(time.RFC3339Nano)}},
		{Name: "shared", Home: "claude", Usage: skills.Usage{LastUsed: now.Add(-60 * 24 * time.Hour).Format(time.RFC3339Nano)}},
		{Name: "unique", Home: "cursor"},
	}
	nameRows := buildSkillRows(registry, skillViewName, "")
	if len(nameRows) != 5 || nameRows[0].label != "shared" || nameRows[3].label != "(unique names)" {
		t.Fatalf("name rows = %+v", nameRows)
	}
	activityRows := buildSkillRows(registry, skillViewActivity, "")
	headers := make([]string, 0, 3)
	for _, row := range activityRows {
		if row.header {
			headers = append(headers, row.label)
		}
	}
	if got := strings.Join(headers, ","); got != "active,dormant,unobserved" {
		t.Fatalf("activity headers = %q", got)
	}
}

func TestFleetCandidateRankingUsesIndexedSkeleton(t *testing.T) {
	snapshot := testSnapshot(3)
	snapshot.Sessions[2].Skeleton = "user: configured the grok build runner"
	indexes := fleetCandidateIndexes(snapshot.Sessions, "grok build", 3)
	if len(indexes) == 0 || indexes[0] != 2 {
		t.Fatalf("indexes = %v, want session 2 first", indexes)
	}
	if all := fleetCandidateIndexes(snapshot.Sessions, "grok build", 0); len(all) != len(snapshot.Sessions) {
		t.Fatalf("unlimited fleet candidates = %d, want %d", len(all), len(snapshot.Sessions))
	}
}

func TestDefaultResumeUsesFinalModelBackendAndResumeID(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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

	tests := []struct {
		name      string
		models    []string
		lastModel string
		wantArgv  string
	}{
		{name: "native to gpt", models: []string{"claude-fable-5", "gpt-5.6-sol"}, lastModel: "gpt-5.6-sol", wantArgv: "claude-gpt --resume internal-id"},
		{name: "gpt to native", models: []string{"gpt-5.6-sol", "claude-fable-5"}, lastModel: "claude-fable-5", wantArgv: "claude --resume internal-id"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := testSnapshot(1)
			snapshot.Sessions[0].CWD = t.TempDir()
			snapshot.Sessions[0].ResumeID = "internal-id"
			snapshot.Sessions[0].Models = test.models
			snapshot.Sessions[0].LastModel = test.lastModel
			model := New(snapshot)
			updated, command := model.resumeDefault()
			if command == nil {
				t.Fatal("resumeDefault returned no quit command")
			}
			handoff, ok := updated.(Model).Handoff()
			if !ok || strings.Join(handoff.Argv, " ") != test.wantArgv {
				t.Fatalf("handoff = %+v, ok=%v, want %q", handoff, ok, test.wantArgv)
			}
		})
	}
}

// writeHarnessConfig points CCS_ROOT at a two-harness fleet with no catch-all,
// and isolates preferences so a run never reads or writes the real ones.
func writeHarnessConfig(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	config := `
[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*"]

[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-*"]
`
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_ROOT", root)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

// openHarnessPicker opens `r` on the only session and settles the loaded routes.
func openHarnessPicker(t *testing.T, model Model) Model {
	t.Helper()
	updated, command := model.openRoutePicker()
	if command == nil {
		t.Fatal("route picker loaded no routes")
	}
	message, ok := command().(routesLoadedMsg)
	if !ok || message.err != nil {
		t.Fatalf("routes message = %+v", message)
	}
	updated, _ = updated.(Model).Update(message)
	return updated.(Model)
}

// The picker is a free choice of harness: a claude-only history can be replayed
// on claude-gpt and the reverse, with no force flag and no extra confirmation.
func TestRoutePickerResumesOnAnyHarness(t *testing.T) {
	tests := []struct {
		name     string
		models   []string
		steps    int
		wantArgv string
	}{
		{name: "origin harness", models: []string{"claude-fable-5"}, wantArgv: "claude-native --resume internal-id"},
		{name: "claude history crossed to gpt", models: []string{"claude-fable-5"}, steps: 1, wantArgv: "claude-gpt --resume internal-id"},
		{name: "gpt history crossed to native", models: []string{"gpt-5.6-sol"}, steps: -1, wantArgv: "claude-native --resume internal-id"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			writeHarnessConfig(t)
			snapshot := testSnapshot(1)
			snapshot.Sessions[0].CWD = t.TempDir()
			snapshot.Sessions[0].ResumeID = "internal-id"
			snapshot.Sessions[0].Models = test.models
			model := openHarnessPicker(t, New(snapshot))

			key := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}}
			if test.steps < 0 {
				key = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}}
			}
			for step := 0; step < abs(test.steps); step++ {
				updated, _ := model.Update(key)
				model = updated.(Model)
			}
			updated, command := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
			if command == nil {
				t.Fatal("enter on the selected harness did not hand off")
			}
			handoff, ok := updated.(Model).Handoff()
			if !ok || strings.Join(handoff.Argv, " ") != test.wantArgv {
				t.Fatalf("handoff = %+v ok=%v, want %q", handoff, ok, test.wantArgv)
			}
		})
	}
}

// A stale row with no final model retains the legacy whole-history behavior, so
// the harness chosen last seeds the preselection when the history spans harnesses.
func TestChosenHarnessPersistsAndSeedsStaleCrossedHistories(t *testing.T) {
	writeHarnessConfig(t)
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].CWD = t.TempDir()
	snapshot.Sessions[0].ResumeID = "internal-id"
	snapshot.Sessions[0].Models = []string{"claude-fable-5"}
	model := openHarnessPicker(t, New(snapshot))
	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	updated, _ = updated.(Model).Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := updated.(Model).lastLauncher; got != "claude-gpt" {
		t.Fatalf("lastLauncher = %q, want claude-gpt", got)
	}

	snapshot.Sessions[0].Models = []string{"claude-fable-5", "gpt-5.6-sol"}
	snapshot.Sessions[0].LastModel = ""
	restored := New(snapshot)
	if restored.lastLauncher != "claude-gpt" {
		t.Fatalf("restored lastLauncher = %q", restored.lastLauncher)
	}
	restored = openHarnessPicker(t, restored)
	if restored.routes[restored.routeCursor].Name != "claude-gpt" {
		t.Fatalf("preselected %+v, want claude-gpt", restored.routes[restored.routeCursor])
	}
}

func TestDefaultRouteIndexPrefersOriginThenLastHarness(t *testing.T) {
	crossed := []data.Launcher{
		{Name: "claude-native", Target: "inline"},
		{Name: "claude-gpt", Target: "inline"},
		{Name: "claude-native", Target: "cmux"},
		{Name: "claude-gpt", Target: "cmux"},
	}
	origin := append([]data.Launcher(nil), crossed...)
	origin[0].Default = true

	tests := []struct {
		name      string
		routes    []data.Launcher
		preferred string
		want      int
	}{
		{name: "origin outranks the preference", routes: origin, preferred: "claude-gpt", want: 0},
		{name: "preference resolves a crossed history", routes: crossed, preferred: "claude-gpt", want: 1},
		{name: "preference never selects a cmux target", routes: crossed[2:], preferred: "claude-gpt", want: 0},
		{name: "unknown preference falls back to the first route", routes: crossed, preferred: "gone", want: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := defaultRouteIndex(test.routes, test.preferred); got != test.want {
				t.Fatalf("defaultRouteIndex() = %d, want %d", got, test.want)
			}
		})
	}
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func TestPreviewClassPreservesWorkBody(t *testing.T) {
	session := data.Session{SessionClass: "work_body"}
	if got := previewClass(session); got != "work_body" {
		t.Fatalf("previewClass() = %q", got)
	}
}

func TestStageAndPRColumnsRenderAtWideWidth(t *testing.T) {
	snapshot := testSnapshot(1)
	snapshot.Sessions[0].Stage = "milad-review"
	snapshot.Sessions[0].PRNumber = 42
	snapshot.Sessions[0].PRState = "open"
	model := New(snapshot)
	model.w = 132
	model.preview = false
	view := model.View()
	for _, wanted := range []string{"STAGE", "milad-rev", "#42"} {
		if !strings.Contains(view, wanted) {
			t.Fatalf("view did not contain %q", wanted)
		}
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
