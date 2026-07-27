package theme

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/lucasb-eyer/go-colorful"
)

// ---- Reusable styles (the "component library" ethos: named, not inline) ----

var (
	// All shared text styles carry the base background so nested spans don't
	// reset it and leave patchy fills (a lipgloss gotcha).
	Base = lipgloss.NewStyle().Foreground(FgBase).Background(BgBase)

	Title = lipgloss.NewStyle().Foreground(FgBase).Bold(true).Background(BgBase)

	Muted = lipgloss.NewStyle().Foreground(FgMoreSubtle).Background(BgBase)

	Dim = lipgloss.NewStyle().Foreground(FgMostSubtle).Background(BgBase)

	// Left accent bar used on focused rows (crush's BorderThick "▌").
	SelectedBar = lipgloss.NewStyle().Foreground(Primary).Background(BgBase)

	Key = lipgloss.NewStyle().Foreground(Accent).Bold(true).Background(BgBase)

	KeyHint = lipgloss.NewStyle().Foreground(FgMoreSubtle).Background(BgBase)

	Panel = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Sep).
		Background(BgBase).
		Padding(0, 1)

	Sidebar = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), false, true, false, false).
		BorderForeground(Sep).
		BorderBackground(BgBase).
		Background(BgBase).
		Padding(0, 2, 0, 1)

	// Main is the content pane; explicit bg so composed padding stays uniform.
	Main = lipgloss.NewStyle().Background(BgBase)
)

// Gradient returns a slice of color.Color spanning stops, blended in HCL space
// so the ramp stays perceptually even and in-gamut — exactly what crush's anim
// package does with BlendHcl.
func Gradient(n int, stops ...string) []colorful.Color {
	if n <= 0 {
		return nil
	}
	pts := make([]colorful.Color, len(stops))
	for i, s := range stops {
		c, _ := colorful.Hex(s)
		pts[i] = c
	}
	if n == 1 {
		return []colorful.Color{pts[0]}
	}
	out := make([]colorful.Color, n)
	segs := len(pts) - 1
	for i := 0; i < n; i++ {
		t := float64(i) / float64(n-1) * float64(segs)
		lo := int(t)
		if lo >= segs {
			lo = segs - 1
		}
		frac := t - float64(lo)
		out[i] = pts[lo].BlendHcl(pts[lo+1], frac).Clamped()
	}
	return out
}

// GradientText paints s with a horizontal multi-stop gradient, per grapheme.
func GradientText(s string, bold bool, stops ...string) string {
	runes := []rune(s)
	ramp := Gradient(len(runes), stops...)
	var b strings.Builder
	for i, r := range runes {
		st := lipgloss.NewStyle().Foreground(lipgloss.Color(ramp[i].Hex())).Background(BgBase).Bold(bold)
		b.WriteString(st.Render(string(r)))
	}
	return b.String()
}

// Pill renders a status marker: colored dot + label on the base background.
func Pill(label string, c lipgloss.Color) string {
	dot := lipgloss.NewStyle().Foreground(c).Background(BgBase).Render("●")
	if label == "" {
		return dot
	}
	txt := lipgloss.NewStyle().Foreground(c).Background(BgBase).Render(label)
	return dot + lipgloss.NewStyle().Background(BgBase).Render(" ") + txt
}

// Badge is a solid channel tag (Instagram / SMS), filled background.
func Badge(label string, fg, bg lipgloss.Color) string {
	return lipgloss.NewStyle().
		Foreground(fg).Background(bg).
		Bold(true).Padding(0, 1).Render(label)
}

// Logo renders the AUF wordmark with a gradient and Charm-style diagonal
// fields (╱╱╱) flanking it, mirroring crush's logo composition.
func Logo(width int, version string) string {
	word := "AUF"
	// Big block wordmark, hand-set so it reads at a glance.
	art := []string{
		" ▄▀█ █ █ █▀▀ ",
		" █▀█ █▄█ █▀  ",
	}
	var lines []string
	for _, r := range art {
		lines = append(lines, GradientText(r, true, LogoGrad...))
	}
	block := strings.Join(lines, "\n")
	_ = word

	// Meta row: brand name + version, dim.
	meta := lipgloss.NewStyle().Foreground(FgMoreSubtle).Background(BgBase).Render("Afternoon Umbrella Friends")
	ver := lipgloss.NewStyle().Foreground(FgMostSubtle).Background(BgBase).Render(version)

	blockW := lipgloss.Width(block)
	fieldW := max(6, (width-blockW-4)/2)
	diagStyle := lipgloss.NewStyle().Foreground(FgMostSubtle).Background(BgBase)
	sp := lipgloss.NewStyle().Background(BgBase).Render(" ")

	fieldRow := diagStyle.Render(strings.Repeat("╱", fieldW))
	left := fieldRow + "\n" + fieldRow
	right := fieldRow + "\n" + fieldRow

	row := lipgloss.JoinHorizontal(lipgloss.Top, left, sp, block, sp, right)
	gapW := max(1, width-lipgloss.Width(meta)-lipgloss.Width(ver))
	metaRow := meta + lipgloss.NewStyle().Width(gapW).Background(BgBase).Render("") + ver
	return metaRow + "\n" + row
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
