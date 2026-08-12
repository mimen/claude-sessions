package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Preferences are ccs-go's OWN config — not CCS catalogue state — so unlike every
// session mutation (which shells out to `ccs`), these are written directly.
//
// Everything here is best-effort: a missing or corrupt file falls back to
// defaults, and a failed write is swallowed. Preferences must never block or
// break the TUI.

type persistedPrefs struct {
	View            string   `json:"view"`
	Sort            string   `json:"sort"`
	ShowSaved       bool     `json:"showSaved"`
	ShowSubagents   bool     `json:"showSubagents"`
	ShowAuxiliary   bool     `json:"showAuxiliary"`
	TaskFilter      string   `json:"taskFilter"`
	AutoRefresh     bool     `json:"autoRefresh"`
	RefreshInterval string   `json:"refreshInterval"`
	Preview         bool     `json:"preview"`
	Launcher        string   `json:"launcher"`
	Collapsed       []string `json:"collapsed"`
}

// prefsPath is ~/.config/ccs-go/prefs.json — deliberately XDG-style rather than
// os.UserConfigDir() (which is ~/Library/Application Support on macOS), to match
// where the rest of this machine's tooling keeps its config.
func prefsPath() (string, error) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "ccs-go", "prefs.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "ccs-go", "prefs.json"), nil
}

func viewFromString(value string) View {
	switch value {
	case "tree":
		return ViewTree
	case "flat":
		return ViewFlat
	default:
		return ViewGroups
	}
}

func (v View) String() string {
	switch v {
	case ViewTree:
		return "tree"
	case ViewFlat:
		return "flat"
	default:
		return "default"
	}
}

func sortFromString(value string) sortMode {
	switch value {
	case "cost":
		return sortCost
	case "messages":
		return sortMessages
	case "memory":
		return sortMemory
	default:
		return sortRecency
	}
}

func taskFilterFromString(value string) taskFilter {
	switch value {
	case "unfinished":
		return taskFilterUnfinished
	case "interrupted-mid-task":
		return taskFilterInterrupted
	default:
		return taskFilterAll
	}
}

// loadPrefs returns stored preferences, or (defaults, false) when unavailable.
func loadPrefs() (persistedPrefs, bool) {
	path, err := prefsPath()
	if err != nil {
		return persistedPrefs{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return persistedPrefs{}, false
	}
	var stored persistedPrefs
	if err := json.Unmarshal(raw, &stored); err != nil {
		return persistedPrefs{}, false
	}
	return stored, true
}

// applyPrefs seeds a freshly constructed model from stored preferences.
func (m *Model) applyPrefs() {
	stored, ok := loadPrefs()
	if !ok {
		m.collapsed = defaultCollapsed()
		return
	}
	m.view = viewFromString(stored.View)
	m.options.sort = sortFromString(stored.Sort)
	m.options.showSaved = stored.ShowSaved
	m.options.showSubagents = stored.ShowSubagents
	m.options.showAuxiliary = stored.ShowAuxiliary
	m.options.taskFilter = taskFilterFromString(stored.TaskFilter)
	m.options.autoRefresh = stored.AutoRefresh
	if parsed, err := time.ParseDuration(stored.RefreshInterval); err == nil && parsed > 0 {
		m.options.refreshInterval = parsed
	}
	m.preview = stored.Preview
	m.lastLauncher = stored.Launcher
	m.collapsed = make(map[string]bool, len(stored.Collapsed))
	for _, key := range stored.Collapsed {
		m.collapsed[key] = true
	}
}

// defaultCollapsed folds Done on a first run so the landing view stays about live work.
func defaultCollapsed() map[string]bool {
	return map[string]bool{
		"no-system:done": true,
	}
}

// savePrefs persists the current view state. Best-effort; errors are ignored.
func (m Model) savePrefs() {
	path, err := prefsPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	keys := make([]string, 0, len(m.collapsed))
	for key, folded := range m.collapsed {
		if folded {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys) // stable file content across writes
	payload := persistedPrefs{
		View:            m.view.String(),
		Sort:            m.options.sort.String(),
		ShowSaved:       m.options.showSaved,
		ShowSubagents:   m.options.showSubagents,
		ShowAuxiliary:   m.options.showAuxiliary,
		TaskFilter:      m.options.taskFilter.String(),
		AutoRefresh:     m.options.autoRefresh,
		RefreshInterval: m.options.refreshInterval.String(),
		Preview:         m.preview,
		Launcher:        m.lastLauncher,
		Collapsed:       keys,
	}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, encoded, 0o644)
}
