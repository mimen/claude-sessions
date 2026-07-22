package main

import (
	"fmt"
	"os"

	"ccsspike/data"
	"ccsspike/resume"
	"ccsspike/ui"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	snapshot, err := data.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ccs-go:", err)
		os.Exit(1)
	}
	if shot := os.Getenv("SHOT"); shot != "" {
		fmt.Print(ui.Shot(shot, snapshot))
		return
	}
	program := tea.NewProgram(ui.New(snapshot), tea.WithAltScreen())
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
