package ui

import (
	"ccsspike/data"
	"ccsspike/resume"

	tea "github.com/charmbracelet/bubbletea"
)

type View int

const (
	ViewGroups View = iota
	ViewTree
	ViewFlat
)

type Overlay int

const (
	OverlayNone Overlay = iota
	OverlayRoute
	OverlayHelp
)

// row is one virtualized list line: a section header or a session ref.
type row struct {
	header bool
	key    string
	label  string
	glyph  string
	level  int
	count  int
	sIdx   int
}

type routesLoadedMsg struct {
	sessionID string
	routes    []data.Launcher
	err       error
}

type cmuxOpenedMsg struct {
	title string
	note  string
	err   error
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
	query        string
	searching    bool
	handoff      *resume.Command
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

// Handoff returns the inline resume command selected before the TUI exited.
func (m Model) Handoff() (resume.Command, bool) {
	if m.handoff == nil {
		return resume.Command{}, false
	}
	return *m.handoff, true
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
	case cmuxOpenedMsg:
		if msg.err != nil {
			m.status = msg.err.Error()
		} else if msg.note != "" {
			m.status = msg.note + " · opened in cmux → " + msg.title
		} else {
			m.status = "opened in cmux → " + msg.title
		}
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
				return m.activateRoute(m.routes[m.routeCursor])
			}
		}
		return m, nil
	}
	if m.searching {
		switch msg.String() {
		case "esc":
			m.query = ""
			m.searching = false
			m.rebuildRows()
		case "enter":
			m.searching = false
		case "up":
			m.moveSelection(-1)
		case "down":
			m.moveSelection(1)
		case "backspace", "delete":
			if len(m.query) > 0 {
				m.query = m.query[:len(m.query)-1]
				m.rebuildRows()
			}
		default:
			if msg.Type == tea.KeyRunes && !msg.Alt {
				m.query += string(msg.Runes)
				m.rebuildRows()
			}
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
		switch m.view {
		case ViewGroups:
			m.view = ViewTree
		case ViewTree:
			m.view = ViewFlat
		default:
			m.view = ViewGroups
		}
		m.rebuildRows()
		m.status = ""
	case "p":
		m.preview = !m.preview
		m.status = ""
	case "r":
		return m.openRoutePicker()
	case "?":
		m.overlay = OverlayHelp
	case "enter":
		return m.resumeDefault()
	case "v":
		m.status = "transcript view is outside v1"
	case "/":
		m.searching = true
		m.status = ""
	case "s":
		m.status = "recency is the only v1 sort"
	}
	return m, nil
}

func (m Model) resumeDefault() (tea.Model, tea.Cmd) {
	session, ok := m.selectedSession()
	if !ok {
		return m, nil
	}
	routes, err := data.LoadRoutes(session.Models)
	if err != nil {
		m.status = "can't resolve origin backend: " + err.Error()
		return m, nil
	}
	index := defaultRouteIndex(routes)
	if index < 0 || index >= len(routes) || !routes[index].Eligible {
		m.status = "no configured launcher can replay this session"
		return m, nil
	}
	return m.activateRoute(routes[index])
}

func (m Model) activateRoute(route data.Launcher) (tea.Model, tea.Cmd) {
	session, ok := m.selectedSession()
	if !ok {
		return m, nil
	}
	command, note := resume.Build(session, route)
	m.overlay = OverlayNone
	if route.Target == "cmux" {
		m.status = "opening in cmux…"
		return m, openCmuxCmd(command, session.Title, note)
	}
	m.handoff = &command
	return m, tea.Quit
}

func openCmuxCmd(command resume.Command, title string, note string) tea.Cmd {
	return func() tea.Msg {
		return cmuxOpenedMsg{title: title, note: note, err: resume.OpenCmux(command, title)}
	}
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

func (m *Model) rebuildRows() {
	if m.view == ViewFlat {
		m.rows = buildFlatRows(m.snapshot.Sessions, m.query)
	} else {
		m.rows = buildDefaultRows(m.snapshot.Sessions, m.query)
	}
	m.cursor = firstSessionRow(m.rows)
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
