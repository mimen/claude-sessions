//go:build darwin

package data

// Darwin process introspection through the proc_info syscall (336), the same
// source Activity Monitor and /usr/bin/footprint read.
//
// This deliberately avoids cgo (the repo builds with CGO_ENABLED=0 — see the
// pure-Go modernc.org/sqlite driver) and avoids shelling out. `ps` is not an
// option because its RSS column is not what Activity Monitor shows: a session
// observed at 42 GB of phys_footprint reported under 1.4 GB of RSS, because RSS
// excludes compressed and swapped-out pages. `top -l 1` reports the right number
// but takes ~2.2s, far too slow for a TUI tick. proc_info sweeps the whole
// machine in well under 100ms.

import (
	"bytes"
	"encoding/binary"
	"syscall"
	"unsafe"
)

const (
	sysProcInfo = 336

	// proc_info.h call numbers.
	callListPIDs = 1
	callPIDInfo  = 2
	callRusage   = 9

	// proc_listpids types.
	procAllPIDs = 1

	// proc_pidinfo flavors.
	flavorTBSDInfo  = 3
	sizeofBSDInfo   = 136
	offsetPPID      = 16
	offsetComm      = 48
	sizeofComm      = 16
	offsetName      = 64
	sizeofName      = 32
	offsetStartSecs = 120

	// proc_pid_rusage flavors. V4 carries phys_footprint and the kernel's
	// lifetime peak, which is what makes peak reporting free — we never have to
	// sample for it.
	flavorRusageV4 = 4
	// Field indexes into rusage_info_v4, counted in uint64s after the 16-byte uuid.
	fieldUserTime      = 0
	fieldSystemTime    = 1
	fieldPhysFootprint = 7
	fieldPeakFootprint = 28
)

// procRecord is one live process as the kernel reports it.
type procRecord struct {
	PID       int
	PPID      int
	Name      string
	Footprint uint64
	Peak      uint64
	CPUNanos  uint64
	// StartSecs is the process start time in Unix seconds. It is the guard
	// against PID reuse: a marker file left behind by a SIGKILLed session (the
	// one case where Claude Code cannot clean up after itself) must not be
	// allowed to claim an unrelated process that later inherited its PID.
	StartSecs int64
}

// listPIDs returns every PID visible to this user.
func listPIDs() []int {
	// Ask for the required size first, then add slack: processes can spawn
	// between the two calls and an undersized buffer silently truncates.
	size, _, errno := syscall.Syscall6(sysProcInfo, callListPIDs, procAllPIDs, 0, 0, 0, 0)
	if errno != 0 || size == 0 {
		return nil
	}
	count := int(size)/4 + 256
	buf := make([]byte, count*4)
	written, _, errno := syscall.Syscall6(sysProcInfo, callListPIDs, procAllPIDs, 0, 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if errno != 0 {
		return nil
	}
	pids := make([]int, 0, int(written)/4)
	for offset := 0; offset+4 <= int(written); offset += 4 {
		if pid := int(int32(binary.LittleEndian.Uint32(buf[offset:]))); pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// procBSDInfo reads the parent PID, command name and start time for one process.
func procBSDInfo(pid int) (ppid int, name string, startSecs int64, ok bool) {
	var buf [sizeofBSDInfo]byte
	written, _, errno := syscall.Syscall6(sysProcInfo, callPIDInfo, uintptr(pid), flavorTBSDInfo, 0,
		uintptr(unsafe.Pointer(&buf[0])), sizeofBSDInfo)
	if errno != 0 || int(written) < sizeofBSDInfo {
		return 0, "", 0, false
	}
	ppid = int(int32(binary.LittleEndian.Uint32(buf[offsetPPID:])))
	// pbi_name is the fuller name and is often empty; pbi_comm is truncated to
	// 16 bytes but always present.
	name = cstring(buf[offsetName : offsetName+sizeofName])
	if name == "" {
		name = cstring(buf[offsetComm : offsetComm+sizeofComm])
	}
	startSecs = int64(binary.LittleEndian.Uint64(buf[offsetStartSecs:]))
	return ppid, name, startSecs, true
}

// procRusage reads current and peak physical footprint plus consumed CPU.
func procRusage(pid int) (footprint uint64, peak uint64, cpuNanos uint64, ok bool) {
	var buf [512]byte
	_, _, errno := syscall.Syscall6(sysProcInfo, callRusage, uintptr(pid), flavorRusageV4, 0,
		uintptr(unsafe.Pointer(&buf[0])), 0)
	if errno != 0 {
		return 0, 0, 0, false
	}
	field := func(index int) uint64 {
		return binary.LittleEndian.Uint64(buf[16+8*index:])
	}
	return field(fieldPhysFootprint),
		field(fieldPeakFootprint),
		field(fieldUserTime) + field(fieldSystemTime),
		true
}

// sampleProcesses reads every visible process once.
func sampleProcesses() map[int]procRecord {
	pids := listPIDs()
	records := make(map[int]procRecord, len(pids))
	for _, pid := range pids {
		ppid, name, startSecs, ok := procBSDInfo(pid)
		if !ok {
			// The process exited between listing and inspection. Normal; skip it.
			continue
		}
		footprint, peak, cpuNanos, ok := procRusage(pid)
		if !ok {
			continue
		}
		records[pid] = procRecord{
			PID:       pid,
			PPID:      ppid,
			Name:      name,
			Footprint: footprint,
			Peak:      peak,
			CPUNanos:  cpuNanos,
			StartSecs: startSecs,
		}
	}
	return records
}

func cstring(raw []byte) string {
	if end := bytes.IndexByte(raw, 0); end >= 0 {
		raw = raw[:end]
	}
	return string(bytes.TrimSpace(raw))
}
