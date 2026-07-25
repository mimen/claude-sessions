package ui

import (
	"strings"
	"testing"
)

func TestSortPrefsRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		mode sortMode
		want string
	}{
		{name: "recency", mode: sortRecency, want: "recency"},
		{name: "cost", mode: sortCost, want: "cost"},
		{name: "messages", mode: sortMessages, want: "messages"},
		{name: "memory", mode: sortMemory, want: "memory"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			model := New(testSnapshot(1))
			model.options.sort = test.mode
			model.savePrefs()

			stored, ok := loadPrefs()
			if !ok {
				t.Fatal("saved preferences could not be loaded")
			}
			if stored.Sort != test.want {
				t.Fatalf("persisted sort = %q, want %q", stored.Sort, test.want)
			}
			if got := sortFromString(stored.Sort); got != test.mode {
				t.Fatalf("restored sort = %s, want %s", got, test.mode)
			}
			if test.mode == sortMemory && !strings.Contains(model.renderViewOptions(), "memory") {
				t.Fatal("view-options overlay did not show the memory sort mode")
			}
		})
	}
}
