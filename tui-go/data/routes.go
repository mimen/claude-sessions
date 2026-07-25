package data

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

type launcherConfig struct {
	Launchers []launcherEntry `toml:"launcher"`
}

type launcherEntry struct {
	Name   string            `toml:"name"`
	Binary string            `toml:"binary"`
	Serves []string          `toml:"serves"`
	Env    map[string]string `toml:"env"`
}

// LoadRoutes reads the real launcher fleet from CCS config and pairs every
// launcher with both handoff targets. It deliberately does not shell out: the
// current CLI's read command opens migration-capable database handles, while
// this browser promises that route inspection is read-only.
//
// Unlike `ccs resume`, serves globs never gate a route here. Transcripts are
// stored in Anthropic format whatever produced them and both wrappers are the
// same Claude Code harness, so replaying a claude session on claude-gpt (or the
// reverse) is a choice the operator makes — serves only picks the DEFAULT.
func LoadRoutes(models []string) ([]Launcher, error) {
	models = normalizeModels(models)
	entries, err := loadLauncherEntries()
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		entries = []launcherEntry{{Name: "claude", Binary: "claude", Serves: []string{"*"}}}
		if _, lookErr := exec.LookPath("claude-gpt"); lookErr == nil {
			entries = append(entries, launcherEntry{Name: "claude-gpt", Binary: "claude-gpt", Serves: []string{"gpt-*"}})
		}
	}
	seen := make(map[string]bool)
	routes := make([]Launcher, 0, len(entries))
	for i := range entries {
		entry := &entries[i]
		entry.Name = normalizeInline(entry.Name)
		entry.Binary = normalizeInline(entry.Binary)
		if entry.Name == "" || entry.Binary == "" {
			return nil, errors.New("invalid [[launcher]]: name and binary are required")
		}
		if seen[entry.Name] {
			return nil, fmt.Errorf("duplicate launcher name %q in config", entry.Name)
		}
		seen[entry.Name] = true
		if len(entry.Serves) == 0 {
			entry.Serves = []string{"*"}
		}
		patterns := make([]string, 0, len(entry.Serves))
		for _, pattern := range entry.Serves {
			pattern = normalizeInline(pattern)
			if pattern != "" {
				patterns = append(patterns, pattern)
			}
		}
		if len(patterns) == 0 {
			patterns = []string{"*"}
		}
		entry.Serves = patterns
		unmatched := unmatchedModels(patterns, models)
		serves := len(unmatched) == 0
		reason := "replays the full model history"
		if !serves {
			reason = fmt.Sprintf("cross-harness: %s not in serves=[%s]", strings.Join(unmatched, ", "), strings.Join(patterns, ", "))
		}
		routes = append(routes, Launcher{
			Name:     entry.Name,
			Backend:  entry.Binary,
			Env:      copyStringMap(entry.Env),
			Target:   "inline",
			Serves:   serves,
			Eligible: true,
			Reason:   reason,
		})
	}
	if defaultIndex := defaultLauncher(entries, models); defaultIndex >= 0 {
		routes[defaultIndex].Default = true
		routes[defaultIndex].Reason = "origin backend for this history"
	}
	// Every launcher also gets a cmux target, so the harness stays a free choice
	// when the resume is handed to a new workspace instead of this terminal.
	cmuxEligible := true
	cmuxMissing := ""
	if _, lookErr := exec.LookPath("cmux"); lookErr != nil {
		cmuxEligible = false
		cmuxMissing = "cmux is not installed on PATH"
	}
	for index := range entries {
		origin := routes[index]
		reason := "new focused workspace via " + origin.Name
		if cmuxMissing != "" {
			reason = cmuxMissing
		}
		routes = append(routes, Launcher{
			Name:     origin.Name,
			Backend:  origin.Backend,
			Env:      copyStringMap(origin.Env),
			Target:   "cmux",
			Serves:   origin.Serves,
			Eligible: cmuxEligible,
			Reason:   reason,
		})
	}
	return routes, nil
}

func normalizeModels(models []string) []string {
	cleaned := make([]string, 0, len(models))
	for _, model := range models {
		if model = normalizeInline(model); model != "" {
			cleaned = append(cleaned, model)
		}
	}
	return cleaned
}

func loadLauncherEntries() ([]launcherEntry, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home directory: %w", err)
	}
	root := strings.TrimSpace(os.Getenv("CCS_ROOT"))
	if root == "" {
		root = filepath.Join(home, ".ccs")
	}
	path := filepath.Join(root, "config.toml")
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var config launcherConfig
	if err := toml.Unmarshal(contents, &config); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return config.Launchers, nil
}

func unmatchedModels(patterns []string, models []string) []string {
	var unmatched []string
	for _, model := range models {
		model = normalizeInline(model)
		if model == "" {
			continue
		}
		matched := false
		for _, pattern := range patterns {
			if matchesModel(pattern, model) {
				matched = true
				break
			}
		}
		if !matched {
			unmatched = append(unmatched, model)
		}
	}
	return unmatched
}

func matchesModel(pattern string, model string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == model
	}
	position := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		at := strings.Index(model[position:], part)
		if at < 0 {
			return false
		}
		at += position
		if i == 0 && at != 0 {
			return false
		}
		position = at + len(part)
	}
	last := parts[len(parts)-1]
	return last == "" || strings.HasSuffix(model, last)
}

// defaultLauncher picks the origin backend: among the launchers that serve every
// model in the history, the one matching it most specifically (so a pure-gpt
// history prefers the gpt launcher over a catch-all). It returns -1 when the
// history carries no signal — no models yet, or no launcher covers all of them,
// which is exactly what a session already resumed cross-harness looks like. The
// caller then falls back to the harness the operator last chose.
func defaultLauncher(entries []launcherEntry, models []string) int {
	if len(models) == 0 {
		return -1
	}
	best := -1
	bestScore := -1
	for i := range entries {
		if len(unmatchedModels(entries[i].Serves, models)) > 0 {
			continue
		}
		score := int(^uint(0) >> 1)
		for _, model := range models {
			perModel := -1
			for _, pattern := range entries[i].Serves {
				if matchesModel(pattern, model) {
					perModel = maxInt(perModel, len(strings.ReplaceAll(pattern, "*", "")))
				}
			}
			score = minInt(score, perModel)
		}
		if score > bestScore {
			best = i
			bestScore = score
		}
	}
	return best
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func copyStringMap(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	copy := make(map[string]string, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}
