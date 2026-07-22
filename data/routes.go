package data

import (
	"errors"
	"fmt"
	"os"
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

// LoadRoutes reads the real launcher fleet from CCS config and applies the same
// pure eligibility/default-route semantics as ccs routes. It deliberately does
// not shell out: the current CLI's read command opens migration-capable database
// handles, while this browser promises that route inspection is read-only.
func LoadRoutes(models []string) ([]Launcher, error) {
	entries, err := loadLauncherEntries()
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		entries = []launcherEntry{{Name: "claude", Binary: "claude", Serves: []string{"*"}}}
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
		eligible := len(unmatched) == 0
		reason := "can replay the full model history"
		if !eligible {
			reason = fmt.Sprintf("history contains %s, not matched by serves=[%s]", strings.Join(unmatched, ", "), strings.Join(patterns, ", "))
		}
		routes = append(routes, Launcher{
			Name:     entry.Name,
			Backend:  entry.Binary,
			Eligible: eligible,
			Reason:   reason,
		})
	}
	defaultIndex := defaultLauncher(entries, routes, models)
	if defaultIndex >= 0 {
		routes[defaultIndex].Default = true
		routes[defaultIndex].Reason = "origin-backend default"
	}
	return routes, nil
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

func defaultLauncher(entries []launcherEntry, routes []Launcher, models []string) int {
	best := -1
	bestScore := -1
	for i, route := range routes {
		if !route.Eligible {
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
		if len(models) == 0 {
			score = 0
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
