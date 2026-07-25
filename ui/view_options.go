package ui

import (
	"fmt"
	"os"
	"strings"
	"time"

	"ccsspike/data"
	"ccsspike/theme"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type sortMode int

const (
	sortRecency sortMode = iota
	sortCost
	sortMessages
)

func (mode sortMode) String() string {
	switch mode {
	case sortCost:
		return "cost"
	case sortMessages:
		return "messages"
	default:
		return "recency"
	}
}

type taskFilter int

const (
	taskFilterAll taskFilter = iota
	taskFilterUnfinished
	taskFilterInterrupted
)

func (filter taskFilter) String() string {
	switch filter {
	case taskFilterUnfinished:
		return "unfinished"
	case taskFilterInterrupted:
		return "interrupted-mid-task"
	default:
		return "all"
	}
}

type viewOptions struct {
	sort            sortMode
	showArchived    bool
	showSubagents   bool
	showAuxiliary   bool
	taskFilter      taskFilter
	autoRefresh     bool
	refreshInterval time.Duration
}

func defaultViewOptions() viewOptions {
	return viewOptions{
		sort:            sortRecency,
		taskFilter:      taskFilterAll,
		autoRefresh:     true,
		refreshInterval: 8 * time.Second,
	}
}

func (options viewOptions) loadOptions() data.LoadOptions {
	return data.LoadOptions{
		IncludeArchived:  options.showArchived,
		IncludeSubagents: options.showSubagents,
		IncludeAuxiliary: options.showAuxiliary,
	}
}

type viewOptionRow int

const (
	viewOptionSort viewOptionRow = iota
	viewOptionArchived
	viewOptionSubagents
	viewOptionAuxiliary
	viewOptionTasks
	viewOptionAutoRefresh
	viewOptionRefreshInterval
	viewOptionCount
)

var refreshIntervals = []time.Duration{
	5 * time.Second,
	8 * time.Second,
	10 * time.Second,
	30 * time.Second,
}

type autoRefreshMsg struct {
	generation uint64
}

func autoRefreshCmd(interval time.Duration, generation uint64) tea.Cmd {
	return tea.Tick(interval, func(time.Time) tea.Msg {
		return autoRefreshMsg{generation: generation}
	})
}

// procInterval is deliberately faster than any snapshot refresh interval:
// sampling the process table costs ~20ms and touches only the kernel, whereas a
// snapshot reload reads sqlite and transcripts. Memory is the one column that is
// worthless when stale.
const procInterval = 2 * time.Second

type procSampledMsg struct {
	generation uint64
	stats      map[string]data.ProcStat
}

// procSampleCmd samples live process cost off the UI goroutine and schedules the
// next tick. It shares tickerGeneration with the snapshot refresh so pausing
// auto-refresh pauses the whole display, rather than leaving one column moving
// under a frozen list.
func procSampleCmd(generation uint64) tea.Cmd {
	return tea.Tick(procInterval, func(time.Time) tea.Msg {
		home, err := os.UserHomeDir()
		if err != nil {
			return procSampledMsg{generation: generation}
		}
		return procSampledMsg{generation: generation, stats: data.SampleProcStats(home)}
	})
}

func (m Model) handleViewOptionsKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch message.String() {
	case "esc":
		m.overlay = OverlayNone
		return m, nil
	case "up", "k":
		m.viewOptionCursor = clamp(m.viewOptionCursor-1, 0, int(viewOptionCount)-1)
		return m, nil
	case "down", "j":
		m.viewOptionCursor = clamp(m.viewOptionCursor+1, 0, int(viewOptionCount)-1)
		return m, nil
	case "left":
		return m.adjustViewOption(-1)
	case "right", " ", "enter":
		return m.adjustViewOption(1)
	default:
		return m, nil
	}
}

func (m Model) adjustViewOption(direction int) (tea.Model, tea.Cmd) {
	preferredID := ""
	if session, ok := m.selectedSession(); ok {
		preferredID = session.ID
	}
	visibilityChanged := false
	var command tea.Cmd

	switch viewOptionRow(m.viewOptionCursor) {
	case viewOptionSort:
		m.options.sort = sortMode(cycleIndex(int(m.options.sort), int(sortMessages)+1, direction))
		m.rebuildRowsPreserving(preferredID)
	case viewOptionArchived:
		m.options.showArchived = !m.options.showArchived
		visibilityChanged = true
	case viewOptionSubagents:
		m.options.showSubagents = !m.options.showSubagents
		visibilityChanged = true
	case viewOptionAuxiliary:
		m.options.showAuxiliary = !m.options.showAuxiliary
		visibilityChanged = true
	case viewOptionTasks:
		m.options.taskFilter = taskFilter(cycleIndex(int(m.options.taskFilter), int(taskFilterInterrupted)+1, direction))
		m.rebuildRowsPreserving(preferredID)
	case viewOptionAutoRefresh:
		m.options.autoRefresh = !m.options.autoRefresh
		command = m.resetAutoRefreshTicker()
	case viewOptionRefreshInterval:
		current := 0
		for index, interval := range refreshIntervals {
			if interval == m.options.refreshInterval {
				current = index
				break
			}
		}
		m.options.refreshInterval = refreshIntervals[cycleIndex(current, len(refreshIntervals), direction)]
		command = m.resetAutoRefreshTicker()
	}

	if visibilityChanged {
		m.refreshInFlight = true
		command = refreshCmd(m.options.loadOptions(), preferredID, true)
	}
	m.savePrefs()
	return m, command
}

func (m *Model) resetAutoRefreshTicker() tea.Cmd {
	m.tickerGeneration++
	if !m.options.autoRefresh {
		return nil
	}
	return tea.Batch(
		autoRefreshCmd(m.options.refreshInterval, m.tickerGeneration),
		procSampleCmd(m.tickerGeneration))
}

func cycleIndex(current int, count int, direction int) int {
	if count <= 0 {
		return 0
	}
	step := 1
	if direction < 0 {
		step = -1
	}
	return (current + step + count) % count
}

func (m Model) renderViewOptions() string {
	panelWidth := min(68, max(18, m.w-4))
	contentWidth := max(1, panelWidth-8)
	lines := []string{
		fit(fg(theme.Keyword).Bold(true).Render("View Options"), contentWidth),
		fg(theme.FgMoreSubtle).Render("Changes apply immediately to the session list."),
		"",
	}
	labels := []string{
		"Sort",
		"Show archived",
		"Show subagents",
		"Show auxiliary",
		"Task filter",
		"Autorefresh",
		"Refresh interval",
	}
	for index, label := range labels {
		selected := index == m.viewOptionCursor
		caret := "  "
		labelColor := theme.FgSubtle
		valueColor := theme.Accent
		if selected {
			caret = "❯ "
			labelColor = theme.FgBase
			valueColor = theme.Primary
		}
		value := m.viewOptionValue(viewOptionRow(index))
		labelWidth := min(24, max(10, contentWidth/2))
		left := fg(theme.Accent).Render(caret) + fg(labelColor).Bold(selected).Render(pad(label, labelWidth))
		rightWidth := max(1, contentWidth-lipgloss.Width(left))
		right := fg(valueColor).Bold(selected).Render(lpad(value, rightWidth))
		lines = append(lines, fit(left+right, contentWidth))
	}
	lines = append(lines, "", fit(fg(theme.FgMostSubtle).Render("j/k move · space/enter/←→ change · esc close"), contentWidth))
	lines = clipPanelLines(lines, max(1, m.h-4))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Primary).
		Background(theme.BgBase).Padding(1, 3).Width(panelWidth).Render(strings.Join(lines, "\n"))
}

func (m Model) viewOptionValue(row viewOptionRow) string {
	switch row {
	case viewOptionSort:
		return m.options.sort.String()
	case viewOptionArchived:
		return onOff(m.options.showArchived)
	case viewOptionSubagents:
		return onOff(m.options.showSubagents)
	case viewOptionAuxiliary:
		return onOff(m.options.showAuxiliary)
	case viewOptionTasks:
		return m.options.taskFilter.String()
	case viewOptionAutoRefresh:
		return onOff(m.options.autoRefresh)
	case viewOptionRefreshInterval:
		return fmt.Sprintf("%gs", m.options.refreshInterval.Seconds())
	default:
		return ""
	}
}

func onOff(enabled bool) string {
	if enabled {
		return "on"
	}
	return "off"
}
