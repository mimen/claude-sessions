package main

import (
	"fmt"
	"os"

	"ccsspike/data"
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
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "ccs-go:", err)
		os.Exit(1)
	}
}
