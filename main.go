package main

import (
	"fmt"
	"os"

	"ccsspike/ui"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	if shot := os.Getenv("SHOT"); shot != "" {
		fmt.Print(ui.Shot(shot))
		return
	}
	p := tea.NewProgram(ui.New(), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
