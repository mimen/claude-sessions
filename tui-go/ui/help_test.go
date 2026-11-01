package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func TestHelpScrollsToHiddenKeys(t *testing.T) {
	for _, mode := range []AppMode{ModeSessions, ModeSkills} {
		model := New(testSnapshot(1))
		model.mode = mode
		model.w, model.h = 80, 24
		model.overlay = OverlayHelp
		before := ansi.Strip(model.View())
		updated, _ := model.handleKey(tea.KeyMsg{Type: tea.KeyPgDown})
		model = updated.(Model)
		after := ansi.Strip(model.View())
		if before == after || !strings.Contains(after, "q quit") || !strings.Contains(after, "Skills registry") {
			t.Fatalf("mode %v: help did not reveal its last keys after PageDown:\n%s", mode, after)
		}
		assertViewFits(t, model, "scrolled help")
		updated, _ = model.handleKey(tea.KeyMsg{Type: tea.KeyPgUp})
		model = updated.(Model)
		if ansi.Strip(model.View()) != before {
			t.Fatal("PageUp did not return to the first help page")
		}
		updated, _ = model.handleKey(tea.KeyMsg{Type: tea.KeyEsc})
		if updated.(Model).overlay != OverlayNone {
			t.Fatal("Escape did not close help")
		}
	}
}
