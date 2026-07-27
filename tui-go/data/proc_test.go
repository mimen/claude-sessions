package data

import (
	"testing"
	"time"
)

func TestFormatFootprint(t *testing.T) {
	cases := []struct {
		bytes uint64
		want  string
	}{
		{0, ""},
		{512, "1M"},          // sub-MB rounds up rather than showing noise
		{4 << 20, "4.0M"},    // one decimal below 10
		{342 << 20, "342M"},  // no decimal above 10
		{1610612736, "1.5G"}, // 1.5 GiB
		{42 << 30, "42G"},    // the runaway case that motivated the column
	}
	for _, tc := range cases {
		if got := FormatFootprint(tc.bytes); got != tc.want {
			t.Errorf("FormatFootprint(%d) = %q, want %q", tc.bytes, got, tc.want)
		}
	}
	for _, tc := range cases {
		if got := FormatFootprint(tc.bytes); len(got) > 4 {
			t.Errorf("FormatFootprint(%d) = %q, wider than the 4-char column", tc.bytes, got)
		}
	}
}

func TestWalkTreeAggregatesDescendants(t *testing.T) {
	// A session root with one direct child and one grandchild — the shape a
	// runaway tool subprocess actually takes.
	records := map[int]procRecord{
		100: {PID: 100, PPID: 1, Name: "2.1.219", Footprint: 300, Peak: 400, CPUNanos: 10},
		200: {PID: 200, PPID: 100, Name: "zsh", Footprint: 5, Peak: 5, CPUNanos: 1},
		300: {PID: 300, PPID: 200, Name: "ugrep", Footprint: 9000, Peak: 42000, CPUNanos: 99},
		400: {PID: 400, PPID: 1, Name: "unrelated", Footprint: 7777, Peak: 7777},
	}
	children := map[int][]int{1: {100, 400}, 100: {200}, 200: {300}}

	stat := walkTree(100, records, children)

	if stat.ProcessCount != 3 {
		t.Errorf("ProcessCount = %d, want 3 (root + child + grandchild)", stat.ProcessCount)
	}
	if stat.Footprint != 9305 {
		t.Errorf("Footprint = %d, want 9305 (unrelated sibling must not be counted)", stat.Footprint)
	}
	if stat.Peak != 42405 {
		t.Errorf("Peak = %d, want 42405 (summed peaks)", stat.Peak)
	}
	if stat.Peak < stat.Footprint {
		t.Errorf("Peak %d < Footprint %d — peak must never read below current", stat.Peak, stat.Footprint)
	}
	if stat.CPUNanos != 110 {
		t.Errorf("CPUNanos = %d, want 110", stat.CPUNanos)
	}
	// The grandchild is the answer to "what is eating my RAM", not the root.
	if stat.HeaviestName != "ugrep" || stat.HeaviestFootprint != 9000 {
		t.Errorf("heaviest = %s/%d, want ugrep/9000", stat.HeaviestName, stat.HeaviestFootprint)
	}
	if stat.HeaviestIsRoot {
		t.Error("HeaviestIsRoot = true, want false — the grandchild dominates")
	}
}

func TestWalkTreeSurvivesParentCycle(t *testing.T) {
	// A racing or corrupt parent chain must not spin the walk forever.
	records := map[int]procRecord{
		10: {PID: 10, PPID: 20, Footprint: 1},
		20: {PID: 20, PPID: 10, Footprint: 2},
	}
	children := map[int][]int{20: {10}, 10: {20}}

	done := make(chan ProcStat, 1)
	go func() { done <- walkTree(10, records, children) }()
	select {
	case stat := <-done:
		if stat.ProcessCount != 2 {
			t.Errorf("ProcessCount = %d, want 2", stat.ProcessCount)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("walkTree did not terminate on a cyclic parent chain")
	}
}

func TestMarkerMatchesProcessRejectsRecycledPID(t *testing.T) {
	now := time.Now()
	root := procRecord{StartSecs: now.Unix()}

	fresh := sessionMarker{StartedAt: now.Add(-2 * time.Second).UnixMilli()}
	if !markerMatchesProcess(fresh, root) {
		t.Error("rejected a marker written moments before its process start")
	}

	// A marker left behind by a SIGKILLed session, whose PID was later reused.
	stale := sessionMarker{StartedAt: now.Add(-9 * time.Hour).UnixMilli()}
	if markerMatchesProcess(stale, root) {
		t.Error("accepted a stale marker against a recycled PID")
	}

	// Missing timing data is not evidence of a mismatch: a live marker file is
	// already strong evidence on its own.
	if !markerMatchesProcess(sessionMarker{}, procRecord{}) {
		t.Error("rejected a marker that carried no start time")
	}
}

func TestSampleProcStatsHandlesMissingHome(t *testing.T) {
	if stats := SampleProcStats(t.TempDir()); len(stats) != 0 {
		t.Errorf("expected no stats without a sessions dir, got %d", len(stats))
	}
}
