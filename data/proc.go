package data

// Live process attribution: which OS processes belong to which Claude session,
// and what they currently cost in memory.
//
// Nothing here is persisted. Every field is derived at sample time from the
// kernel plus the marker files Claude Code already maintains, so there is no
// index to build, migrate, or garbage-collect. A stat that cannot be derived is
// simply absent for that tick.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ProcStat is one session's live process cost, aggregated over the session's
// whole process tree — the Claude process itself plus every tool subprocess it
// spawned (ripgrep, MCP servers, dev servers, test runners).
//
// Tree aggregation is the point. A search that ran away to 42 GB showed up in
// Activity Monitor as an anonymous `ugrep` with no visible link to the session
// that started it; only the parent chain connects the two.
type ProcStat struct {
	RootPID int
	// Footprint is summed phys_footprint across the tree — the same measure
	// Activity Monitor's Memory column reports, not RSS.
	Footprint uint64
	// Peak sums each live process's lifetime peak. The kernel tracks those for
	// free, so a session that already spiked stays identifiable with no sampling
	// history — as long as the process that spiked is still alive. Peaks of
	// exited children die with them.
	//
	// This is an upper bound, not a measured high-water mark: the individual
	// peaks did not necessarily coincide. It is summed rather than maxed so it
	// is always >= Footprint, which is what "peak" has to mean next to a
	// current figure.
	Peak         uint64
	CPUNanos     uint64
	ProcessCount int
	// HeaviestName / HeaviestFootprint call out the single worst process in the
	// tree, which is usually the actual answer to "what is eating my RAM".
	HeaviestName      string
	HeaviestFootprint uint64
	// HeaviestIsRoot is true when the Claude process itself dominates, rather
	// than one of its children — a materially different diagnosis.
	HeaviestIsRoot bool
}

// sessionMarker is Claude Code's own liveness record, one file per running
// session at ~/.claude/sessions/<pid>.json. Claude Code writes it on start and
// removes it on exit, so the directory is a self-maintaining PID→session index
// that covers every session, not only the cmux-hosted ones the hook store knows
// about.
type sessionMarker struct {
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
	StartedAt int64  `json:"startedAt"`
	Status    string `json:"status"`
	Version   string `json:"version"`
}

// markerStartSkew is how far a marker's recorded start time may sit from the
// process's actual start before we refuse the match. Generous enough to absorb
// the gap between fork and marker write, tight enough that a recycled PID from a
// different era can never satisfy it.
const markerStartSkew = 30 * time.Second

// SampleProcStats returns live process cost per Claude session ID.
//
// Cost is one pass over the process table (~70ms on a 3,500-process machine) and
// one directory read. Safe to call on a UI tick; safe to call concurrently with
// anything else, since it only reads.
func SampleProcStats(home string) map[string]ProcStat {
	markers := readSessionMarkers(home)
	if len(markers) == 0 {
		return map[string]ProcStat{}
	}
	records := sampleProcesses()
	if len(records) == 0 {
		return map[string]ProcStat{}
	}

	children := make(map[int][]int, len(records))
	for pid, record := range records {
		if record.PPID > 0 && record.PPID != pid {
			children[record.PPID] = append(children[record.PPID], pid)
		}
	}

	stats := make(map[string]ProcStat, len(markers))
	for _, marker := range markers {
		root, ok := records[marker.PID]
		if !ok {
			// Marker outlived its process — it is being cleaned up, or the
			// session was killed before it could.
			continue
		}
		if !markerMatchesProcess(marker, root) {
			continue
		}
		stat := walkTree(marker.PID, records, children)
		if stat.ProcessCount == 0 {
			continue
		}
		// Two markers can name the same session ID only if one is stale; the
		// larger tree is the live one.
		if existing, clash := stats[marker.SessionID]; clash && existing.Footprint >= stat.Footprint {
			continue
		}
		stats[marker.SessionID] = stat
	}
	return stats
}

// markerMatchesProcess rejects a marker whose recorded start time disagrees with
// the process now holding that PID.
func markerMatchesProcess(marker sessionMarker, root procRecord) bool {
	if marker.StartedAt <= 0 || root.StartSecs <= 0 {
		// Nothing to compare against: accept, since a live marker file is
		// already strong evidence on its own.
		return true
	}
	skew := time.UnixMilli(marker.StartedAt).Sub(time.Unix(root.StartSecs, 0))
	if skew < 0 {
		skew = -skew
	}
	return skew <= markerStartSkew
}

// walkTree sums a session root and all of its descendants.
func walkTree(rootPID int, records map[int]procRecord, children map[int][]int) ProcStat {
	stat := ProcStat{RootPID: rootPID}
	// Iterative walk with a visited set: a corrupt or racing parent chain must
	// not be able to spin this forever.
	visited := make(map[int]bool)
	queue := []int{rootPID}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if visited[pid] {
			continue
		}
		visited[pid] = true
		record, ok := records[pid]
		if !ok {
			continue
		}
		stat.ProcessCount++
		stat.Footprint += record.Footprint
		stat.CPUNanos += record.CPUNanos
		stat.Peak += record.Peak
		if record.Footprint > stat.HeaviestFootprint {
			stat.HeaviestFootprint = record.Footprint
			stat.HeaviestName = record.Name
			stat.HeaviestIsRoot = pid == rootPID
		}
		queue = append(queue, children[pid]...)
	}
	return stat
}

// readSessionMarkers loads every live-session marker Claude Code has written.
func readSessionMarkers(home string) []sessionMarker {
	dir := filepath.Join(home, ".claude", "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	markers := make([]sessionMarker, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var marker sessionMarker
		if err := json.Unmarshal(raw, &marker); err != nil {
			continue
		}
		if marker.PID <= 0 || marker.SessionID == "" {
			continue
		}
		markers = append(markers, marker)
	}
	// Stable order keeps the clash tie-break above deterministic.
	sort.Slice(markers, func(i int, j int) bool { return markers[i].PID < markers[j].PID })
	return markers
}

// FormatFootprint renders bytes for a narrow fixed-width column: "1.4G", "342M".
// Sub-megabyte values round up to "1M" rather than showing noise. Never wider
// than four characters.
func FormatFootprint(bytes uint64) string {
	switch {
	case bytes == 0:
		return ""
	case bytes >= 1<<30:
		return scaled(float64(bytes)/(1<<30)) + "G"
	case bytes >= 1<<20:
		return scaled(float64(bytes)/(1<<20)) + "M"
	default:
		return "1M"
	}
}

// scaled keeps one decimal below 10 ("1.4") and drops it above ("342").
func scaled(value float64) string {
	if value < 10 {
		return strconv.FormatFloat(value, 'f', 1, 64)
	}
	return strconv.FormatFloat(value, 'f', 0, 64)
}
