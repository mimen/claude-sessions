package ui

import (
	"strings"
	"testing"

	"ccsspike/data"
)

// procTestModel builds a two-session browser where the first session has a live
// process tree and the second has none.
func procTestModel() (Model, data.Session, data.Session) {
	snapshot := testSnapshot(2)
	model := New(snapshot)
	model.w, model.h = 132, 40
	live := snapshot.Sessions[0]
	dead := snapshot.Sessions[1]
	model.procStats = map[string]data.ProcStat{
		live.ID: {
			RootPID:           4242,
			Footprint:         1610612736, // 1.5 GiB
			Peak:              3221225472, // 3.0 GiB
			ProcessCount:      3,
			HeaviestName:      "ugrep",
			HeaviestFootprint: 1073741824, // 1.0 GiB
			HeaviestIsRoot:    false,
		},
	}
	return model, live, dead
}

func TestSessionRowShowsMemoryOnlyForLiveSessions(t *testing.T) {
	model, live, dead := procTestModel()

	liveRow := model.renderSessionRow(100, live, 0, false)
	if !strings.Contains(liveRow, "1.5G") {
		t.Errorf("live row missing memory figure:\n%s", liveRow)
	}

	// A session with no running process must render blank, not "0" — the column
	// describes live processes, and "0" would be a claim about a dead one.
	deadRow := model.renderSessionRow(100, dead, 0, false)
	for _, unwanted := range []string{"1.5G", "0M", "0G"} {
		if strings.Contains(deadRow, unwanted) {
			t.Errorf("row for a session with no process contains %q:\n%s", unwanted, deadRow)
		}
	}
}

func TestSessionRowKeepsMemoryColumnAtPreviewWidth(t *testing.T) {
	model, live, _ := procTestModel()
	// The list pane gets ~58% of the terminal when the preview is open, so a
	// 132-wide window renders rows at ~74. The column has to survive that or it
	// is invisible in the default layout.
	if row := model.renderSessionRow(74, live, 0, false); !strings.Contains(row, "1.5G") {
		t.Errorf("memory column dropped at the default preview-open width:\n%s", row)
	}
	if header := model.renderListHeader(74); !strings.Contains(header, "MEM") {
		t.Errorf("MEM header dropped at the default preview-open width:\n%s", header)
	}
}

func TestListHeaderMatchesRowColumns(t *testing.T) {
	model, live, _ := procTestModel()
	// Header and row share one width gate; if they ever disagree the columns
	// silently misalign.
	for _, width := range []int{40, 60, 65, 66, 74, 100, 132} {
		header := strings.Contains(model.renderListHeader(width), "MEM")
		row := strings.Contains(model.renderSessionRow(width, live, 0, false), "1.5G")
		if header != row {
			t.Errorf("width %d: header has MEM=%v but row has figure=%v", width, header, row)
		}
	}
}

func TestPreviewProcessSection(t *testing.T) {
	model, live, dead := procTestModel()

	section := strings.Join(model.renderProcessSection(live, 48), "\n")
	for _, want := range []string{"Live process", "1.5G", "3.0G", "pid 4242", "3 processes", "ugrep"} {
		if !strings.Contains(section, want) {
			t.Errorf("process section missing %q:\n%s", want, section)
		}
	}

	if got := model.renderProcessSection(dead, 48); got != nil {
		t.Errorf("expected no process section for a session with no process, got:\n%v", got)
	}
}

func TestPreviewProcessSectionHidesHeaviestWhenItIsTheRoot(t *testing.T) {
	model, live, _ := procTestModel()
	stat := model.procStats[live.ID]
	stat.HeaviestIsRoot = true
	stat.HeaviestName = "2.1.219"
	model.procStats[live.ID] = stat

	section := strings.Join(model.renderProcessSection(live, 48), "\n")
	// "claude is using claude's memory" is noise; only a runaway child is worth
	// naming.
	if strings.Contains(section, "heaviest") {
		t.Errorf("named the heaviest process when it was the session's own:\n%s", section)
	}
	if !strings.Contains(section, "1.5G") {
		t.Errorf("dropped the headline figure along with the heaviest line:\n%s", section)
	}
}

func TestProcStatLookupFallsBackToResumeID(t *testing.T) {
	// Claude's marker files report the session's internal ID, which for a
	// resumed session is the ResumeID rather than the transcript filename CCS
	// keys on.
	model, _, _ := procTestModel()
	session := data.Session{ID: "filename-id", ResumeID: "internal-id"}
	model.procStats = map[string]data.ProcStat{"internal-id": {Footprint: 1 << 20}}

	if _, ok := model.procStatFor(session); !ok {
		t.Error("failed to resolve process stats through ResumeID")
	}
	if _, ok := model.procStatFor(data.Session{ID: "unknown"}); ok {
		t.Error("resolved process stats for a session that has none")
	}
}

func TestProcSampleKeepsLastGoodStatsOnFailedSample(t *testing.T) {
	model, live, _ := procTestModel()
	before := model.procStats

	// A transient sampling failure sends nil stats. Blanking the column would
	// read as "every session just died".
	updated, _ := model.Update(procSampledMsg{generation: model.tickerGeneration})
	after := updated.(Model)
	if _, ok := after.procStatFor(live); !ok {
		t.Error("a failed sample cleared the last known process stats")
	}
	if len(after.procStats) != len(before) {
		t.Errorf("procStats size changed on a failed sample: %d → %d", len(before), len(after.procStats))
	}
}

func TestProcSampleIgnoresStaleGeneration(t *testing.T) {
	model, _, _ := procTestModel()
	fresh := map[string]data.ProcStat{"other": {Footprint: 99}}

	// A tick from a superseded ticker generation must not land, or toggling
	// auto-refresh would leave two samplers fighting over the map.
	updated, _ := model.Update(procSampledMsg{generation: model.tickerGeneration + 1, stats: fresh})
	if _, ok := updated.(Model).procStats["other"]; ok {
		t.Error("accepted a sample from a stale ticker generation")
	}
}
