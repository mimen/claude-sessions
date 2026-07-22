package ui

import (
	"fmt"
	"strings"

	"ccsspike/data"
	"ccsspike/theme"

	"github.com/charmbracelet/lipgloss"
)

func fg(c lipgloss.Color) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(c).Background(theme.BgBase)
}

func (m Model) View() string {
	innerW := m.w - 4
	bodyH := m.h - 7

	header := m.renderHeader(innerW)
	rule := fg(theme.Sep).Render(strings.Repeat("─", innerW))

	var body string
	switch m.view {
	case ViewTree:
		body = theme.Main.Width(innerW).Height(bodyH).Render(m.renderTree(innerW, bodyH))
	default:
		if m.preview {
			listW := innerW*58/100
			prevW := innerW - listW - 3
			list := theme.Main.Width(listW).Height(bodyH).Render(m.renderList(listW, bodyH))
			gap := theme.Main.Width(1).Height(bodyH).Render("")
			prevStyle := lipgloss.NewStyle().
				Border(lipgloss.NormalBorder(), false, false, false, true).
				BorderForeground(theme.Sep).BorderBackground(theme.BgBase).
				Background(theme.BgBase).Padding(0, 1, 0, 2)
			prev := prevStyle.Width(prevW).Height(bodyH).Render(m.renderPreview(prevW))
			body = lipgloss.JoinHorizontal(lipgloss.Top, list, gap, prev)
		} else {
			body = theme.Main.Width(innerW).Height(bodyH).Render(m.renderList(innerW, bodyH))
		}
	}

	footer := m.renderKeybar(innerW)
	doc := lipgloss.JoinVertical(lipgloss.Left, header, rule, body, footer)
	out := lipgloss.NewStyle().Background(theme.BgBase).Padding(1, 2).Render(doc)

	if m.overlay != OverlayNone {
		panel := m.renderOverlay()
		out = lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, panel,
			lipgloss.WithWhitespaceBackground(theme.BgBase))
	}
	return out
}

// ---- header dashboard ----

func (m Model) renderHeader(w int) string {
	s := data.Stats
	stat := func(v, label string, c lipgloss.Color) string {
		return fg(c).Bold(true).Render(v) + fg(theme.FgMoreSubtle).Render(" "+label)
	}
	sep := fg(theme.FgMostSubtle).Render("   ")
	brand := fg(theme.Accent).Bold(true).Render("ccs") + fg(theme.FgMoreSubtle).Render(" · "+s.Host)
	line1 := brand + sep +
		stat(fmt.Sprintf("%d", s.Sessions), "sessions", theme.FgBase) + sep +
		stat(s.Spend, "spend", theme.CostColor(2900)) + sep +
		stat(fmt.Sprintf("%d", s.Active), "active", theme.Success) + sep +
		stat(fmt.Sprintf("%d", s.Parked), "parked", theme.Warning)
	right := fg(theme.FgMoreSubtle).Render("sort · recency")
	gap1 := max(1, w-lipgloss.Width(line1)-lipgloss.Width(right))
	line1 = line1 + fg(theme.BgBase).Render(strings.Repeat(" ", gap1)) + right

	line2 := stat(fmt.Sprintf("%d", s.Loops), "loops", theme.Accent) +
		fg(theme.FgMoreSubtle).Render(" ("+s.LoopSpend+")") + sep +
		stat(s.AgentSpend, "in subagents", theme.FgBase) + sep +
		fg(theme.FgMoreSubtle).Render("top ") + fg(theme.CostColor(761)).Bold(true).Render(s.TopCost) +
		fg(theme.FgMoreSubtle).Render(" "+truncate(s.TopTitle, 34))
	return theme.Main.Width(w).Render(line1 + "\n" + line2)
}

// ---- session list (groups view) ----

func (m Model) renderList(w, h int) string {
	var out []string
	for i, r := range m.rows {
		sel := i == m.cursor
		if r.header {
			out = append(out, m.renderSection(w, r, sel))
		} else {
			out = append(out, m.renderSessionRow(w, data.Sessions[r.sIdx], sel))
		}
	}
	return strings.Join(out, "\n")
}

func (m Model) renderSection(w int, r row, sel bool) string {
	proj := strings.ToUpper(r.project)
	countStr := fmt.Sprintf(" (%d) ", r.count)
	name := fg(theme.Accent).Bold(true).Render(proj)
	count := fg(theme.FgMoreSubtle).Render(countStr)
	used := 2 + lipgloss.Width(proj) + lipgloss.Width(countStr)
	ruleLen := max(1, w-used)
	line := fg(theme.FgMostSubtle).Render("  ") + name + count + fg(theme.Sep).Render(strings.Repeat("─", ruleLen))
	return theme.Main.Width(w).Render(line)
}

func (m Model) renderSessionRow(w int, s data.Session, sel bool) string {
	rowBg := theme.BgBase
	if sel {
		rowBg = theme.BgLow
	}
	bgSp := func(n int) string { return lipgloss.NewStyle().Background(rowBg).Render(strings.Repeat(" ", n)) }
	col := func(c lipgloss.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(c).Background(rowBg) }

	caret := col(theme.Accent).Render(" ")
	if sel {
		caret = col(theme.Primary).Bold(true).Render("❯")
	}
	dot := col(theme.StateColor(s.State)).Render("●")

	// right cluster (fixed): model · cost · age · sub
	mb := theme.Model(s.Model)
	modelCell := col(mb.Color).Render(pad(mb.Label, 7))
	costCell := col(theme.CostColor(s.Cost)).Render(lpad(s.CostLabel, 5))
	ageCell := col(theme.AgeColor(s.Recent)).Render(lpad(s.Age, 5))
	sub := ""
	if s.Subagents > 0 {
		sub = col(theme.FgMoreSubtle).Render(lpad(fmt.Sprintf("▸%d", s.Subagents), 4))
	} else {
		sub = bgSp(4)
	}
	right := modelCell + bgSp(1) + costCell + bgSp(1) + ageCell + bgSp(1) + sub
	rightW := lipgloss.Width(right)

	// inline badges after title
	var inline string
	if s.Class != "" && s.Class != "UNCLASSIFIED" {
		inline += bgSp(1) + col(theme.ClassColor(s.Class)).Render(s.Class)
	}
	if s.Role != "" {
		inline += bgSp(1) + col(theme.Info).Render("◆ "+s.Role)
	}
	inlineW := lipgloss.Width(inline)

	titleColor := theme.FgSubtle
	if sel {
		titleColor = theme.FgBase
	}
	titleW := max(6, w-3-rightW-inlineW-2)
	title := col(titleColor).Bold(sel).Render(pad(s.Title, titleW))

	line := caret + bgSp(1) + dot + bgSp(1) + title + inline + bgSp(1) + right
	return lipgloss.NewStyle().Background(rowBg).Width(w).Render(line)
}

// ---- preview dossier ----

func (m Model) renderPreview(w int) string {
	s, ok := m.selectedSession()
	if !ok {
		return fg(theme.FgMoreSubtle).Render("no session selected")
	}
	var b []string
	b = append(b, fg(theme.FgBase).Bold(true).Render(truncate(s.Title, w-2)))
	b = append(b, fg(theme.FgMoreSubtle).Render(s.Project+" · "+s.Duration+" active"))
	b = append(b, theme.Pill(s.State, theme.StateColor(s.State))+"  "+classChip(s.Class))
	b = append(b, fg(theme.Sep).Render(strings.Repeat("─", w-2)))

	// cost block
	claude := s.Cost * 0.62
	gpt := s.Cost * 0.38
	b = append(b, sect("Cost"))
	b = append(b, fg(theme.CostColor(s.Cost)).Bold(true).Render(s.CostLabel)+
		fg(theme.FgMoreSubtle).Render(" self · "+s.CostLabel+" total"))
	b = append(b, costBar(w-2, "Claude", claude, s.Cost, theme.Model("claude-opus-4-8").Color))
	b = append(b, costBar(w-2, "GPT   ", gpt, s.Cost, theme.Model("gpt-5.6-sol").Color))
	b = append(b, "")

	// model
	mb := theme.Model(s.Model)
	b = append(b, sect("Model"))
	b = append(b, fg(mb.Color).Render("● "+mb.Label)+fg(theme.FgMoreSubtle).Render("  "+s.Model))
	b = append(b, "")

	// meta
	b = append(b, sect("Meta"))
	meta := [][2]string{
		{"cwd", "~/…/" + s.Project},
		{"duration", s.Duration + " wall"},
		{"subagents", fmt.Sprintf("%d runs", s.Subagents)},
		{"class", nonEmpty(s.Class, "—")},
		{"cluster", nonEmpty(s.Cluster, "—")},
		{"last", s.Age + " ago"},
	}
	for _, kv := range meta {
		b = append(b, fg(theme.FgMostSubtle).Render(pad(kv[0], 10))+fg(theme.FgSubtle).Render(truncate(kv[1], w-13)))
	}
	return strings.Join(b, "\n")
}

func costBar(w int, label string, val, total float64, c lipgloss.Color) string {
	barW := max(6, w-16)
	filled := 0
	if total > 0 {
		filled = int(val / total * float64(barW))
	}
	bar := fg(c).Render(strings.Repeat("█", filled)) + fg(theme.BgHigh).Render(strings.Repeat("░", barW-filled))
	return fg(theme.FgMoreSubtle).Render(pad(label, 7)) + bar + fg(theme.FgMostSubtle).Render(fmt.Sprintf(" $%.0f", val))
}

// ---- tree view ----

func (m Model) renderTree(w, h int) string {
	var b []string
	b = append(b, sect("Causal tree")+fg(theme.FgMoreSubtle).Render("   self · total · per-vendor rollup"), "")
	for i, n := range data.Tree {
		sel := i+1 == m.cursor%len(data.Tree)
		indent := strings.Repeat("  ", n.Depth)
		branch := ""
		if n.Depth > 0 {
			branch = fg(theme.FgMostSubtle).Render("└ ")
		}
		id := fg(theme.FgMostSubtle).Render(n.ID)
		title := fg(theme.FgBase).Render(truncate(n.Title, 44))
		role := ""
		if n.Role != "" {
			role = fg(theme.Info).Render(" ◆ " + n.Role)
		}
		head := indent + branch + id + " " + title + role

		// cost line
		var costs []string
		costs = append(costs, fg(theme.FgMoreSubtle).Render(n.Self+" self"))
		costs = append(costs, fg(theme.CostColor(parseUSD(n.Total))).Bold(true).Render(n.Total+" total"))
		if n.Claude != "" {
			costs = append(costs, fg(theme.Model("claude-opus-4-8").Color).Render("Claude "+n.Claude))
		}
		if n.GPT != "" {
			costs = append(costs, fg(theme.Model("gpt-5.6-sol").Color).Render("GPT "+n.GPT))
		}
		if n.Other != "" {
			costs = append(costs, fg(theme.FgMostSubtle).Render("other "+n.Other))
		}
		costLine := indent + "  " + strings.Join(costs, fg(theme.FgMostSubtle).Render(" · "))
		if sel {
			head = lipgloss.NewStyle().Background(theme.BgLow).Width(w).Render(head)
		}
		b = append(b, head, costLine, "")
	}
	return strings.Join(b, "\n")
}

// ---- overlays ----

func (m Model) renderOverlay() string {
	switch m.overlay {
	case OverlayRoute:
		return m.renderRoutePicker()
	case OverlayHelp:
		return m.renderHelp()
	}
	return ""
}

func (m Model) renderRoutePicker() string {
	s, _ := m.selectedSession()
	var b []string
	b = append(b, fg(theme.Keyword).Bold(true).Render("Resume via…"))
	b = append(b, fg(theme.FgMoreSubtle).Render(truncate(s.Title, 44)), "")
	for i, l := range data.Launchers {
		sel := i == 0
		bar := fg(theme.BgBase).Render("  ")
		nameC := theme.FgSubtle
		if sel {
			bar = fg(theme.Primary).Bold(true).Render("❯ ")
			nameC = theme.FgBase
		}
		mark := fg(theme.Success).Render("✓")
		if !l.Eligible {
			mark = fg(theme.FgMostSubtle).Render("✗")
			nameC = theme.FgMostSubtle
		}
		name := lipgloss.NewStyle().Foreground(nameC).Background(theme.BgBase).Bold(sel).Render(pad(l.Name, 12))
		backend := fg(theme.FgMoreSubtle).Render(pad(l.Backend, 22))
		b = append(b, bar+mark+" "+name+backend)
		b = append(b, fg(theme.FgMostSubtle).Render("     "+l.Reason))
	}
	b = append(b, "", fg(theme.FgMostSubtle).Render("enter resume · esc cancel"))
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Primary).
		Background(theme.BgBase).Padding(1, 3).Render(strings.Join(b, "\n"))
}

func (m Model) renderHelp() string {
	groups := [][2]string{
		{"↑↓ / j k", "move selection"},
		{"enter", "resume the session"},
		{"r", "resume via… (pick launcher/backend)"},
		{"f", "fork-resume (new id, same history)"},
		{"v", "read the full transcript"},
		{"p", "show / hide preview pane"},
		{"g", "grouping: groups → state → flat → tree → cluster"},
		{"s", "sort: recency → cost → messages"},
		{"/", "fuzzy search + full-text"},
		{"t", "re-title · L/C/X loop/done/archive"},
		{"?", "this help · q quit"},
	}
	var b []string
	b = append(b, fg(theme.Keyword).Bold(true).Render("Sessions — keys"), "")
	for _, g := range groups {
		b = append(b, fg(theme.Accent).Bold(true).Render(pad(g[0], 16))+fg(theme.FgSubtle).Render(g[1]))
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).BorderForeground(theme.Accent).
		Background(theme.BgBase).Padding(1, 3).Render(strings.Join(b, "\n"))
}

// ---- footer ----

func (m Model) renderKeybar(w int) string {
	viewLabel := "groups"
	if m.view == ViewTree {
		viewLabel = "tree"
	}
	items := [][2]string{
		{"↑↓", "move"}, {"enter", "resume"}, {"r", "via…"}, {"v", "transcript"},
		{"/", "search"}, {"g", "view:" + viewLabel}, {"s", "sort"}, {"p", "preview"},
		{"?", "help"}, {"q", "quit"},
	}
	var parts []string
	for _, it := range items {
		parts = append(parts, fg(theme.Accent).Bold(true).Render(it[0])+fg(theme.FgMoreSubtle).Render(" "+it[1]))
	}
	return theme.Main.Width(w).Render(strings.Join(parts, fg(theme.FgMostSubtle).Render(" · ")))
}

// ---- helpers ----

func sect(s string) string {
	return fg(theme.Keyword).Bold(true).Render(s)
}
func classChip(c string) string {
	if c == "" {
		return fg(theme.FgMostSubtle).Render("unclassified")
	}
	return fg(theme.ClassColor(c)).Render(c)
}
func nonEmpty(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n < 1 {
		return ""
	}
	return string(r[:n-1]) + "…"
}
func pad(s string, n int) string {
	s = truncate(s, n)
	for lipgloss.Width(s) < n {
		s += " "
	}
	return s
}
func lpad(s string, n int) string {
	for lipgloss.Width(s) < n {
		s = " " + s
	}
	return s
}
func parseUSD(s string) float64 {
	s = strings.TrimPrefix(s, "$")
	s = strings.ReplaceAll(s, ",", "")
	var v float64
	if strings.HasSuffix(s, "k") {
		fmt.Sscanf(strings.TrimSuffix(s, "k"), "%f", &v)
		return v * 1000
	}
	fmt.Sscanf(s, "%f", &v)
	return v
}
