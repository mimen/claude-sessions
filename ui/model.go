package ui

import (
	"time"

	"ccsspike/data"
	"ccsspike/resume"
	"ccsspike/skills"
	"ccsspike/transcript"

	tea "github.com/charmbracelet/bubbletea"
)

type AppMode int

const (
	ModeSessions AppMode = iota
	ModeSkills
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

type liveFocusedMsg struct {
	title string
	err   error
}

type transcriptLoadedMsg struct {
	sessionID string
	document  transcript.Document
	full      bool
	err       error
}

type transcriptReader struct {
	sessionID   string
	title       string
	document    transcript.Document
	visual      []visualTranscriptLine
	visualWidth int
	scroll      int
}

// Model is the single Bubble Tea state machine for the browser.
type Model struct {
	w, h               int
	mode               AppMode
	view               View
	overlay            Overlay
	snapshot           data.Snapshot
	rows               []row
	cursor             int
	treeCursor         int
	preview            bool
	routes             []data.Launcher
	routeCursor        int
	routeLoading       bool
	routeSession       string
	routeError         string
	query              string
	searching          bool
	transcripts        map[string]transcript.Document
	fullTranscripts    map[string]transcript.Document
	transcriptErrs     map[string]string
	transcriptLoading  map[string]bool
	transcriptLoadedAt map[string]time.Time
	readerLoading      map[string]bool
	peekSession        string
	peekScroll         int
	openReaderID       string
	reader             *transcriptReader
	input              *textInput
	confirmation       *confirmation
	fleetResults       *fleetResults
	summaries          map[string]string
	skills             skills.Snapshot
	skillRows          []skillRow
	skillCursor        int
	skillView          skillView
	skillQuery         string
	skillSearching     bool
	skillLoading       bool
	skillError         string
	skillPreview       bool
	skillReader        *skillReader
	handoff            *resume.Command
	status             string
}

// New creates a browser over an immutable real-data snapshot.
func New(snapshot data.Snapshot) Model {
	rows := buildRows(snapshot.Sessions)
	return Model{
		w:                  120,
		h:                  40,
		view:               ViewGroups,
		preview:            true,
		skillView:          skillViewCategory,
		skillPreview:       true,
		snapshot:           snapshot,
		rows:               rows,
		cursor:             firstSessionRow(rows),
		transcripts:        make(map[string]transcript.Document),
		fullTranscripts:    make(map[string]transcript.Document),
		transcriptErrs:     make(map[string]string),
		transcriptLoading:  make(map[string]bool),
		transcriptLoadedAt: make(map[string]time.Time),
		readerLoading:      make(map[string]bool),
		summaries:          make(map[string]string),
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

func (m Model) Init() tea.Cmd {
	return m.loadSelectedTranscriptCmd()
}

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
		m.reflowTranscriptReader()
		return m, nil
	case skillsLoadedMsg:
		m.skillLoading = false
		if msg.err != nil {
			m.skillError = msg.err.Error()
			return m, nil
		}
		m.skills = msg.snapshot
		m.skillError = ""
		m.rebuildSkillRows()
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
	case liveFocusedMsg:
		if msg.err != nil {
			m.status = msg.err.Error()
		} else {
			m.status = "focused live session → " + msg.title
		}
		return m, nil
	case transcriptLoadedMsg:
		if msg.full {
			delete(m.readerLoading, msg.sessionID)
			if msg.err == nil {
				m.cacheFullTranscript(msg.sessionID, msg.document)
			}
			if m.openReaderID == msg.sessionID {
				m.openReaderID = ""
				if msg.err != nil {
					m.status = "transcript unavailable: " + msg.err.Error()
				} else if session, ok := m.snapshot.SessionByID(msg.sessionID); ok {
					m.openTranscriptDocument(session, msg.document)
				}
			}
			return m, nil
		}
		delete(m.transcriptLoading, msg.sessionID)
		m.transcriptLoadedAt[msg.sessionID] = time.Now()
		if msg.err != nil {
			m.transcriptErrs[msg.sessionID] = msg.err.Error()
		} else {
			m.cachePeekTranscript(msg.sessionID, msg.document)
			delete(m.transcriptErrs, msg.sessionID)
		}
		if session, ok := m.selectedSession(); ok && session.ID == msg.sessionID && msg.err == nil {
			m.peekSession = msg.sessionID
			m.peekScroll = max(0, len(msg.document.Lines)-6)
		}
		return m, nil
	case writeFinishedMsg:
		if msg.reloaded {
			m.replaceSnapshot(msg.snapshot, msg.preferredID)
		}
		if msg.err != nil {
			m.status = msg.err.Error()
			return m, m.loadSelectedTranscriptCmd()
		}
		m.status = msg.status
		return m, m.loadSelectedTranscriptCmd()
	case metadataProposedMsg:
		if msg.err != nil {
			m.status = "AI edit failed: " + msg.err.Error()
		} else if len(msg.mutations) == 0 {
			m.status = string(msg.engine) + " proposed no metadata changes"
		} else {
			items := make([]confirmationItem, 0, len(msg.mutations))
			for index := range msg.mutations {
				mutation := msg.mutations[index]
				session, _ := m.snapshot.SessionByID(mutation.SessionID)
				items = append(items, confirmationItem{sessionID: mutation.SessionID, title: session.Title, detail: mutationDescription(mutation), enabled: true, mutation: &mutation})
			}
			m.confirmation = &confirmation{kind: confirmMutations, title: string(msg.engine) + " metadata proposal", items: items}
			m.status = ""
		}
		return m, nil
	case summaryLoadedMsg:
		if msg.err != nil {
			m.status = "summary failed: " + msg.err.Error()
		} else {
			m.summaries[msg.sessionID] = msg.summary
			m.status = "summary generated by " + string(msg.engine)
		}
		return m, nil
	case fleetAskedMsg:
		if msg.err != nil {
			m.status = "ask-the-fleet failed: " + msg.err.Error()
		} else {
			m.fleetResults = &fleetResults{query: msg.query, engine: msg.engine, matches: msg.matches}
			m.status = ""
		}
		return m, nil
	case cleanupProposedMsg:
		if msg.err != nil {
			m.status = "AI cleanup failed: " + msg.err.Error()
		} else if len(msg.proposals) == 0 {
			m.status = string(msg.engine) + " proposed no safe archives"
		} else {
			items := make([]confirmationItem, 0, len(msg.proposals))
			for _, proposal := range msg.proposals {
				items = append(items, confirmationItem{sessionID: proposal.SessionID, title: proposal.Title, detail: proposal.Reason, enabled: true})
			}
			m.confirmation = &confirmation{kind: confirmCleanup, title: string(msg.engine) + " cleanup proposal", items: items}
			m.status = ""
		}
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.mode == ModeSkills {
		return m.handleSkillKey(msg)
	}
	if m.reader != nil {
		page := max(1, m.h-6)
		maxScroll := max(0, len(m.reader.visual)-page)
		switch msg.String() {
		case "esc", "q", "v":
			m.reader = nil
		case "up", "k":
			m.reader.scroll = max(0, m.reader.scroll-1)
		case "down", "j":
			m.reader.scroll = min(maxScroll, m.reader.scroll+1)
		case "pgup":
			m.reader.scroll = max(0, m.reader.scroll-page)
		case "pgdown", " ":
			m.reader.scroll = min(maxScroll, m.reader.scroll+page)
		case "g":
			m.reader.scroll = 0
		case "G":
			m.reader.scroll = maxScroll
		}
		return m, nil
	}
	if m.confirmation != nil {
		return m.handleConfirmationKey(msg)
	}
	if m.fleetResults != nil {
		return m.handleFleetResultsKey(msg)
	}
	if m.input != nil {
		return m.handleInputKey(msg)
	}
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
			return m, m.loadSelectedTranscriptCmd()
		case "down":
			m.moveSelection(1)
			return m, m.loadSelectedTranscriptCmd()
		case "backspace", "delete":
			runes := []rune(m.query)
			if len(runes) > 0 {
				m.query = string(runes[:len(runes)-1])
				m.rebuildRows()
			}
		default:
			if msg.Type == tea.KeyRunes && !msg.Alt {
				m.query += string(msg.Runes)
				m.rebuildRows()
			}
		}
		return m, m.loadSelectedTranscriptCmd()
	}

	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "tab":
		m.mode = ModeSkills
		m.status = ""
		if len(m.skills.Skills) == 0 && !m.skillLoading {
			m.skillLoading = true
			return m, loadSkillsCmd()
		}
	case "up", "k":
		m.moveSelection(-1)
		return m, m.loadSelectedTranscriptCmd()
	case "down", "j":
		m.moveSelection(1)
		return m, m.loadSelectedTranscriptCmd()
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
		return m, m.loadSelectedTranscriptCmd()
	case "p":
		m.preview = !m.preview
		m.status = ""
	case "r":
		return m.openRoutePicker()
	case "t":
		if session, ok := m.selectedSession(); ok {
			m.input = &textInput{kind: inputRetitle, sessionID: session.ID, label: "new title"}
		}
	case "C":
		if session, ok := m.selectedSession(); ok {
			m.confirmation = &confirmation{kind: confirmComplete, title: "Mark session done?", items: []confirmationItem{{sessionID: session.ID, title: session.Title, detail: "ccs mark --completed", enabled: true}}}
		}
	case "X":
		if session, ok := m.selectedSession(); ok {
			m.confirmation = &confirmation{kind: confirmArchive, title: "Archive session?", items: []confirmationItem{{sessionID: session.ID, title: session.Title, detail: "ccs mark --archived", enabled: true}}}
		}
	case "e":
		if session, ok := m.selectedSession(); ok {
			m.input = &textInput{kind: inputEdit, sessionID: session.ID, label: "AI metadata edit"}
		}
	case "S":
		if session, ok := m.selectedSession(); ok {
			m.status = "summarizing with the inference engine…"
			return m, summaryCmd(session)
		}
	case "A":
		m.input = &textInput{kind: inputAsk, label: "ask the fleet"}
	case "D":
		m.status = "asking the inference engine for cleanup candidates…"
		return m, cleanupCmd(m.snapshot)
	case "?":
		m.overlay = OverlayHelp
	case "enter":
		return m.resumeDefault()
	case "J":
		m.scrollPeek(1)
		return m, m.loadSelectedTranscriptCmd()
	case "K":
		m.scrollPeek(-1)
		return m, m.loadSelectedTranscriptCmd()
	case "v":
		return m.openTranscriptReader()
	case "/":
		m.view = ViewFlat
		m.rebuildRows()
		m.searching = true
		m.status = ""
	case "s":
		m.status = "recency is the only v1 sort"
	}
	return m, nil
}

func (m *Model) loadSelectedTranscriptCmd() tea.Cmd {
	session, ok := m.selectedSession()
	if !ok || session.Path == "" || m.transcriptLoading[session.ID] {
		return nil
	}
	loadedAt, attempted := m.transcriptLoadedAt[session.ID]
	if attempted {
		age := time.Since(loadedAt)
		_, cached := m.transcripts[session.ID]
		live := session.State == "active" || session.LiveWorkspaceRef != ""
		if (cached && (!live || age < 15*time.Second)) || (!cached && age < 30*time.Second) {
			return nil
		}
	}
	m.transcriptLoading[session.ID] = true
	return loadTranscriptCmd(session, false)
}

func loadTranscriptCmd(session data.Session, full bool) tea.Cmd {
	return func() tea.Msg {
		var document transcript.Document
		var err error
		if full {
			document, err = transcript.Read(session.Path, 2000)
		} else {
			document, err = transcript.ReadRecent(session.Path, 200, 512*1024)
		}
		return transcriptLoadedMsg{sessionID: session.ID, document: document, full: full, err: err}
	}
}

func (m *Model) cachePeekTranscript(sessionID string, document transcript.Document) {
	if _, exists := m.transcripts[sessionID]; !exists && len(m.transcripts) >= 64 {
		m.evictOldestTranscript(m.transcripts, sessionID, true)
	}
	m.transcripts[sessionID] = document
}

func (m *Model) cacheFullTranscript(sessionID string, document transcript.Document) {
	if _, exists := m.fullTranscripts[sessionID]; !exists && len(m.fullTranscripts) >= 8 {
		m.evictOldestTranscript(m.fullTranscripts, sessionID, false)
	}
	m.fullTranscripts[sessionID] = document
}

func (m *Model) evictOldestTranscript(cache map[string]transcript.Document, keepID string, dropAttempt bool) {
	oldestID := ""
	var oldest time.Time
	for sessionID := range cache {
		if sessionID == keepID {
			continue
		}
		loadedAt := m.transcriptLoadedAt[sessionID]
		if oldestID == "" || loadedAt.Before(oldest) {
			oldestID = sessionID
			oldest = loadedAt
		}
	}
	if oldestID != "" {
		delete(cache, oldestID)
		if dropAttempt {
			delete(m.transcriptLoadedAt, oldestID)
			delete(m.transcriptErrs, oldestID)
		}
	}
}

func (m *Model) scrollPeek(delta int) {
	session, ok := m.selectedSession()
	if !ok {
		return
	}
	document, cached := m.transcripts[session.ID]
	if !cached {
		return
	}
	if m.peekSession != session.ID {
		m.peekSession = session.ID
		m.peekScroll = max(0, len(document.Lines)-6)
	}
	m.peekScroll = clamp(m.peekScroll+delta, 0, max(0, len(document.Lines)-1))
}

func (m Model) openTranscriptReader() (tea.Model, tea.Cmd) {
	session, ok := m.selectedSession()
	if !ok || session.Path == "" {
		return m, nil
	}
	if document, cached := m.fullTranscripts[session.ID]; cached {
		m.openTranscriptDocument(session, document)
		return m, nil
	}
	m.openReaderID = session.ID
	m.status = "loading full transcript…"
	if m.readerLoading[session.ID] {
		return m, nil
	}
	m.readerLoading[session.ID] = true
	return m, loadTranscriptCmd(session, true)
}

func (m *Model) openTranscriptDocument(session data.Session, document transcript.Document) {
	m.reader = &transcriptReader{sessionID: session.ID, title: session.Title, document: document}
	m.reflowTranscriptReader()
}

func (m *Model) reflowTranscriptReader() {
	if m.reader == nil {
		return
	}
	width := max(4, m.w-10)
	if m.reader.visualWidth == width && m.reader.visual != nil {
		return
	}
	m.reader.visual = transcriptVisualLines(m.reader.document.Lines, width)
	m.reader.visualWidth = width
	page := max(1, m.h-6)
	m.reader.scroll = min(m.reader.scroll, max(0, len(m.reader.visual)-page))
}

func (m Model) resumeDefault() (tea.Model, tea.Cmd) {
	session, ok := m.selectedSession()
	if !ok {
		return m, nil
	}
	if session.LiveWorkspaceRef != "" {
		m.status = "focusing live session…"
		return m, focusLiveCmd(session)
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
	m.overlay = OverlayNone
	if session.LiveWorkspaceRef != "" {
		m.status = "focusing live session…"
		return m, focusLiveCmd(session)
	}
	command, note, err := resume.Build(session, route)
	if err != nil {
		m.status = "can't locate resume directory: " + err.Error()
		return m, nil
	}
	if route.Target == "cmux" {
		m.status = "opening in cmux…"
		return m, openCmuxCmd(command, session.Title, note)
	}
	m.handoff = &command
	return m, tea.Quit
}

func focusLiveCmd(session data.Session) tea.Cmd {
	return func() tea.Msg {
		return liveFocusedMsg{title: session.Title, err: resume.FocusLive(session)}
	}
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
