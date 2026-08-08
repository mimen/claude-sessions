package data

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var categorySlugPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
var categoryColorPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)
var categoryVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

const categoryCompactLabelMax = 18

type CategoryDefinition struct {
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	CompactName   string `json:"compactLabel"`
	Order         int    `json:"order"`
	Color         string `json:"hex"`
	Scope         string `json:"scope"`
	WorkspaceRoot string `json:"workspaceRoot"`
}

type categoryRegistryFile struct {
	Schema     string               `json:"$schema"`
	Version    string               `json:"version"`
	Source     string               `json:"source"`
	Categories []CategoryDefinition `json:"categories"`
}

type categoryRegistry struct {
	Version    string
	Categories map[string]CategoryDefinition
}

func loadCategoryRegistry(path string) (categoryRegistry, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return categoryRegistry{}, fmt.Errorf("category registry unavailable at %s: %w", path, err)
	}
	var raw categoryRegistryFile
	if err := json.Unmarshal(body, &raw); err != nil {
		return categoryRegistry{}, fmt.Errorf("category registry invalid at %s: %w", path, err)
	}
	if raw.Schema != "./registry.schema.json" || raw.Source != "Life Domains.md" ||
		!categoryVersionPattern.MatchString(raw.Version) || len(raw.Categories) == 0 {
		return categoryRegistry{}, fmt.Errorf("category registry invalid at %s: missing canonical metadata", path)
	}
	ordered := append([]CategoryDefinition(nil), raw.Categories...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	registry := categoryRegistry{Version: raw.Version, Categories: make(map[string]CategoryDefinition, len(ordered))}
	workspaceRoots := make(map[string]bool, len(ordered))
	for index, category := range ordered {
		category.Slug = normalizeInline(category.Slug)
		category.Name = normalizeInline(category.Name)
		category.CompactName = normalizeInline(category.CompactName)
		category.Color = normalizeInline(category.Color)
		category.Scope = normalizeInline(category.Scope)
		category.WorkspaceRoot = strings.TrimSpace(category.WorkspaceRoot)
		if !categorySlugPattern.MatchString(category.Slug) || category.Name == "" || category.CompactName == "" ||
			len([]rune(category.CompactName)) > categoryCompactLabelMax || !categoryColorPattern.MatchString(category.Color) ||
			category.Scope == "" || !strings.HasPrefix(category.WorkspaceRoot, "Workspaces/") ||
			strings.Count(category.WorkspaceRoot, "/") != 1 || category.Order != index+1 {
			return categoryRegistry{}, fmt.Errorf("category registry invalid at %s: malformed category %q", path, category.Slug)
		}
		if _, exists := registry.Categories[category.Slug]; exists {
			return categoryRegistry{}, fmt.Errorf("category registry invalid at %s: duplicate slug %q", path, category.Slug)
		}
		if workspaceRoots[category.WorkspaceRoot] {
			return categoryRegistry{}, fmt.Errorf("category registry invalid at %s: duplicate workspaceRoot %q", path, category.WorkspaceRoot)
		}
		workspaceRoots[category.WorkspaceRoot] = true
		registry.Categories[category.Slug] = category
	}
	return registry, nil
}

func categoryRegistryPath(_ string) string {
	if configured := strings.TrimSpace(os.Getenv("CCS_CATEGORY_REGISTRY_PATH")); configured != "" {
		return configured
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join("Documents", "milad-vault", "ClaudeConfig", "categories", "registry.json")
	}
	return filepath.Join(home, "Documents", "milad-vault", "ClaudeConfig", "categories", "registry.json")
}

type effectiveCategory struct {
	Slug       string
	StoredSlug string
	Finding    string
}

// resolveEffectiveCategory validates the complete bounded ancestry before accepting inheritance.
func resolveEffectiveCategory(id string, catalogue map[string]catalogueMeta, knownSessions map[string]bool, maxDepth int) effectiveCategory {
	meta, known := catalogue[id]
	if known && meta.SessionClass != "auxiliary" && meta.StoredCategory != "" {
		return effectiveCategory{Slug: meta.StoredCategory, StoredSlug: meta.StoredCategory, Finding: "stored"}
	}
	visited := map[string]bool{id: true}
	current := id
	inheritedSlug := ""
	for depth := 0; depth < maxDepth; depth++ {
		currentMeta, exists := catalogue[current]
		if !exists && !knownSessions[current] {
			return effectiveCategory{Finding: "missing-parent"}
		}
		parent := currentMeta.ParentSessionID
		if parent == "" {
			if currentMeta.SessionClass == "auxiliary" {
				return effectiveCategory{Finding: "parentless-auxiliary"}
			}
			if inheritedSlug != "" {
				return effectiveCategory{Slug: inheritedSlug, Finding: "inherited"}
			}
			return effectiveCategory{Finding: "uncategorized"}
		}
		if visited[parent] {
			return effectiveCategory{Finding: "cycle"}
		}
		parentMeta, exists := catalogue[parent]
		if !exists && !knownSessions[parent] {
			return effectiveCategory{Finding: "missing-parent"}
		}
		visited[parent] = true
		if inheritedSlug == "" && parentMeta.SessionClass != "auxiliary" && parentMeta.StoredCategory != "" {
			inheritedSlug = parentMeta.StoredCategory
		}
		current = parent
	}
	return effectiveCategory{Finding: "depth-exceeded"}
}
