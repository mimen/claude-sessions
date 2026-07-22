package ui

import (
	"fmt"
	"strings"

	"ccsspike/data"
	"ccsspike/inference"

	tea "github.com/charmbracelet/bubbletea"
)

type inputKind string

const (
	inputRetitle inputKind = "retitle"
	inputEdit    inputKind = "edit"
	inputAsk     inputKind = "ask"
)

type textInput struct {
	kind      inputKind
	sessionID string
	label     string
	buffer    string
}

type confirmationKind string

const (
	confirmComplete  confirmationKind = "complete"
	confirmArchive   confirmationKind = "archive"
	confirmMutations confirmationKind = "mutations"
	confirmCleanup   confirmationKind = "cleanup"
)

type confirmationItem struct {
	sessionID string
	title     string
	detail    string
	enabled   bool
	mutation  *inference.MetadataMutation
}

type confirmation struct {
	kind   confirmationKind
	title  string
	items  []confirmationItem
	cursor int
}

type fleetResults struct {
	query   string
	engine  inference.Name
	matches []inference.AskMatch
	cursor  int
}

func (m Model) handleInputKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.input == nil {
		return m, nil
	}
	switch message.String() {
	case "esc":
		m.input = nil
	case "enter":
		input := *m.input
		input.buffer = strings.TrimSpace(input.buffer)
		if input.buffer == "" {
			m.input = nil
			return m, nil
		}
		m.input = nil
		switch input.kind {
		case inputRetitle:
			m.status = "retitling via ccs…"
			return m, setTitleCmd(input.sessionID, input.buffer)
		case inputEdit:
			m.status = "asking the inference engine for a metadata edit…"
			return m, metadataEditCmd(m.snapshot, input.sessionID, input.buffer)
		case inputAsk:
			m.status = "asking the fleet…"
			return m, askFleetCmd(m.snapshot, input.buffer)
		}
	case "backspace", "delete":
		runes := []rune(m.input.buffer)
		if len(runes) > 0 {
			m.input.buffer = string(runes[:len(runes)-1])
		}
	default:
		if message.Type == tea.KeyRunes && !message.Alt {
			m.input.buffer += string(message.Runes)
		}
	}
	return m, nil
}

func (m Model) handleConfirmationKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.confirmation == nil {
		return m, nil
	}
	confirmation := m.confirmation
	switch message.String() {
	case "esc", "n", "N", "q":
		m.confirmation = nil
		m.status = "action cancelled"
		return m, nil
	case "up", "k":
		confirmation.cursor = clamp(confirmation.cursor-1, 0, max(0, len(confirmation.items)-1))
		return m, nil
	case "down", "j":
		confirmation.cursor = clamp(confirmation.cursor+1, 0, max(0, len(confirmation.items)-1))
		return m, nil
	case " ":
		if confirmation.kind == confirmCleanup && len(confirmation.items) > 0 {
			confirmation.items[confirmation.cursor].enabled = !confirmation.items[confirmation.cursor].enabled
		}
		return m, nil
	case "y", "Y", "enter":
		preferredID := ""
		if session, ok := m.selectedSession(); ok {
			preferredID = session.ID
		}
		switch confirmation.kind {
		case confirmComplete:
			item := confirmation.items[0]
			m.confirmation = nil
			m.status = "marking done via ccs…"
			return m, markCompletedCmd(item.sessionID, preferredID)
		case confirmArchive:
			item := confirmation.items[0]
			m.confirmation = nil
			m.status = "archiving via ccs…"
			return m, archiveBatchCmd([]string{item.sessionID}, preferredID, "archived 1 session")
		case confirmMutations:
			mutations := make([]inference.MetadataMutation, 0, len(confirmation.items))
			for _, item := range confirmation.items {
				if item.mutation != nil {
					mutations = append(mutations, *item.mutation)
				}
			}
			m.confirmation = nil
			m.status = "applying validated mutations via ccs…"
			return m, applyMutationsCmd(mutations, preferredID)
		case confirmCleanup:
			ids := make([]string, 0, len(confirmation.items))
			for _, item := range confirmation.items {
				if item.enabled {
					ids = append(ids, item.sessionID)
				}
			}
			if len(ids) == 0 {
				m.confirmation = nil
				m.status = "cleanup cancelled: no sessions selected"
				return m, nil
			}
			m.confirmation = nil
			m.status = fmt.Sprintf("archiving %d approved sessions via ccs…", len(ids))
			return m, archiveBatchCmd(ids, preferredID, fmt.Sprintf("archived %d sessions", len(ids)))
		}
	}
	return m, nil
}

func (m Model) handleFleetResultsKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.fleetResults == nil {
		return m, nil
	}
	switch message.String() {
	case "esc", "q", "A":
		m.fleetResults = nil
	case "up", "k":
		m.fleetResults.cursor = clamp(m.fleetResults.cursor-1, 0, max(0, len(m.fleetResults.matches)-1))
	case "down", "j":
		m.fleetResults.cursor = clamp(m.fleetResults.cursor+1, 0, max(0, len(m.fleetResults.matches)-1))
	case "enter":
		if len(m.fleetResults.matches) == 0 {
			m.fleetResults = nil
			return m, nil
		}
		match := m.fleetResults.matches[m.fleetResults.cursor]
		m.fleetResults = nil
		m.jumpToSession(match.SessionID)
		m.status = "fleet match → " + match.Title
		return m, m.loadSelectedTranscriptCmd()
	}
	return m, nil
}

func (m *Model) jumpToSession(sessionID string) {
	index, ok := m.snapshot.ByID[sessionID]
	if !ok {
		return
	}
	m.view = ViewFlat
	m.query = ""
	m.rebuildRows()
	for rowIndex, candidate := range m.rows {
		if !candidate.header && candidate.sIdx == index {
			m.cursor = rowIndex
			return
		}
	}
}

func (m *Model) replaceSnapshot(snapshot data.Snapshot, preferredID string) {
	m.snapshot = snapshot
	m.rebuildRows()
	if preferredID == "" {
		return
	}
	if m.view == ViewTree {
		for index, node := range snapshot.Tree {
			if node.SessionID == preferredID {
				m.treeCursor = index
				return
			}
		}
		m.treeCursor = clamp(m.treeCursor, 0, max(0, len(snapshot.Tree)-1))
		return
	}
	preferredIndex, ok := snapshot.ByID[preferredID]
	if !ok {
		m.cursor = clamp(m.cursor, 0, max(0, len(m.rows)-1))
		if len(m.rows) > 0 && m.rows[m.cursor].header {
			m.cursor = firstSessionRow(m.rows)
		}
		return
	}
	for rowIndex, candidate := range m.rows {
		if !candidate.header && candidate.sIdx == preferredIndex {
			m.cursor = rowIndex
			return
		}
	}
}

func mutationDescription(mutation inference.MetadataMutation) string {
	switch mutation.Op {
	case "completed", "archived":
		value := false
		if mutation.Enabled != nil {
			value = *mutation.Enabled
		}
		return fmt.Sprintf("%s = %t", mutation.Op, value)
	case "identity_field":
		return mutation.Field + " = " + mutationValue(mutation.Value)
	default:
		return mutation.Op + " = " + mutationValue(mutation.Value)
	}
}

func mutationValue(value *string) string {
	if value == nil {
		return "(clear)"
	}
	return *value
}
