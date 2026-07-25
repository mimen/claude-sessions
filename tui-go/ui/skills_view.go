package ui

import (
	"fmt"
	"strings"
	"time"

	"ccsspike/skills"
	"ccsspike/theme"

	"github.com/charmbracelet/lipgloss"
)

func (m Model) renderSkillsScreen() string {
	innerW := max(1, m.w-4)
	innerH := max(1, m.h-2)
	if m.skillReader != nil {
		content := m.renderSkillReader(innerW, innerH)
		return lipgloss.NewStyle().Background(theme.BgBase).Padding(1, 2).Render(content)
	}
	bodyH := max(1, innerH-4)
	viewLabel := "category"
	switch m.skillView {
	case skillViewHome:
		viewLabel = "home"
	case skillViewName:
		viewLabel = "name"
	case skillViewActivity:
		viewLabel = "activity"
	case skillViewFlat:
		viewLabel = "flat"
	}
	brand := fg(theme.Accent).Bold(true).Render("ccs") + fg(theme.FgMoreSubtle).Render(" · skills")
	stats := fg(theme.FgBase).Bold(true).Render(fmt.Sprintf("%d", len(m.skills.Skills))) + fg(theme.FgMoreSubtle).Render(" machine-wide")
	right := fg(theme.FgMoreSubtle).Render(viewLabel + " · " + nonEmpty(m.skills.Source, "loading"))
	header := joinSides(brand+fg(theme.FgMostSubtle).Render("   ")+stats, right, innerW)
	rule := fg(theme.Sep).Render(strings.Repeat("─", innerW))

	var body string
	if m.skillPreview && innerW >= 86 {
		listW := innerW * 60 / 100
		previewW := innerW - listW - 2
		list := theme.Main.Width(listW).Height(bodyH).Render(clipHeight(m.renderSkillList(listW, bodyH), bodyH))
		divider := lipgloss.NewStyle().Border(lipgloss.NormalBorder(), false, false, false, true).BorderForeground(theme.Sep).BorderBackground(theme.BgBase).Background(theme.BgBase).Width(previewW).Height(bodyH).PaddingLeft(2)
		preview := divider.Render(clipHeight(m.renderSkillPreview(max(4, previewW-3), bodyH), bodyH))
		body = lipgloss.JoinHorizontal(lipgloss.Top, list, preview)
	} else {
		body = theme.Main.Width(innerW).Height(bodyH).Render(clipHeight(m.renderSkillList(innerW, bodyH), bodyH))
	}
	footer := m.renderSkillFooter(innerW)
	document := lipgloss.JoinVertical(lipgloss.Left, fit(header, innerW), rule, clipHeight(body, bodyH), footer)
	return lipgloss.NewStyle().Background(theme.BgBase).Padding(1, 2).Render(document)
}

func (m Model) renderSkillList(width int, height int) string {
	if m.skillLoading {
		return fg(theme.FgMoreSubtle).Render("Scanning the machine for skills…")
	}
	if m.skillError != "" {
		return fg(theme.Warning).Render(truncate(m.skillError, width))
	}
	if len(m.skillRows) == 0 {
		return fg(theme.FgMoreSubtle).Render("No skills found.")
	}
	start, end := m.skillWindow(height)
	lines := make([]string, 0, end-start)
	for index := start; index < end; index++ {
		row := m.skillRows[index]
		selected := index == m.skillCursor
		if row.header {
			label := strings.ToUpper(row.label)
			count := fmt.Sprintf(" (%d) ", row.count)
			ruleLen := max(0, width-len([]rune(label))-len(count)-4)
			lines = append(lines, fit(fg(theme.FgMostSubtle).Render("  ")+fg(theme.Accent).Bold(true).Render(label)+fg(theme.FgMoreSubtle).Render(count)+fg(theme.Sep).Render(strings.Repeat("─", ruleLen)), width))
			continue
		}
		lines = append(lines, m.renderSkillRow(width, m.skills.Skills[row.sIdx], selected))
	}
	return strings.Join(lines, "\n")
}

func (m Model) renderSkillRow(width int, skill skills.Skill, selected bool) string {
	background := theme.BgBase
	if selected {
		background = theme.BgLow
	}
	style := func(color lipgloss.Color) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(color).Background(background)
	}
	caret := style(theme.Accent).Render(" ")
	if selected {
		caret = style(theme.Primary).Bold(true).Render("❯")
	}
	right := ""
	if width >= 58 {
		usage := "·"
		if skill.Usage.Invocations+skill.Usage.Commands+skill.Usage.Reads > 0 {
			usage = fmt.Sprintf("%d/%d/%d", skill.Usage.Invocations, skill.Usage.Commands, skill.Usage.Reads)
		}
		right = style(theme.FgMoreSubtle).Render(pad(skill.Home, 13) + " " + pad(skill.Category, 12) + " " + lpad(usage, 9) + " " + lpad(skillAge(skill.Usage.LastUsed), 5))
	}
	nameWidth := max(1, width-lipgloss.Width(right)-3)
	name := skill.Name
	if skill.Drift {
		name += " ≠"
	}
	color := theme.FgSubtle
	if selected {
		color = theme.FgBase
	}
	line := caret + style(background).Render(" ") + style(color).Bold(selected).Render(pad(name, nameWidth))
	if right != "" {
		line += style(background).Render(" ") + right
	}
	return lipgloss.NewStyle().Background(background).Width(width).Render(fit(line, width))
}

func (m Model) renderSkillPreview(width int, height int) string {
	skill, ok := m.selectedSkill()
	if !ok {
		return fg(theme.FgMoreSubtle).Render("no skill selected")
	}
	files := skills.Files(skill)
	lines := []string{
		fg(theme.FgBase).Bold(true).Render(truncate(skill.Name, width)),
		fg(theme.FgSubtle).Render(truncate(nonEmpty(skill.Description, "(no description)"), width)),
		"",
		sect("Registry"),
		fg(theme.FgMostSubtle).Render(pad("home", 11)) + fg(theme.Info).Render(truncate(skill.Home, max(1, width-11))),
		fg(theme.FgMostSubtle).Render(pad("ecosystem", 11)) + fg(theme.FgSubtle).Render(truncate(skill.Ecosystem, max(1, width-11))),
		fg(theme.FgMostSubtle).Render(pad("category", 11)) + fg(theme.Keyword).Render(truncate(nonEmpty(skill.Category, "—"), max(1, width-11))),
		fg(theme.FgMostSubtle).Render(pad("path", 11)) + fg(theme.FgSubtle).Render(truncate(compactHome(skill.Path), max(1, width-11))),
	}
	if len(skill.Tags) > 0 {
		lines = append(lines, fg(theme.FgMostSubtle).Render(pad("tags", 11))+fg(theme.Accent).Render(truncate(strings.Join(skill.Tags, ", "), max(1, width-11))))
	}
	if len(skill.Aliases) > 0 {
		lines = append(lines, fg(theme.FgMostSubtle).Render(pad("aliases", 11))+fg(theme.FgMoreSubtle).Render(fmt.Sprintf("%d", len(skill.Aliases))))
	}
	lines = append(lines, "", sect("Usage"))
	if skill.Usage.Invocations+skill.Usage.Commands+skill.Usage.Reads == 0 {
		lines = append(lines, fg(theme.FgMostSubtle).Render("never observed in cached transcripts"))
	} else {
		lines = append(lines, fg(theme.FgSubtle).Render(fmt.Sprintf("%d invoked · %d slash · %d reads", skill.Usage.Invocations, skill.Usage.Commands, skill.Usage.Reads)))
		lines = append(lines, fg(theme.FgMoreSubtle).Render("last "+skillAge(skill.Usage.LastUsed)))
	}
	lines = append(lines, "", sect("Files"))
	for index, file := range files {
		if index == 7 {
			lines = append(lines, fg(theme.FgMostSubtle).Render(fmt.Sprintf("  … %d more", len(files)-index)))
			break
		}
		lines = append(lines, fg(theme.FgSubtle).Render("  "+truncate(file.Relative, max(1, width-8)))+fg(theme.FgMostSubtle).Render(" "+formatFileSize(file.Size)))
	}
	return strings.Join(lines[:min(len(lines), max(1, height))], "\n")
}

func (m Model) renderSkillReader(width int, height int) string {
	reader := m.skillReader
	if reader == nil {
		return ""
	}
	bodyHeight := max(1, height-4)
	maxScroll := max(0, len(reader.lines)-bodyHeight)
	scroll := clamp(reader.scroll, 0, maxScroll)
	file := reader.files[reader.fileIndex].Relative
	tabs := make([]string, 0, min(5, len(reader.files)))
	for index, candidate := range reader.files {
		if index >= 5 {
			break
		}
		color := theme.FgMostSubtle
		if index == reader.fileIndex {
			color = theme.Accent
		}
		tabs = append(tabs, fg(color).Bold(index == reader.fileIndex).Render(candidate.Relative))
	}
	header := fg(theme.FgBase).Bold(true).Render(truncate(reader.skill.Name, max(1, width/3))) + fg(theme.FgMoreSubtle).Render(" · ") + strings.Join(tabs, fg(theme.FgMostSubtle).Render("  "))
	lines := []string{fit(header, width), fg(theme.Sep).Render(strings.Repeat("─", width))}
	if reader.err != "" {
		lines = append(lines, fg(theme.Warning).Render(truncate(reader.err, width)))
	} else {
		for _, line := range reader.lines[scroll:min(len(reader.lines), scroll+bodyHeight)] {
			color := theme.FgSubtle
			bold := false
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				color = theme.Accent
				bold = true
			}
			lines = append(lines, fit(fg(color).Bold(bold).Render(line), width))
		}
	}
	for len(lines) < height-1 {
		lines = append(lines, "")
	}
	position := "END"
	if scroll < maxScroll {
		position = fmt.Sprintf("%d%%", scroll*100/max(1, maxScroll))
	}
	lines = append(lines, fit(fg(theme.FgMoreSubtle).Render("j/k · PgUp/PgDn · Tab/←→ files · g/G · v/esc close · "+file+" · "+position), width))
	return strings.Join(lines, "\n")
}

func (m Model) renderSkillFooter(width int) string {
	if m.skillSearching {
		return fit(fg(theme.Accent).Bold(true).Render("/ ")+fg(theme.FgBase).Render(m.skillQuery)+fg(theme.FgMostSubtle).Render("  name · description · path · #category"), width)
	}
	if m.skillLoading {
		return fit(fg(theme.Warning).Render("scanning machine-wide registry…"), width)
	}
	if m.skillError != "" {
		return fit(fg(theme.Warning).Render(m.skillError), width)
	}
	if m.skillWarning != "" {
		return fit(fg(theme.Warning).Render(m.skillWarning)+fg(theme.FgMoreSubtle).Render(" · R rescan"), width)
	}
	return fit(fg(theme.Accent).Bold(true).Render("Tab")+fg(theme.FgMoreSubtle).Render(" sessions · ")+fg(theme.Accent).Bold(true).Render("↑↓")+fg(theme.FgMoreSubtle).Render(" move · ")+fg(theme.Accent).Bold(true).Render("v/enter")+fg(theme.FgMoreSubtle).Render(" read · ")+fg(theme.Accent).Bold(true).Render("/")+fg(theme.FgMoreSubtle).Render(" search · ")+fg(theme.Accent).Bold(true).Render("g")+fg(theme.FgMoreSubtle).Render(" view · ")+fg(theme.Accent).Bold(true).Render("p")+fg(theme.FgMoreSubtle).Render(" preview · ")+fg(theme.Accent).Bold(true).Render("R")+fg(theme.FgMoreSubtle).Render(" rescan · q quit"), width)
}

func skillAge(value string) string {
	if value == "" {
		return "—"
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "—"
	}
	return formatAgeAt(parsed, time.Now())
}

func formatAgeAt(then time.Time, now time.Time) string {
	duration := now.Sub(then)
	if duration < time.Minute {
		return "now"
	}
	if duration < time.Hour {
		return fmt.Sprintf("%dm", int(duration.Minutes()))
	}
	if duration < 24*time.Hour {
		return fmt.Sprintf("%dh", int(duration.Hours()))
	}
	if duration < 14*24*time.Hour {
		return fmt.Sprintf("%dd", int(duration.Hours()/24))
	}
	return fmt.Sprintf("%dw", int(duration.Hours()/(24*7)))
}

func formatFileSize(size int64) string {
	if size < 1024 {
		return fmt.Sprintf("%dB", size)
	}
	if size < 1024*1024 {
		return fmt.Sprintf("%dK", size/1024)
	}
	return fmt.Sprintf("%.1fM", float64(size)/(1024*1024))
}
