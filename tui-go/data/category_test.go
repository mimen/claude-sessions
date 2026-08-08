package data

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func known(catalogue map[string]catalogueMeta, extra ...string) map[string]bool {
	out := make(map[string]bool, len(catalogue)+len(extra))
	for id := range catalogue {
		out[id] = true
	}
	for _, id := range extra {
		out[id] = true
	}
	return out
}

func TestLoadCanonicalCategoryRegistryAndEffectiveInheritance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "registry.json")
	body := `{"$schema":"./registry.schema.json","version":"1.0.0","source":"Life Domains.md","categories":[{"slug":"events","name":"Events, Booking & Live Production","compactLabel":"Events","order":1,"hex":"#692EC2","scope":"Events","workspaceRoot":"Workspaces/Events"}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	registry, err := loadCategoryRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := registry.Categories["events"].Color; got != "#692EC2" {
		t.Fatalf("color = %q", got)
	}
	catalogue := map[string]catalogueMeta{
		"root":  {SessionID: "root", StoredCategory: "events", CategorySource: "manual"},
		"child": {SessionID: "child", ParentSessionID: "root"},
	}
	resolved := resolveEffectiveCategory("child", catalogue, known(catalogue), 32)
	if resolved.Slug != "events" || resolved.Finding != "inherited" || resolved.Source != "manual" || resolved.InheritedFrom != "root" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestCategoryRegistryRejectsCompactLabelsBeyondTUIBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "registry.json")
	body := `{"$schema":"./registry.schema.json","version":"1.0.0","source":"Life Domains.md","categories":[{"slug":"events","name":"Events","compactLabel":"Fourteen chars","order":1,"hex":"#692EC2","scope":"Events","workspaceRoot":"Workspaces/Events"}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCategoryRegistry(path); err == nil {
		t.Fatal("expected a 14-character compact label to be rejected")
	}
}

func TestLoadActualMergedCanonicalRegistry(t *testing.T) {
	body, err := exec.Command("git", "-C", "/Users/mimen/Documents/milad-vault", "show", "origin/main:ClaudeConfig/categories/registry.json").Output()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "registry.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	registry, err := loadCategoryRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if registry.Version != "1.0.0" || len(registry.Categories) != 11 {
		t.Fatalf("registry = version %q, categories %d", registry.Version, len(registry.Categories))
	}
	music := registry.Categories["music"]
	if music.CompactName != "Music" || music.Color != "#DC4C3E" || music.WorkspaceRoot != "Workspaces/Music" {
		t.Fatalf("music = %+v", music)
	}
}

func TestEffectiveCategoryValidatesCompleteAncestry(t *testing.T) {
	cycleAfterAssignment := map[string]catalogueMeta{
		"a": {SessionID: "a", ParentSessionID: "b"},
		"b": {SessionID: "b", StoredCategory: "events", ParentSessionID: "a"},
	}
	if got := resolveEffectiveCategory("a", cycleAfterAssignment, known(cycleAfterAssignment), 32).Finding; got != "cycle" {
		t.Fatalf("cycle finding = %q", got)
	}
	missingAfterAssignment := map[string]catalogueMeta{
		"a": {SessionID: "a", ParentSessionID: "b"},
		"b": {SessionID: "b", StoredCategory: "events", ParentSessionID: "missing"},
	}
	if got := resolveEffectiveCategory("a", missingAfterAssignment, known(missingAfterAssignment), 32).Finding; got != "missing-parent" {
		t.Fatalf("missing finding = %q", got)
	}
	parentless := map[string]catalogueMeta{"a": {SessionID: "a", SessionClass: "auxiliary"}}
	if got := resolveEffectiveCategory("a", parentless, known(parentless), 32).Finding; got != "parentless-auxiliary" {
		t.Fatalf("parentless finding = %q", got)
	}
}

func TestRegistryUnavailableIsWarnedGloballyWithoutPerSessionAggregation(t *testing.T) {
	if shouldAggregateCategoryFinding("registry-unavailable") {
		t.Fatal("registry unavailability must not be counted once per visible session")
	}
	if !shouldAggregateCategoryFinding("cycle") {
		t.Fatal("session-specific category repairs must remain aggregated")
	}
}

func TestCategoryRepairDisplayDistinguishesAncestryFailures(t *testing.T) {
	cases := map[string]string{
		"cycle":                "Cycle",
		"missing-parent":       "No parent",
		"depth-exceeded":       "Too deep",
		"parentless-auxiliary": "Aux no parent",
	}
	for finding, expected := range cases {
		_, compact, repair := categoryRepairDisplay(finding)
		if !repair || compact != expected {
			t.Fatalf("%s display = %q, repair=%t", finding, compact, repair)
		}
	}
}

func TestEffectiveCategoryTreatsIndexedUncataloguedParentAsKnown(t *testing.T) {
	catalogue := map[string]catalogueMeta{"child": {SessionID: "child", ParentSessionID: "indexed-parent"}}
	if got := resolveEffectiveCategory("child", catalogue, known(catalogue, "indexed-parent"), 32).Finding; got != "uncategorized" {
		t.Fatalf("finding = %q", got)
	}
}
