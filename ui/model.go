package ui

import (
	"fmt"

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

// row is one line in the grouped list: a section header or a session ref.
type row struct {
	header  bool
	project string
	count   int
	sIdx    int
}

type routesLoadedMsg struct {
	sessionID string
	routes    []data.Launcher
	err       error
}

// Model is the single Bubble Tea state machine for the browser.
type Model struct {
	w, h         int
	view         View
	overlay      Overlay
	snapshot     data.Snapshot
	rows         []row
	cursor       int
	treeCursor   int
	preview      bool
	routes       []data.Launcher
	routeCursor  int
	routeLoading bool
	routeSession string
	routeError   string
	status       string
}

// New creates a browser over an immutable real-data snapshot.
func New(snapshot data.Snapshot) Model {
	rows := buildRows(snapshot.Sessions)
	return Model{
		w:        120,
		h:        40,
		view:     ViewGroups,
		preview:  true,
		snapshot: snapshot,
		rows:     rows,
		cursor:   firstSessionRow(rows),
	}
}

func buildRows(sessions []data.Session) []row {
	var rows []row
	seen := map[string]bool{}
	order := []string{}
	labels := map[string]string{}
	byRoot := map[string][]int{}
	for i, session := range sessions {
		project := session.Project
		if project == "" {
			project = "(unknown)"
		}
		root := session.ProjectRoot
		if root == "" {
			root = "(unknown):" + session.ID
		}
		if !seen[root] {
			seen[root] = true
			order = append(order, root)
			labels[root] = project
		}
		byRoot[root] = append(byRoot[root], i)
	}
	for _, root := range order {
		rows = append(rows, row{header: true, project: labels[root], count: len(byRoot[root])})
		for _, idx := range byRoot[root] {
			rows = append(rows, row{sIdx: idx})
		}
	}
	return rows
}

func firstSessionRow(rows []row) int {
	for i, candidate := range rows {
		if !candidate.header {
			return i
		}
	}
	return 0
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) selectedSession() (data.Session, bool) {
	if m.view == ViewTree {
		if m.treeCursor < 0 || m.treeCursor >= len(m.snapshot.Tree) {
			return data.Session{}, false
		}
		return m.snapshot.SessionByID(m.snapshot.Tree[m.treeCursor].SessionID)
	}
	if m.cursor < 0 || m.cursor >= len(m.rows) || m.rows[m.cursor].header {
		return data.Session{}, false
	}
	idx := m.rows[m.cursor].sIdx
	if idx < 0 || idx >= len(m.snapshot.Sessions) {
		return data.Session{}, false
	}
	return m.snapshot.Sessions[idx], true
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w = max(1, msg.Width)
		m.h = max(1, msg.Height)
		return m, nil
	case routesLoadedMsg:
		if msg.sessionID != m.routeSession {
			return m, nil
		}
		m.routeLoading = false
		m.routes = msg.routes
		if msg.err != nil {
			m.routeError = msg.err.Error()
			return m, nil
		}
		m.routeCursor = defaultRouteIndex(m.routes)
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.overlay == OverlayHelp {
		switch msg.String() {
		case "esc", "q", "?":
			m.overlay = OverlayNone
		}
		return m, nil
	}
	if m.overlay == OverlayRoute {
		switch msg.String() {
		case "esc", "q", "r":
			m.overlay = OverlayNone
		case "up", "k":
			m.moveRouteCursor(-1)
		case "down", "j":
			m.moveRouteCursor(1)
		case "enter":
			if !m.routeLoading && m.routeCursor >= 0 && m.routeCursor < len(m.routes) && m.routes[m.routeCursor].Eligible {
				m.status = fmt.Sprintf("resume via %s is a v1 TODO", m.routes[m.routeCursor].Name)
				m.overlay = OverlayNone
			}
		case "f":
			m.status = "fork-resume is a v1 TODO"
			m.overlay = OverlayNone
		}
		return m, nil
	}

	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		m.moveSelection(-1)
	case "down", "j":
		m.moveSelection(1)
	case "g":
		if m.view == ViewGroups {
			m.view = ViewTree
		} else {
			m.view = ViewGroups
		}
		m.status = ""
	case "p":
		m.preview = !m.preview
		m.status = ""
	case "r":
		return m.openRoutePicker()
	case "?":
		m.overlay = OverlayHelp
	case "enter":
		if _, ok := m.selectedSession(); ok {
			m.status = "resume is a v1 TODO; press r to inspect real routes"
		}
	case "f":
		if _, ok := m.selectedSession(); ok {
			m.status = "fork-resume is a v1 TODO"
		}
	case "v":
		m.status = "transcript view is outside v1"
	case "/":
		m.status = "search is outside v1"
	case "s":
		m.status = "recency is the only v1 sort"
	}
	return m, nil
}

func (m Model) openRoutePicker() (tea.Model, tea.Cmd) {
	session, ok := m.selectedSession()
	if !ok {
		return m, nil
	}
	m.overlay = OverlayRoute
	m.routeLoading = true
	m.routeSession = session.ID
	m.routeError = ""
	m.routes = nil
	m.routeCursor = 0
	return m, loadRoutesCmd(session)
}

func loadRoutesCmd(session data.Session) tea.Cmd {
	return func() tea.Msg {
		routes, err := data.LoadRoutes(session.Models)
		return routesLoadedMsg{sessionID: session.ID, routes: routes, err: err}
	}
}

func defaultRouteIndex(routes []data.Launcher) int {
	for i, route := range routes {
		if route.Default && route.Eligible {
			return i
		}
	}
	for i, route := range routes {
		if route.Eligible {
			return i
		}
	}
	return 0
}

func (m *Model) moveSelection(delta int) {
	m.status = ""
	if m.view == ViewTree {
		if len(m.snapshot.Tree) == 0 {
			return
		}
		m.treeCursor = clamp(m.treeCursor+delta, 0, len(m.snapshot.Tree)-1)
		return
	}
	m.moveCursor(delta)
}

func (m *Model) moveCursor(delta int) {
	if len(m.rows) == 0 {
		return
	}
	candidate := m.cursor + delta
	for candidate >= 0 && candidate < len(m.rows) {
		if !m.rows[candidate].header {
			m.cursor = candidate
			return
		}
		candidate += delta
	}
}

func (m *Model) moveRouteCursor(delta int) {
	if m.routeLoading || len(m.routes) == 0 {
		return
	}
	candidate := m.routeCursor
	for step := 0; step < len(m.routes); step++ {
		candidate = (candidate + delta + len(m.routes)) % len(m.routes)
		if m.routes[candidate].Eligible {
			m.routeCursor = candidate
			return
		}
	}
}

func clamp(value int, low int, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
