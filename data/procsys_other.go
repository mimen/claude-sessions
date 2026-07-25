//go:build !darwin

package data

// Live process attribution is macOS-only: it reads phys_footprint out of the
// Darwin proc_info syscall. Elsewhere the TUI still builds and simply reports no
// process stats, so the memory column and the sidebar section stay blank.

type procRecord struct {
	PID       int
	PPID      int
	Name      string
	Footprint uint64
	Peak      uint64
	CPUNanos  uint64
	StartSecs int64
}

func sampleProcesses() map[int]procRecord {
	return map[int]procRecord{}
}
