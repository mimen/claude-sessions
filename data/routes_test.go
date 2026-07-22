package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRoutesFromCCSConfig(t *testing.T) {
	root := t.TempDir()
	config := `
[[launcher]]
name = "claude"
binary = "claude"
serves = ["*"]

[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-*"]
`
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_ROOT", root)
	routes, err := LoadRoutes([]string{"gpt-5.6-sol"})
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) != 3 || !routes[1].Default || !routes[1].Eligible || routes[2].Name != "cmux" || routes[2].Target != "cmux" {
		t.Fatalf("unexpected routes: %+v", routes)
	}
}

func TestRouteEligibilityAndDefault(t *testing.T) {
	entries := []launcherEntry{
		{Name: "claude", Binary: "claude", Serves: []string{"*"}},
		{Name: "claude-gpt", Binary: "claude-gpt", Serves: []string{"gpt-*"}},
	}
	models := []string{"gpt-5.6-sol"}
	routes := make([]Launcher, 0, len(entries))
	for _, entry := range entries {
		unmatched := unmatchedModels(entry.Serves, models)
		routes = append(routes, Launcher{Name: entry.Name, Eligible: len(unmatched) == 0})
	}
	if index := defaultLauncher(entries, routes, models); index != 1 {
		t.Fatalf("defaultLauncher() = %d, want 1", index)
	}

	mixed := []string{"gpt-5.6-sol", "claude-fable-5"}
	if unmatched := unmatchedModels(entries[1].Serves, mixed); len(unmatched) != 1 || unmatched[0] != "claude-fable-5" {
		t.Fatalf("unmatchedModels() = %#v", unmatched)
	}
}

func TestMatchesModel(t *testing.T) {
	cases := []struct {
		pattern string
		model   string
		want    bool
	}{
		{pattern: "*", model: "claude-opus-4-8", want: true},
		{pattern: "gpt-*", model: "gpt-5.6-sol", want: true},
		{pattern: "gpt-*", model: "claude-fable-5", want: false},
		{pattern: "*-sol", model: "gpt-5.6-sol", want: true},
		{pattern: "gpt-*-sol", model: "gpt-5.6-sol", want: true},
	}
	for _, test := range cases {
		if got := matchesModel(test.pattern, test.model); got != test.want {
			t.Fatalf("matchesModel(%q, %q) = %v, want %v", test.pattern, test.model, got, test.want)
		}
	}
}
