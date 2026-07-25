package ui

import (
	"fmt"
	"os"
	"strings"
	"unicode"

	"ccsspike/data"
	"ccsspike/theme"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func fg(c lipgloss.Color) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(c).Background(theme.BgBase)
}

func (m Model) View() string {
	if m.w < 8 || m.h < 5 {
		return lipgloss.Place(max(1, m.w), max(1, m.h), lipgloss.Center, lipgloss.Center, fit("ccs", max(1, m.w)),
			lipgloss.WithWhitespaceBackground(theme.BgBase))
	}
	if m.mode == ModeSkills {
		out := m.renderSkillsScreen()
		if m.overlay != OverlayNone {
			panel := clipBlock(m.renderOverlay(), m.w, m.h)
			out = lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, panel,
				lipgloss.WithWhitespaceBackground(theme.BgBase))
		}
		return out
	}
	if m.reader != nil {
		content := m.renderTranscriptReader(max(1, m.w-4), max(1, m.h-2))
		return lipgloss.NewStyle().Background(theme.BgBase).Padding(1, 2).Render(content)
	}
	innerW := max(1, m.w-4)
	bodyH := max(1, m.h-7)

	header := m.renderHeader(innerW)
	rule := fg(theme.Sep).Render(strings.Repeat("─", innerW))

	var body string
	switch m.view {
	case ViewTree:
		body = theme.Main.Width(innerW).Height(bodyH).Render(clipHeight(m.renderTree(innerW, bodyH), bodyH))
	default:
		if m.preview && innerW >= 86 {
			listW := innerW * 58 / 100
			prevW := innerW - listW - 3
			list := theme.Main.Width(listW).Height(bodyH).Render(clipHeight(m.renderList(listW, bodyH), bodyH))
			gap := theme.Main.Width(1).Height(bodyH).Render("")
			prevStyle := lipgloss.NewStyle().
				Border(lipgloss.NormalBorder(), false, false, false, true).
				BorderForeground(theme.Sep).BorderBackground(theme.BgBase).
				Background(theme.BgBase).Padding(0, 1, 0, 2)
			preview := prevStyle.Width(prevW).Height(bodyH).Render(clipHeight(m.renderPreview(prevW, bodyH), bodyH))
			body = lipgloss.JoinHorizontal(lipgloss.Top, list, gap, preview)
		} else {
			body = theme.Main.Width(innerW).Height(bodyH).Render(clipHeight(m.renderList(innerW, bodyH), bodyH))
		}
	}

	body = clipHeight(body, bodyH)
	footer := m.renderKeybar(innerW)
	document := lipgloss.JoinVertical(lipgloss.Left, header, rule, body, footer)
	out := lipgloss.NewStyle().Background(theme.BgBase).Padding(1, 2).Render(document)

	if m.confirmation != nil {
		panel := clipBlock(m.renderConfirmation(), m.w, m.h)
		out = lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, panel,
			lipgloss.WithWhitespaceBackground(theme.BgBase))
	} else if m.fleetResults != nil {
		panel := clipBlock(m.renderFleetResults(), m.w, m.h)
		out = lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, panel,
			lipgloss.WithWhitespaceBackground(theme.BgBase))
	} else if m.overlay != OverlayNone {
		panel := clipBlock(m.renderOverlay(), m.w, m.h)
		out = lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, panel,
			lipgloss.WithWhitespaceBackground(theme.BgBase))
	}
	return out
}

// ---- header dashboard ----

func (m Model) renderHeader(width int) string {
	stats := m.snapshot.Stats
	stat := func(value string, label string, color lipgloss.Color) string {
		return fg(color).Bold(true).Render(value) + fg(theme.FgMoreSubtle).Render(" "+label)
	}
	separator := fg(theme.FgMostSubtle).Render("   ")
	brand := fg(theme.Accent).Bold(true).Render("ccs") + fg(theme.FgMoreSubtle).Render(" · "+sanitizePlain(stats.Host))
	left := brand + separator +
		stat(fmt.Sprintf("%d", stats.Sessions), "sessions", theme.FgBase) + separator +
		stat(data.FormatCompactUSD(stats.Spend), "spend", theme.CostColor(stats.Spend)) + separator +
		stat(fmt.Sprintf("%d", stats.Active), "active", theme.Success) + separator +
		stat(fmt.Sprintf("%d", stats.Parked), "parked", theme.Warning)
	viewName := "cluster + state · " + m.options.sort.String()
	if m.view == ViewTree {
		viewName = "causal tree"
	} else if m.view == ViewFlat {
		viewName = "flat · " + m.options.sort.String()
	}
	right := fg(theme.FgMoreSubtle).Render(viewName)
	line1 := joinSides(left, right, width)

	line2 := stat(fmt.Sprintf("%d", stats.Loops), "loops", theme.Accent) +
		fg(theme.FgMoreSubtle).Render(" ("+data.FormatCompactUSD(stats.LoopSpend)+")") + separator +
		stat(data.FormatCompactUSD(stats.AgentSpend), "in subagents", theme.FgBase)
	if stats.TopTitle != "" {
		line2 += separator + fg(theme.FgMoreSubtle).Render("top ") +
			fg(theme.CostColor(stats.TopCost)).Bold(true).Render(data.FormatCompactUSD(stats.TopCost)) +
			fg(theme.FgMoreSubtle).Render(" "+truncate(stats.TopTitle, 34))
	}
	return theme.Main.Width(width).Render(fit(line1, width) + "\n" + fit(line2, width))
}

func joinSides(left string, right string, width int) string {
	if lipgloss.Width(left)+1+lipgloss.Width(right) > width {
		return fit(left, width)
	}
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	return left + fg(theme.BgBase).Render(strings.Repeat(" ", gap)) + right
}

// ---- session list (groups view) ----

func (m Model) renderList(width int, height int) string {
	if len(m.rows) == 0 {
		return fg(theme.FgMoreSubtle).Render("No sessions match the current view options.")
	}
	header := m.renderListHeader(width)
	rowHeight := height
	out := make([]string, 0, height)
	if header != "" {
		out = append(out, header)
		rowHeight = max(1, height-1)
	}
	start, end := m.listWindow(rowHeight)
	for i := start; i < end; i++ {
		candidate := m.rows[i]
		selected := i == m.cursor
		if candidate.header {
			out = append(out, m.renderSection(width, candidate, selected))
		} else {
			out = append(out, m.renderSessionRow(width, m.snapshot.Sessions[candidate.sIdx], candidate.level, selected))
		}
	}
	return strings.Join(out, "\n")
}

func (m Model) renderListHeader(width int) string {
	if width < 28 {
		return ""
	}
	parts := make([]string, 0, 5)
	if width >= 70 {
		parts = append(parts, fg(theme.FgMostSubtle).Render(pad("STAGE", 10)))
	}
	if width >= 48 {
		parts = append(parts, fg(theme.FgMostSubtle).Render(pad("MODEL", 7)))
	}
	if width >= 36 {
		parts = append(parts, fg(theme.FgMostSubtle).Render(lpad("COST", 5)))
	}
	// 66, not 80: with the preview pane open the list only gets ~58% of the
	// terminal, so a 132-wide window leaves this column just 74 to work with.
	if width >= 66 {
		parts = append(parts, fg(theme.FgMostSubtle).Render(lpad("MEM", 4)))
	}
	parts = append(parts, fg(theme.FgMostSubtle).Render(lpad("AGE", 5)))
	if width >= 62 {
		parts = append(parts, fg(theme.FgMostSubtle).Render(lpad("SUB", 4)))
	}
	right := strings.Join(parts, fg(theme.BgBase).Render(" "))
	leftWidth := max(1, width-lipgloss.Width(right)-1)
	left := fg(theme.FgMostSubtle).Render(pad("SESSION", leftWidth))
	return theme.Main.Width(width).Render(fit(left+fg(theme.BgBase).Render(" ")+right, width))
}

func (m Model) listWindow(height int) (int, int) {
	visible := max(1, height)
	start := m.cursor - visible/2
	start = clamp(start, 0, max(0, len(m.rows)-visible))
	return start, min(len(m.rows), start+visible)
}

func (m Model) renderSection(width int, candidate row, selected bool) string {
	rowBackground := theme.BgBase
	if selected {
		rowBackground = theme.BgLow
	}
	tint := func(c lipgloss.Color) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(c).Background(rowBackground)
	}

	label := strings.ToUpper(sanitizePlain(candidate.label))
	indent := strings.Repeat("  ", candidate.level)
	glyph := candidate.glyph
	if glyph != "" {
		glyph += " "
	}
	// Fold marker makes collapsibility discoverable without reading the help.
	folded := m.collapsed[candidate.key]
	marker := "▾ "
	if folded {
		marker = "▸ "
	}
	count := fmt.Sprintf(" (%d)%s", candidate.count, map[bool]string{true: " ⋯ ", false: " "}[folded])

	color := theme.Accent
	if candidate.level > 0 {
		color = theme.FgSubtle
	}
	caret := "  "
	if selected {
		caret = tint(theme.Primary).Bold(true).Render("❯ ")
		color = theme.FgBase
	} else {
		caret = tint(theme.FgMostSubtle).Render(caret)
	}

	markerText := tint(theme.FgMoreSubtle).Render(marker)
	nameText := tint(color).Bold(true).Render(glyph + label)
	countText := tint(theme.FgMoreSubtle).Render(count)
	used := 2 + lipgloss.Width(indent) + lipgloss.Width(marker) + lipgloss.Width(glyph+label) + lipgloss.Width(count)
	ruleLen := max(0, width-used)
	line := caret + tint(theme.FgMostSubtle).Render(indent) + markerText + nameText + countText +
		tint(theme.Sep).Render(strings.Repeat("─", ruleLen))
	return lipgloss.NewStyle().Background(rowBackground).Width(width).Render(fit(line, width))
}

func (m Model) renderSessionRow(width int, session data.Session, level int, selected bool) string {
	rowBackground := theme.BgBase
	if selected {
		rowBackground = theme.BgLow
	}
	backgroundSpace := func(n int) string {
		return lipgloss.NewStyle().Background(rowBackground).Render(strings.Repeat(" ", max(0, n)))
	}
	rowColor := func(color lipgloss.Color) lipgloss.Color {
		if session.State == "archived" && !selected {
			return theme.FgMostSubtle
		}
		return color
	}
	column := func(color lipgloss.Color) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(rowColor(color)).Background(rowBackground)
	}

	caret := column(theme.Accent).Render(" ")
	if selected {
		caret = column(theme.Primary).Bold(true).Render("❯")
	}
	dotGlyph := "●"
	if session.State == "archived" {
		dotGlyph = "·"
	}
	dot := column(theme.StateColor(session.State)).Render(dotGlyph)

	var rightParts []string
	if width >= 70 {
		stage := stageLabel(session.Stage)
		if stage == "" {
			stage = "—"
		}
		rightParts = append(rightParts, column(theme.StageColor(session.Stage)).Render(pad(stage, 10)))
	}
	if width >= 48 {
		badge := theme.Model(session.Model)
		rightParts = append(rightParts, column(badge.Color).Render(pad(badge.Label, 7)))
	}
	if width >= 36 {
		rightParts = append(rightParts, column(theme.CostColor(session.TotalCost)).Render(lpad(data.FormatCostList(session.TotalCost), 5)))
	}
	// Live memory sits next to spend: both answer "what is this costing me", one
	// in dollars already burned and one in RAM held right now. Sessions with no
	// running process render blank rather than "0", so the column reads as an
	// attribute of live sessions instead of a claim about dead ones.
	// 66, not 80: with the preview pane open the list only gets ~58% of the
	// terminal, so a 132-wide window leaves this column just 74 to work with.
	if width >= 66 {
		if stat, live := m.procStatFor(session); live {
			rightParts = append(rightParts, column(theme.FootprintColor(stat.Footprint)).Render(lpad(data.FormatFootprint(stat.Footprint), 4)))
		} else {
			rightParts = append(rightParts, backgroundSpace(4))
		}
	}
	age := data.FormatAge(session.LastAt, m.snapshot.LoadedAt)
	if width >= 28 {
		rightParts = append(rightParts, column(theme.AgeColor(data.IsRecentAge(age))).Render(lpad(age, 5)))
	}
	if width >= 62 {
		if session.Subagents > 0 {
			rightParts = append(rightParts, column(theme.FgMoreSubtle).Render(lpad(fmt.Sprintf("▸%d", session.Subagents), 4)))
		} else {
			rightParts = append(rightParts, backgroundSpace(4))
		}
	}
	right := strings.Join(rightParts, backgroundSpace(1))
	rightWidth := lipgloss.Width(right)

	inline := ""
	if session.PRNumber > 0 && width >= 64 {
		inline += backgroundSpace(1) + column(prColor(session.PRState)).Render(fmt.Sprintf("#%d", session.PRNumber))
	}
	if session.Class != "" && session.Class != "UNCLASSIFIED" {
		inline += backgroundSpace(1) + column(theme.ClassColor(session.Class)).Render(session.Class)
	}
	if session.Role != "" {
		inline += backgroundSpace(1) + column(theme.Info).Render("◆ "+sanitizePlain(session.Role))
	}
	inlineWidth := lipgloss.Width(inline)
	indent := strings.Repeat("  ", level)
	available := width - 5 - lipgloss.Width(indent) - rightWidth
	if available-inlineWidth < 8 {
		inline = ""
		inlineWidth = 0
	}
	titleWidth := max(1, available-inlineWidth)
	titleColor := theme.FgSubtle
	if selected {
		titleColor = theme.FgBase
	}
	title := column(titleColor).Bold(selected).Render(pad(cleanTitle(session.Title), titleWidth))

	line := caret + backgroundSpace(1) + backgroundSpace(lipgloss.Width(indent)) + dot + backgroundSpace(1) + title + inline
	if right != "" {
		line += backgroundSpace(1) + right
	}
	return lipgloss.NewStyle().Background(rowBackground).Width(width).Render(fit(line, width))
}

// ---- preview dossier ----

// cleanTitle strips leading decorative markers (*, ·, •) and whitespace some
// session titles carry, so the list reads cleanly.
func cleanTitle(title string) string {
	return strings.TrimLeft(title, " \t*·•")
}

// renderSectionCard fills the detail pane when the cursor sits on a section
// header, so focusing a divider shows something useful (count, spend, state)
// instead of an empty panel.
func (m Model) renderSectionCard(contentWidth int, header row) string {
	folded := m.collapsed[header.key]
	var spend float64
	var active int
	for _, candidate := range m.rows {
		if candidate.header {
			continue
		}
		session := m.snapshot.Sessions[candidate.sIdx]
		if !strings.HasPrefix(sectionKeyFor(session), header.key) {
			continue
		}
		spend += session.TotalCost
		if session.State == "active" {
			active++
		}
	}
	state := "expanded"
	if folded {
		state = "collapsed"
	}
	lines := []string{
		fg(theme.FgBase).Bold(true).Render(truncate(strings.ToUpper(sanitizePlain(header.label)), contentWidth)),
		fg(theme.FgMoreSubtle).Render(fmt.Sprintf("section · %s", state)),
		fg(theme.Sep).Render(strings.Repeat("─", contentWidth)),
		"",
		fg(theme.FgMostSubtle).Render(pad("sessions", 10)) + fg(theme.FgBase).Render(fmt.Sprintf("%d", header.count)),
	}
	if !folded {
		lines = append(lines,
			fg(theme.FgMostSubtle).Render(pad("active", 10))+fg(theme.Success).Render(fmt.Sprintf("%d", active)),
			fg(theme.FgMostSubtle).Render(pad("spend", 10))+fg(theme.CostColor(spend)).Render(nonEmpty(data.FormatCost(spend), "$0")),
		)
	}
	lines = append(lines, "", fg(theme.FgMostSubtle).Render("enter / space  fold ⇄ unfold"))
	return strings.Join(lines, "\n")
}

// sectionKeyFor derives the section a session belongs to, matching the keys
// buildDefaultRows emits.
func sectionKeyFor(session data.Session) string {
	if session.Cluster != "" {
		return "cluster:" + session.Cluster
	}
	state := session.State
	if state == "completed" {
		state = "done"
	}
	return "no-system:" + state
}

// previewContentWidth is the usable text width inside the preview pane. The pane
// has left-2/right-1 padding, so any line laid out wider than this overflows and
// wraps onto a second line.
func previewContentWidth(paneWidth int) int {
	return max(4, paneWidth-3)
}

// previewPaneWidth derives the preview pane width from the terminal width, using
// the same split as View(), so off-screen callers (scroll math) agree with it.
func (m Model) previewPaneWidth() int {
	innerW := m.w - 4
	listW := innerW * 58 / 100
	return innerW - listW - 3
}

func (m Model) renderPreview(width int, height int) string {
	session, ok := m.selectedSession()
	if !ok {
		if header, isHeader := m.selectedHeader(); isHeader {
			return m.renderSectionCard(previewContentWidth(width), header)
		}
		return fg(theme.FgMoreSubtle).Render("no session selected")
	}
	contentWidth := previewContentWidth(width)
	classification := previewClass(session)
	badgeLine := theme.Pill(session.State, theme.StateColor(session.State)) + "  " + classChip(classification)
	if session.Stage != "" {
		badgeLine += "  " + theme.Pill(stageLabel(session.Stage), theme.StageColor(session.Stage))
	}
	if session.PRNumber > 0 {
		badgeLine += "  " + fg(prColor(session.PRState)).Render(fmt.Sprintf("#%d", session.PRNumber))
	}
	lines := []string{
		fg(theme.FgBase).Bold(true).Render(truncate(cleanTitle(session.Title), contentWidth)),
		fg(theme.FgMoreSubtle).Render(truncate(session.Project+" · "+session.Duration+" active", contentWidth)),
		fit(badgeLine, contentWidth),
		fg(theme.Sep).Render(strings.Repeat("─", contentWidth)),
	}
	// Enrichment leads: it is the stored answer to "what is this and what do I do with it", and
	// it is what the panel is for. Everything below is supporting detail.
	lines = append(lines, renderEnrichment(session, contentWidth)...)
	// A live `s` summary sits underneath rather than replacing it — it is generated on demand and
	// lost on quit, so it can only ever be a second opinion on the durable one.
	if summary := m.summaries[session.ID]; summary != "" {
		lines = append(lines, "", sect("Live summary"))
		for _, wrapped := range wrapWords(summary, contentWidth) {
			lines = append(lines, fg(theme.FgSubtle).Render(wrapped))
		}
	}
	lines = append(lines,
		"",
		sect("Cost"),
		fg(theme.CostColor(session.TotalCost)).Bold(true).Render(nonEmpty(data.FormatCost(session.SelfCost), "$0"))+
			fg(theme.FgMoreSubtle).Render(" self · "+nonEmpty(data.FormatCost(session.TotalCost), "$0")+" total"),
	)
	if session.ProviderCost.Claude > 0 {
		lines = append(lines, costBar(contentWidth, "Claude", session.ProviderCost.Claude, session.TotalCost, theme.Model("claude-opus-4-8").Color))
	}
	if session.ProviderCost.GPT > 0 {
		lines = append(lines, costBar(contentWidth, "GPT   ", session.ProviderCost.GPT, session.TotalCost, theme.Model("gpt-5.6-sol").Color))
	}
	if session.ProviderCost.Other > 0 {
		lines = append(lines, costBar(contentWidth, "Other ", session.ProviderCost.Other, session.TotalCost, theme.FgMostSubtle))
	}
	lines = append(lines, m.renderProcessSection(session, contentWidth)...)
	lines = append(lines, "", sect("Model"))
	badge := theme.Model(session.Model)
	if session.Model == "" {
		lines = append(lines, fg(theme.FgMostSubtle).Render("· unpriced"))
	} else {
		lines = append(lines, fg(badge.Color).Render("● "+badge.Label)+fg(theme.FgMoreSubtle).Render("  "+truncate(session.Model, max(1, contentWidth-len(badge.Label)-4))))
	}
	if session.TasksTotal > 0 {
		lines = append(lines, "", sect(fmt.Sprintf("Tasks · %d/%d", session.TasksDone, session.TasksTotal)))
		for index, subject := range session.TaskSubjects {
			if index == 3 {
				lines = append(lines, fg(theme.FgMostSubtle).Render(fmt.Sprintf("  … %d more", len(session.TaskSubjects)-index)))
				break
			}
			lines = append(lines, fg(theme.FgMoreSubtle).Render("· ")+fg(theme.FgSubtle).Render(truncate(subject, max(1, contentWidth-2))))
		}
	}
	lines = append(lines, "", sect("Meta"))
	metadata := [][2]string{
		{"cwd", compactHome(session.CWD)},
		{"duration", session.Duration + " wall"},
		{"subagents", fmt.Sprintf("%d runs", session.Subagents)},
		{"class", nonEmpty(classification, "—")},
		{"cluster", nonEmpty(session.Cluster, "—")},
		{"stage", nonEmpty(session.Stage, "—")},
		{"PR", prReference(session)},
		{"last", lastActivity(data.FormatAge(session.LastAt, m.snapshot.LoadedAt))},
	}
	for _, pair := range metadata {
		if value := strings.TrimSpace(pair[1]); value == "" || value == "—" {
			continue // hide fields that don't apply to this session (class, cluster, stage, PR)
		}
		lines = append(lines, fg(theme.FgMostSubtle).Render(pad(pair[0], 10))+fg(theme.FgSubtle).Render(truncate(pair[1], max(1, contentWidth-11))))
	}
	// The peek was the old answer to "what is this session" and it was a poor one — a scrolling
	// window of recent turns you had to read to learn anything. Where an enrichment exists it has
	// already answered that question above, so the peek is retired to `v` rather than competing
	// for the same space. It stays as the fallback for sessions the sweep has not reached, which
	// would otherwise show a dossier with nothing in it.
	if session.Enrichment.Present() {
		lines = append(lines, "", fg(theme.FgMostSubtle).Render("v  full transcript"))
		return strings.Join(lines, "\n")
	}
	lines = append(lines, "", sect("Transcript")+fg(theme.FgMostSubtle).Render("  J/K peek · v full"))
	remaining := max(1, height-len(lines))
	if errText := m.transcriptErrs[session.ID]; errText != "" {
		lines = append(lines, fg(theme.Warning).Render(truncate(errText, contentWidth)))
	} else if document, loaded := m.transcripts[session.ID]; loaded {
		peek := renderPeekRows(meaningfulLines(document.Lines), contentWidth)
		start := m.peekScroll
		if m.peekSession != session.ID {
			start = max(0, len(peek)-remaining)
		}
		start = clamp(start, 0, max(0, len(peek)-1))
		end := min(len(peek), start+remaining)
		lines = append(lines, peek[start:end]...)
	} else {
		lines = append(lines, fg(theme.FgMostSubtle).Render("loading recent transcript…"))
	}
	return strings.Join(lines, "\n")
}

// renderProcessSection reports what the session currently costs the machine.
// It returns nothing for a session with no running process, so the dossier does
// not carry an empty panel for the majority of rows, which are history.
//
// The heaviest-process line is the payload. A session's own Claude process is
// unremarkable at a few hundred MB; the memory that shows up in Activity Monitor
// as an anonymous `ugrep` or `node` belongs to a tool subprocess, and nothing
// outside this view connects the two.
func (m Model) renderProcessSection(session data.Session, contentWidth int) []string {
	stat, live := m.procStatFor(session)
	if !live {
		return nil
	}
	headline := fg(theme.FootprintColor(stat.Footprint)).Bold(true).Render(data.FormatFootprint(stat.Footprint)) +
		fg(theme.FgMoreSubtle).Render(" now · "+data.FormatFootprint(stat.Peak)+" peak")
	processes := "1 process"
	if stat.ProcessCount != 1 {
		processes = fmt.Sprintf("%d processes", stat.ProcessCount)
	}
	lines := []string{
		"",
		sect("Live process"),
		fit(headline, contentWidth),
		fg(theme.FgMostSubtle).Render(fmt.Sprintf("pid %d · %s", stat.RootPID, processes)),
	}
	// Only name the heaviest process when it is not the Claude process itself —
	// "claude is using claude's memory" is noise, a runaway child is the signal.
	if !stat.HeaviestIsRoot && stat.HeaviestName != "" {
		label := truncate(stat.HeaviestName, max(1, contentWidth-16))
		lines = append(lines, fg(theme.FgMostSubtle).Render(pad("heaviest", 10))+
			fg(theme.FgSubtle).Render(label)+
			fg(theme.FootprintColor(stat.HeaviestFootprint)).Render(" "+data.FormatFootprint(stat.HeaviestFootprint)))
	}
	return lines
}

func costBar(width int, label string, value float64, total float64, color lipgloss.Color) string {
	barWidth := max(6, width-16)
	filled := 0
	if total > 0 {
		filled = clamp(int(value/total*float64(barWidth)), 0, barWidth)
	}
	bar := fg(color).Render(strings.Repeat("█", filled)) + fg(theme.BgHigh).Render(strings.Repeat("░", barWidth-filled))
	amount := nonEmpty(data.FormatCost(value), "$0")
	return fg(theme.FgMoreSubtle).Render(pad(label, 7)) + bar + fg(theme.FgMostSubtle).Render(" "+amount)
}

func compactHome(path string) string {
	if path == "" {
		return "—"
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		if path == home {
			return "~"
		}
		if strings.HasPrefix(path, home+string(os.PathSeparator)) {
			return "~/" + strings.TrimPrefix(path, home+string(os.PathSeparator))
		}
	}
	return path
}

func prReference(session data.Session) string {
	if session.PRNumber <= 0 {
		return "—"
	}
	if session.PRState == "" {
		return fmt.Sprintf("#%d", session.PRNumber)
	}
	return fmt.Sprintf("#%d · %s", session.PRNumber, session.PRState)
}

func lastActivity(age string) string {
	switch age {
	case "now":
		return "now"
	case "?":
		return "—"
	default:
		return age + " ago"
	}
}

// ---- tree view ----

func (m Model) renderTree(width int, height int) string {
	heading := sect("Causal tree") + fg(theme.FgMoreSubtle).Render("   self · total · per-vendor rollup")
	if len(m.snapshot.Tree) == 0 {
		return fit(heading, width) + "\n\n" + fg(theme.FgMoreSubtle).Render("No causal session edges yet.")
	}
	start, end := m.treeWindow(height)
	lines := []string{fit(heading, width), ""}
	for i := start; i < end; i++ {
		node := m.snapshot.Tree[i]
		selected := i == m.treeCursor
		indent := strings.Repeat("  ", node.Depth)
		branch := ""
		if node.Depth > 0 {
			branch = fg(theme.FgMostSubtle).Render("└ ")
		}
		idText := sanitizePlain(node.ID)
		id := fg(theme.FgMostSubtle).Render(idText)
		role := ""
		if node.Role != "" {
			role = fg(theme.Info).Render(" ◆ " + sanitizePlain(node.Role))
		}
		plainPrefixWidth := lipgloss.Width(indent) + lipgloss.Width(branch) + lipgloss.Width(idText) + 1 + lipgloss.Width(role)
		title := fg(theme.FgBase).Render(truncate(cleanTitle(node.Title), max(1, width-plainPrefixWidth)))
		head := indent + branch + id + " " + title + role
		if selected {
			head = lipgloss.NewStyle().Background(theme.BgLow).Width(width).Render(fit(head, width))
		} else {
			head = fit(head, width)
		}

		costs := []string{
			fg(theme.FgMoreSubtle).Render(nonEmpty(data.FormatCost(node.SelfCost), "$0") + " self"),
			fg(theme.CostColor(node.TotalCost)).Bold(true).Render(nonEmpty(data.FormatCost(node.TotalCost), "$0") + " total"),
		}
		if node.Providers.Claude > 0 {
			costs = append(costs, fg(theme.Model("claude-opus-4-8").Color).Render("Claude "+data.FormatCost(node.Providers.Claude)))
		}
		if node.Providers.GPT > 0 {
			costs = append(costs, fg(theme.Model("gpt-5.6-sol").Color).Render("GPT "+data.FormatCost(node.Providers.GPT)))
		}
		if node.Providers.Other > 0 {
			costs = append(costs, fg(theme.FgMostSubtle).Render("other "+data.FormatCost(node.Providers.Other)))
		}
		costLine := indent + "  " + strings.Join(costs, fg(theme.FgMostSubtle).Render(" · "))
		lines = append(lines, head, fit(costLine, width), "")
	}
	return strings.Join(lines, "\n")
}

func (m Model) treeWindow(height int) (int, int) {
	visibleNodes := max(1, (height-2)/3)
	start := m.treeCursor - visibleNodes/2
	start = clamp(start, 0, max(0, len(m.snapshot.Tree)-visibleNodes))
	return start, min(len(m.snapshot.Tree), start+visibleNodes)
}

// ---- overlays ----

func (m Model) renderOverlay() string {
	switch m.overlay {
	case OverlayRoute:
		return m.renderRoutePicker()
	case OverlayHelp:
		return m.renderHelp()
	case OverlayViewOptions:
		return m.renderViewOptions()
	default:
		return ""
	}
}

func (m Model) renderRoutePicker() string {
	session, _ := m.selectedSession()
	panelWidth := min(72, max(8, m.w-2))
	contentWidth := max(1, panelWidth-8)
	lines := []string{
		fit(fg(theme.Keyword).Bold(true).Render("Resume via…"), contentWidth),
		fg(theme.FgMoreSubtle).Render(truncate(cleanTitle(session.Title), contentWidth)),
	}
	// The model history is the whole basis of the preselection, so show it: it is
	// the one fact that makes an informed harness override possible.
	if len(session.Models) > 0 {
		lines = append(lines, fg(theme.FgMostSubtle).Render(truncate("history · "+strings.Join(session.Models, ", "), contentWidth)))
	}
	lines = append(lines, "")
	if m.routeLoading {
		lines = append(lines, fit(fg(theme.FgMoreSubtle).Render("loading real routes…"), contentWidth))
	} else if m.routeError != "" {
		lines = append(lines,
			fit(fg(theme.Warning).Render("routes unavailable"), contentWidth),
			fg(theme.FgMostSubtle).Render(truncate(m.routeError, contentWidth)),
		)
	} else {
		for i, launcher := range m.routes {
			selected := i == m.routeCursor
			bar := fg(theme.BgBase).Render("  ")
			nameColor := theme.FgSubtle
			if selected {
				bar = fg(theme.Primary).Bold(true).Render("❯ ")
				nameColor = theme.FgBase
			}
			// ✓ this harness serves the whole history · ~ a cross-harness resume,
			// which is allowed · ✗ the target itself is unavailable.
			mark := fg(theme.Success).Render("✓")
			if !launcher.Serves {
				mark = fg(theme.Accent).Render("~")
			}
			if !launcher.Eligible {
				mark = fg(theme.FgMostSubtle).Render("✗")
				nameColor = theme.FgMostSubtle
			}
			name := lipgloss.NewStyle().Foreground(nameColor).Background(theme.BgBase).Bold(selected).Render(pad(launcher.Name, 14))
			target := fg(theme.FgMoreSubtle).Render(pad(launcher.Target, 8))
			backend := fg(theme.FgMoreSubtle).Render(pad(launcher.Backend, 16))
			lines = append(lines, fit(bar+mark+" "+name+target+backend, contentWidth))
			lines = append(lines, fit(fg(theme.FgMostSubtle).Render("     "+truncate(launcher.Reason, max(1, contentWidth-5))), contentWidth))
		}
	}
	lines = append(lines,
		"",
		fit(fg(theme.FgMostSubtle).Render("j/k any harness · enter resume · esc cancel"), contentWidth),
		fit(fg(theme.FgMostSubtle).Render("~ crosses harnesses; no force flag needed"), contentWidth))
	lines = clipPanelLines(lines, max(1, m.h-4))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Primary).
		Background(theme.BgBase).Padding(1, 3).Width(panelWidth).Render(strings.Join(lines, "\n"))
}

func (m Model) renderHelp() string {
	groups := [][2]string{
		{"↑↓ / j k", "move selection"},
		{"enter", "resume inline on the origin backend"},
		{"r", "choose any harness × inline / cmux"},
		{"v", "read the full transcript"},
		{"J / K", "scroll the dossier transcript peek"},
		{"p", "show / hide preview pane"},
		{"g", "cycle default / tree / flat"},
		{"→ / l", "expand section (on a header)"},
		{"← / h", "collapse section"},
		{"space", "fold ⇄ unfold the section"},
		{"o", "view options, filters, sort, autorefresh"},
		{"/", "fuzzy title / project / task search"},
		{"t / C / e / X", "retitle / done / archive toggle via ccs"},
		{"E", "AI edit one session; review mutations"},
		{"S", "summarize selected transcript"},
		{"A", "ask across transcript excerpts"},
		{"D", "AI cleanup proposal; approve checked set"},
		{"Tab", "toggle session manager / Skills registry"},
		{"?", "this help · q quit"},
	}
	panelWidth := min(62, max(8, m.w-2))
	contentWidth := max(1, panelWidth-8)
	lines := []string{fit(fg(theme.Keyword).Bold(true).Render("Sessions — keys"), contentWidth), ""}
	for _, group := range groups {
		line := fg(theme.Accent).Bold(true).Render(pad(group[0], 16)) + fg(theme.FgSubtle).Render(group[1])
		lines = append(lines, fit(line, contentWidth))
	}
	lines = clipPanelLines(lines, max(1, m.h-4))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Accent).
		Background(theme.BgBase).Padding(1, 3).Width(panelWidth).Render(strings.Join(lines, "\n"))
}

// ---- footer ----

func (m Model) renderKeybar(width int) string {
	if m.input != nil {
		return fit(fg(theme.Accent).Bold(true).Render(m.input.label+" › ")+fg(theme.FgBase).Render(m.input.buffer)+fg(theme.FgMostSubtle).Render("  enter apply · esc cancel"), width)
	}
	if m.searching {
		return fit(fg(theme.Accent).Bold(true).Render("/ ")+fg(theme.FgBase).Render(m.query)+fg(theme.FgMostSubtle).Render("  title · project · task"), width)
	}
	if m.status != "" {
		return fit(fg(theme.Warning).Bold(true).Render("status")+fg(theme.FgMoreSubtle).Render(" · "+m.status), width)
	}
	viewLabel := "default"
	if m.view == ViewTree {
		viewLabel = "tree"
	} else if m.view == ViewFlat {
		viewLabel = "flat"
	}
	items := [][2]string{
		{"Tab", "skills"}, {"↑↓", "move"}, {"enter", "resume"}, {"r", "harness…"}, {"v", "transcript"},
		{"/", "search"}, {"g", "view:" + viewLabel}, {"←→", "fold"}, {"o", "options"}, {"R", "refresh"},
		{"e", "archive/unarchive"}, {"t", "retitle"}, {"C", "done"}, {"E", "edit"},
		{"S/A/D", "AI"}, {"?", "help"}, {"q", "quit"},
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, fg(theme.Accent).Bold(true).Render(item[0])+fg(theme.FgMoreSubtle).Render(" "+item[1]))
	}
	return theme.Main.Width(width).Render(fit(strings.Join(parts, fg(theme.FgMostSubtle).Render(" · ")), width))
}

// ---- helpers ----

func sect(label string) string {
	return fg(theme.Keyword).Bold(true).Render(label)
}

func previewClass(session data.Session) string {
	if session.IsLoop {
		return "LOOP"
	}
	if session.SessionClass != "" {
		return session.SessionClass
	}
	return session.Class
}

func stageLabel(stage string) string {
	switch stage {
	case "milad-review":
		return "milad-rev"
	default:
		return stage
	}
}

func prColor(state string) lipgloss.Color {
	switch state {
	case "merged":
		return theme.Success
	case "closed":
		return theme.FgMostSubtle
	default:
		return theme.Accent
	}
}

func classChip(class string) string {
	switch class {
	case "":
		return fg(theme.FgMostSubtle).Render("—")
	case "work_body":
		return fg(theme.FgMoreSubtle).Render(class)
	case "auxiliary":
		return fg(theme.Accent).Render(class)
	default:
		return fg(theme.ClassColor(class)).Render(class)
	}
}

func nonEmpty(value string, alternative string) string {
	if value == "" {
		return alternative
	}
	return value
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(sanitizePlain(value), width, "…")
}

func sanitizePlain(value string) string {
	value = ansi.Strip(value)
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}

func fit(value string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(value, width, "")
}

func clipHeight(value string, height int) string {
	if height <= 0 {
		return ""
	}
	lines := strings.Split(value, "\n")
	if len(lines) > height {
		lines = lines[:height]
	}
	return strings.Join(lines, "\n")
}

func clipBlock(value string, width int, height int) string {
	lines := strings.Split(clipHeight(value, height), "\n")
	for i, line := range lines {
		lines[i] = fit(line, width)
	}
	return strings.Join(lines, "\n")
}

func clipPanelLines(lines []string, height int) []string {
	if height <= 0 {
		return nil
	}
	if len(lines) <= height {
		return lines
	}
	if height == 1 {
		return []string{fg(theme.FgMostSubtle).Render("…")}
	}
	clipped := append([]string(nil), lines[:height-1]...)
	clipped = append(clipped, fg(theme.FgMostSubtle).Render("…"))
	return clipped
}

func pad(value string, width int) string {
	value = truncate(value, width)
	for lipgloss.Width(value) < width {
		value += " "
	}
	return value
}

func lpad(value string, width int) string {
	value = truncate(value, width)
	for lipgloss.Width(value) < width {
		value = " " + value
	}
	return value
}
