package main

import (
	"fmt"
	"os"

	"github.com/mimen/claude-sessions/tui-go/data"
	"github.com/mimen/claude-sessions/tui-go/resume"
	"github.com/mimen/claude-sessions/tui-go/ui"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	snapshot, err := data.Load(data.DefaultLoadOptions())
	if err != nil {
		fmt.Fprintln(os.Stderr, "ccs-go:", err)
		os.Exit(1)
	}
	if shot := os.Getenv("SHOT"); shot != "" {
		fmt.Print(ui.Shot(shot, snapshot))
		return
	}
	model := ui.New(snapshot)
	// `ccs skills` opens straight into the skills browser.
	if len(os.Args) > 1 && os.Args[1] == "skills" {
		model = model.StartInSkills()
	}
	program := tea.NewProgram(model, tea.WithAltScreen())
	final, err := program.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ccs-go:", err)
		os.Exit(1)
	}
	model, ok := final.(ui.Model)
	if !ok {
		return
	}
	command, ok := model.Handoff()
	if !ok {
		return
	}
	if err := resume.RunInline(command); err != nil {
		fmt.Fprintln(os.Stderr, "ccs-go:", err)
		os.Exit(1)
	}
}
