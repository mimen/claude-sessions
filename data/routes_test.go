package data

import (
	"os"
	"path/filepath"
	"strings"
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
	// Every launcher is offered on both targets: inline first, then cmux.
	if len(routes) != 4 || !routes[1].Default || !routes[1].Serves {
		t.Fatalf("unexpected routes: %+v", routes)
	}
	if routes[2].Target != "cmux" || routes[2].Name != "claude" || routes[3].Name != "claude-gpt" {
		t.Fatalf("unexpected cmux routes: %+v", routes[2:])
	}
}

// A launcher that does not serve the history stays a real, selectable route:
// crossing harnesses is allowed, and serves only decides the preselection.
func TestLoadRoutesKeepsUnservedLaunchersSelectable(t *testing.T) {
	root := t.TempDir()
	config := `
[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*"]

[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-*"]
`
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_ROOT", root)

	tests := []struct {
		name         string
		models       []string
		wantDefault  string
		wantServedBy []string
	}{
		{name: "claude history", models: []string{"claude-fable-5"}, wantDefault: "claude-native", wantServedBy: []string{"claude-native"}},
		{name: "gpt history", models: []string{"gpt-5.6-sol"}, wantDefault: "claude-gpt", wantServedBy: []string{"claude-gpt"}},
		{name: "already crossed", models: []string{"gpt-5.6-sol", "claude-fable-5"}, wantDefault: ""},
		{name: "no history yet", models: nil, wantDefault: ""},
		{name: "blank history", models: []string{"", "  "}, wantDefault: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			routes, err := LoadRoutes(test.models)
			if err != nil {
				t.Fatal(err)
			}
			if len(routes) != 4 {
				t.Fatalf("routes = %+v, want 4", routes)
			}
			gotDefault := ""
			for _, route := range routes {
				if !route.Eligible && route.Target == "inline" {
					t.Fatalf("inline route %q was blocked: %s", route.Name, route.Reason)
				}
				if route.Default {
					gotDefault = route.Name
				}
			}
			if gotDefault != test.wantDefault {
				t.Fatalf("default = %q, want %q", gotDefault, test.wantDefault)
			}
			served := make([]string, 0, 2)
			for _, route := range routes[:2] {
				if route.Serves {
					served = append(served, route.Name)
				}
			}
			if len(test.wantServedBy) > 0 && strings.Join(served, ",") != strings.Join(test.wantServedBy, ",") {
				t.Fatalf("served by %v, want %v", served, test.wantServedBy)
			}
		})
	}
}

func TestDefaultLauncherPrefersTheMostSpecificServingGlob(t *testing.T) {
	entries := []launcherEntry{
		{Name: "claude", Binary: "claude", Serves: []string{"*"}},
		{Name: "claude-gpt", Binary: "claude-gpt", Serves: []string{"gpt-*"}},
	}
	if index := defaultLauncher(entries, []string{"gpt-5.6-sol"}); index != 1 {
		t.Fatalf("defaultLauncher() = %d, want 1", index)
	}
	// A catch-all still serves a mixed history; only a fleet with no catch-all
	// leaves the origin unresolved.
	if index := defaultLauncher(entries, []string{"gpt-5.6-sol", "claude-fable-5"}); index != 0 {
		t.Fatalf("mixed defaultLauncher() = %d, want 0", index)
	}
	if index := defaultLauncher(entries[1:], []string{"gpt-5.6-sol", "claude-fable-5"}); index != -1 {
		t.Fatalf("unserved defaultLauncher() = %d, want -1", index)
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
