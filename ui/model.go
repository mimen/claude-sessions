package ui

import (
	"time"

	"ccsspike/data"

	tea "github.com/charmbracelet/bubbletea"
)

type View int

const (
	ViewGroups View = iota
	ViewTree
)

type Overlay int

const (
	OverlayNone Overlay = iota
	OverlayRoute
	OverlayHelp
)

type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(time.Second/12, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// row is one line in the grouped list: a section header or a session ref.
type row struct {
	header  bool
	project string
	count   int
	sIdx    int
}

type Model struct {
	w, h    int
	view    View
	overlay Overlay
	rows    []row
	cursor  int // index into rows
	preview bool
	frame   int
}

func New() Model {
	return Model{
		w: 120, h: 40, view: ViewGroups, preview: true,
		rows: buildRows(), cursor: 1,
	}
}

func buildRows() []row {
	var rows []row
	seen := map[string]bool{}
	order := []string{}
	byProj := map[string][]int{}
	for i, s := range data.Sessions {
		if !seen[s.Project] {
			seen[s.Project] = true
			order = append(order, s.Project)
		}
		byProj[s.Project] = append(byProj[s.Project], i)
	}
	for _, p := range order {
		rows = append(rows, row{header: true, project: p, count: len(byProj[p])})
		for _, idx := range byProj[p] {
			rows = append(rows, row{sIdx: idx})
		}
	}
	return rows
}

func (m Model) Init() tea.Cmd { return tick() }

func (m Model) selectedSession() (data.Session, bool) {
	if m.cursor < 0 || m.cursor >= len(m.rows) || m.rows[m.cursor].header {
		return data.Session{}, false
	}
	return data.Sessions[m.rows[m.cursor].sIdx], true
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		return m, nil
	case tickMsg:
		m.frame++
		return m, tick()
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, tick()
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.overlay != OverlayNone {
		switch msg.String() {
		case "esc", "q", "r", "?", "enter":
			m.overlay = OverlayNone
		}
		return m, nil
	}
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		m.moveCursor(-1)
	case "down", "j":
		m.moveCursor(1)
	case "g":
		if m.view == ViewGroups {
			m.view = ViewTree
		} else {
			m.view = ViewGroups
		}
	case "p":
		m.preview = !m.preview
	case "r":
		m.overlay = OverlayRoute
	case "?":
		m.overlay = OverlayHelp
	}
	return m, nil
}

func (m *Model) moveCursor(d int) {
	n := len(m.rows)
	for i := 0; i < n; i++ {
		m.cursor += d
		if m.cursor < 0 {
			m.cursor = 0
			return
		}
		if m.cursor >= n {
			m.cursor = n - 1
			return
		}
		if !m.rows[m.cursor].header {
			return
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
