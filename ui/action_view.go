package ui

import (
	"fmt"
	"strings"

	"ccsspike/theme"

	"github.com/charmbracelet/lipgloss"
)

func (m Model) renderConfirmation() string {
	confirmation := m.confirmation
	if confirmation == nil {
		return ""
	}
	panelWidth := min(88, max(18, m.w-4))
	contentWidth := max(1, panelWidth-8)
	maxItems := max(1, (m.h-10)/2)
	start := confirmation.cursor - maxItems/2
	start = clamp(start, 0, max(0, len(confirmation.items)-maxItems))
	end := min(len(confirmation.items), start+maxItems)
	lines := []string{
		fit(fg(theme.Keyword).Bold(true).Render(confirmation.title), contentWidth),
		fg(theme.FgMoreSubtle).Render(fmt.Sprintf("%d proposed change(s)", len(confirmation.items))),
		"",
	}
	for index := start; index < end; index++ {
		item := confirmation.items[index]
		selected := index == confirmation.cursor
		caret := "  "
		if selected {
			caret = "❯ "
		}
		mark := "•"
		if confirmation.kind == confirmCleanup {
			if item.enabled {
				mark = "☑"
			} else {
				mark = "☐"
			}
		}
		color := theme.FgSubtle
		if selected {
			color = theme.FgBase
		}
		title := fg(color).Bold(selected).Render(truncate(item.title, max(1, contentWidth-5)))
		lines = append(lines, fit(fg(theme.Accent).Render(caret)+fg(theme.Success).Render(mark+" ")+title, contentWidth))
		lines = append(lines, fit(fg(theme.FgMostSubtle).Render("    "+truncate(item.detail, max(1, contentWidth-4))), contentWidth))
	}
	if confirmation.kind == confirmCleanup {
		lines = append(lines, "", fit(fg(theme.FgMostSubtle).Render("j/k move · space toggle · y/enter archive checked · esc cancel"), contentWidth))
	} else {
		lines = append(lines, "", fit(fg(theme.FgMostSubtle).Render("y/enter apply via ccs · esc cancel"), contentWidth))
	}
	lines = clipPanelLines(lines, max(1, m.h-4))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Warning).
		Background(theme.BgBase).Padding(1, 3).Width(panelWidth).Render(strings.Join(lines, "\n"))
}

func (m Model) renderFleetResults() string {
	results := m.fleetResults
	if results == nil {
		return ""
	}
	panelWidth := min(92, max(18, m.w-4))
	contentWidth := max(1, panelWidth-8)
	lines := []string{
		fit(fg(theme.Keyword).Bold(true).Render("Ask the fleet"), contentWidth),
		fg(theme.FgMoreSubtle).Render(truncate(results.query, contentWidth)),
		fg(theme.FgMostSubtle).Render(fmt.Sprintf("%s · %d match(es)", results.engine, len(results.matches))),
		"",
	}
	if len(results.matches) == 0 {
		lines = append(lines, fg(theme.FgMoreSubtle).Render("No transcript match found."))
	} else {
		maxItems := max(1, (m.h-11)/3)
		start := results.cursor - maxItems/2
		start = clamp(start, 0, max(0, len(results.matches)-maxItems))
		end := min(len(results.matches), start+maxItems)
		for index := start; index < end; index++ {
			match := results.matches[index]
			selected := index == results.cursor
			caret := "  "
			if selected {
				caret = "❯ "
			}
			color := theme.FgSubtle
			if selected {
				color = theme.FgBase
			}
			title := fg(color).Bold(selected).Render(truncate(match.Title, max(1, contentWidth-10)))
			score := fg(theme.Accent).Render(fmt.Sprintf(" %d%%", match.Score))
			lines = append(lines, fit(fg(theme.Accent).Render(caret)+title+score, contentWidth))
			lines = append(lines, fit(fg(theme.FgSubtle).Render("    "+truncate(match.Answer, max(1, contentWidth-4))), contentWidth))
			lines = append(lines, fit(fg(theme.FgMostSubtle).Render("    "+truncate(match.Reason, max(1, contentWidth-4))), contentWidth))
		}
	}
	lines = append(lines, "", fit(fg(theme.FgMostSubtle).Render("j/k move · enter jump to session · esc close"), contentWidth))
	lines = clipPanelLines(lines, max(1, m.h-4))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Accent).
		Background(theme.BgBase).Padding(1, 3).Width(panelWidth).Render(strings.Join(lines, "\n"))
}
