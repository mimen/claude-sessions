package data

import "testing"

func TestBuildRollupsDeduplicatesCausalAndNativeEdges(t *testing.T) {
	indexed := []indexedSession{
		{
			ID:          "parent",
			ResumeID:    "resume-parent",
			CostUSD:     10,
			CostByModel: map[string]float64{"claude-opus-4-8": 10},
		},
		{
			ID:              "child",
			ResumeID:        "child",
			IsSubagent:      true,
			ParentSessionID: "resume-parent",
			CostUSD:         5,
			CostByModel:     map[string]float64{"gpt-5.6-sol": 5},
		},
	}
	catalogue := map[string]catalogueMeta{
		"child": {SessionID: "child", ParentSessionID: "parent"},
	}
	rollups, counts := buildRollups(indexed, catalogue)
	parent := rollups["parent"]
	if parent.Total != 15 || parent.Providers.Claude != 10 || parent.Providers.GPT != 5 {
		t.Fatalf("unexpected parent rollup: %+v", parent)
	}
	if parent.Descendant != 1 {
		t.Fatalf("descendants = %d, want 1", parent.Descendant)
	}
	if counts["parent"] != 1 {
		t.Fatalf("subagent count = %d, want 1", counts["parent"])
	}
}

func TestBuildStatsExcludesLoopsFromActiveAndParked(t *testing.T) {
	sessions := []Session{
		{ID: "loop", Title: "loop", State: "active", IsLoop: true, TotalCost: 7},
		{ID: "work", Title: "work", State: "active", TotalCost: 3},
		{ID: "parked-loop", Title: "parked", State: "parked", IsLoop: true, TotalCost: 2},
	}
	rollups := map[string]sessionRollup{
		"loop":        {Total: 7},
		"work":        {Total: 3},
		"parked-loop": {Total: 2},
	}
	stats := buildStats(t.TempDir(), t.TempDir(), sessions, nil, nil, rollups)
	if stats.Active != 1 || stats.Parked != 0 || stats.Loops != 2 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestIncludeSessionHonorsViewOptions(t *testing.T) {
	saved := catalogueMeta{Saved: true}
	auxiliary := catalogueMeta{SessionClass: "auxiliary"}
	subagent := indexedSession{IsSubagent: true}
	defaults := DefaultLoadOptions()
	if includeSession(subagent, catalogueMeta{}, defaults) || includeSession(indexedSession{}, saved, defaults) || includeSession(indexedSession{}, auxiliary, defaults) {
		t.Fatal("default options included a hidden session class")
	}
	all := LoadOptions{IncludeSaved: true, IncludeSubagents: true, IncludeAuxiliary: true}
	if !includeSession(subagent, catalogueMeta{}, all) || !includeSession(indexedSession{}, saved, all) || !includeSession(indexedSession{}, auxiliary, all) {
		t.Fatal("inclusive options hid a requested session class")
	}
}

func TestDispositionShowsSavedAndFoldsArchiveIntoDone(t *testing.T) {
	if got := disposition(catalogueMeta{Saved: true}, false); got != "saved" {
		t.Fatalf("saved disposition = %q", got)
	}
	if got := disposition(catalogueMeta{Archived: true}, false); got != "completed" {
		t.Fatalf("archived disposition = %q, want completed", got)
	}
}

func TestBuildRollupsGuardsCycles(t *testing.T) {
	indexed := []indexedSession{
		{ID: "a", ResumeID: "a", CostUSD: 2, CostByModel: map[string]float64{"claude-opus-4-8": 2}},
		{ID: "b", ResumeID: "b", CostUSD: 3, CostByModel: map[string]float64{"gpt-5.6-sol": 3}},
	}
	catalogue := map[string]catalogueMeta{
		"a": {SessionID: "a", ParentSessionID: "b"},
		"b": {SessionID: "b", ParentSessionID: "a"},
	}
	rollups, _ := buildRollups(indexed, catalogue)
	if rollups["a"].Total != 5 || rollups["b"].Total != 5 {
		t.Fatalf("cycle totals: a=%v b=%v", rollups["a"].Total, rollups["b"].Total)
	}
}
