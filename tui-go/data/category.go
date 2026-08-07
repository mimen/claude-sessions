package data

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var categorySlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
var categoryColorPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)

type CategoryDefinition struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	CompactName string   `json:"compact_name"`
	Color       string   `json:"color"`
	Aliases     []string `json:"aliases"`
}

type categoryRegistryFile struct {
	Version           json.RawMessage      `json:"version"`
	ClassifierVersion string               `json:"classifier_version"`
	Categories        []CategoryDefinition `json:"categories"`
}

type categoryRegistry map[string]CategoryDefinition

func loadCategoryRegistry(path string) (categoryRegistry, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("category registry unavailable at %s: %w", path, err)
	}
	var raw categoryRegistryFile
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("category registry invalid at %s: %w", path, err)
	}
	if strings.TrimSpace(raw.ClassifierVersion) == "" || len(raw.Categories) == 0 {
		return nil, fmt.Errorf("category registry invalid at %s: missing classifier_version or categories", path)
	}
	registry := make(categoryRegistry, len(raw.Categories))
	for _, category := range raw.Categories {
		category.Slug = normalizeInline(category.Slug)
		category.Name = normalizeInline(category.Name)
		category.CompactName = normalizeInline(category.CompactName)
		category.Color = strings.ToUpper(normalizeInline(category.Color))
		if !categorySlugPattern.MatchString(category.Slug) || category.Name == "" || category.CompactName == "" || !categoryColorPattern.MatchString(category.Color) {
			return nil, fmt.Errorf("category registry invalid at %s: malformed category %q", path, category.Slug)
		}
		if _, exists := registry[category.Slug]; exists {
			return nil, fmt.Errorf("category registry invalid at %s: duplicate slug %q", path, category.Slug)
		}
		registry[category.Slug] = category
	}
	return registry, nil
}

func categoryRegistryPath(runtimeRoot string) string {
	if configured := strings.TrimSpace(os.Getenv("CCS_CATEGORY_REGISTRY_PATH")); configured != "" {
		return configured
	}
	return filepath.Join(runtimeRoot, "categories.json")
}

type effectiveCategory struct {
	Slug       string
	StoredSlug string
	Finding    string
}

func resolveEffectiveCategory(id string, catalogue map[string]catalogueMeta, maxDepth int) effectiveCategory {
	meta, known := catalogue[id]
	if known && meta.StoredCategory != "" {
		return effectiveCategory{Slug: meta.StoredCategory, StoredSlug: meta.StoredCategory, Finding: "stored"}
	}
	visited := map[string]bool{id: true}
	current := id
	for depth := 0; depth < maxDepth; depth++ {
		parent := catalogue[current].ParentSessionID
		if parent == "" {
			return effectiveCategory{Finding: "uncategorized"}
		}
		if visited[parent] {
			return effectiveCategory{Finding: "cycle"}
		}
		parentMeta, exists := catalogue[parent]
		if !exists {
			return effectiveCategory{Finding: "missing-parent"}
		}
		visited[parent] = true
		if parentMeta.StoredCategory != "" {
			return effectiveCategory{Slug: parentMeta.StoredCategory, Finding: "inherited"}
		}
		current = parent
	}
	return effectiveCategory{Finding: "depth-exceeded"}
}
