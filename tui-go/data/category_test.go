package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadCategoryRegistryAndEffectiveInheritance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "categories.json")
	body := `{"version":1,"classifier_version":"v2","categories":[{"slug":"events","name":"Events, Booking & Live Production","compact_name":"Events","color":"#692EC2","aliases":[]}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	registry, err := loadCategoryRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := registry["events"].Color; got != "#692EC2" {
		t.Fatalf("color = %q", got)
	}
	catalogue := map[string]catalogueMeta{
		"root":  {SessionID: "root", StoredCategory: "events"},
		"child": {SessionID: "child", ParentSessionID: "root"},
	}
	resolved := resolveEffectiveCategory("child", catalogue, 32)
	if resolved.Slug != "events" || resolved.Finding != "inherited" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestEffectiveCategoryReportsCycleAndMissingParent(t *testing.T) {
	cycle := map[string]catalogueMeta{
		"a": {SessionID: "a", ParentSessionID: "b"},
		"b": {SessionID: "b", ParentSessionID: "a"},
	}
	if got := resolveEffectiveCategory("a", cycle, 32).Finding; got != "cycle" {
		t.Fatalf("cycle finding = %q", got)
	}
	missing := map[string]catalogueMeta{"a": {SessionID: "a", ParentSessionID: "missing"}}
	if got := resolveEffectiveCategory("a", missing, 32).Finding; got != "missing-parent" {
		t.Fatalf("missing finding = %q", got)
	}
}
