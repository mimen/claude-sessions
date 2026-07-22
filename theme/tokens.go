// Package theme is the design-token layer for the spike.
//
// The whole point of the port: every color is a *named semantic role*, never a
// raw hex sprinkled at a call site (the current TS TUI has ~180 inline chalk
// calls). Roles map onto Charm's "charmtone" palette — the exact named colors
// crush ships with — so a re-theme is a ~30-line edit here and nothing else.
package theme

import "github.com/charmbracelet/lipgloss"

// charmtone — Charm's named palette (the hexes crush actually uses).
// Named colors, not roles: roles below point at these.
const (
	charple  = "#6B50FF" // brand purple
	dolly    = "#FF60FF" // brand magenta
	blush    = "#FF84FF" // pink
	bok      = "#68FFD6" // mint
	guac     = "#12C78F"
	julep    = "#00FFB2" // green
	malibu   = "#00A4FF" // blue
	sardine  = "#4FBEFE"
	coral    = "#FF577D" // red-pink
	sriracha = "#EB4268" // red
	tang     = "#FF985A" // orange
	mustard  = "#F5EF34" // yellow
	zest     = "#E8FE96"
	citron   = "#E8FF27"
	butter   = "#FFFAF1"

	sash   = "#ECEBF0" // fg base (near-white)
	smoke  = "#BFBCC8" // fg subtle
	squid  = "#858392" // fg more subtle
	oyster = "#605F6B" // fg most subtle (dim)

	pepper = "#201F26" // bg base
	bbq    = "#2D2C36" // bg least visible
	char   = "#3A3943" // bg less visible / separator
	iron   = "#4D4C57" // bg most visible
)

// Semantic roles. This is the vocabulary the rest of the app speaks.
var (
	Primary   = lipgloss.Color(charple)
	Secondary = lipgloss.Color(dolly)
	Accent    = lipgloss.Color(bok)
	Keyword   = lipgloss.Color(blush)
	OnPrimary = lipgloss.Color(butter)

	FgBase       = lipgloss.Color(sash)
	FgSubtle     = lipgloss.Color(smoke)
	FgMoreSubtle = lipgloss.Color(squid)
	FgMostSubtle = lipgloss.Color(oyster)

	BgBase = lipgloss.Color(pepper)
	BgLow  = lipgloss.Color(bbq)
	BgMid  = lipgloss.Color(char)
	BgHigh = lipgloss.Color(iron)
	Sep    = lipgloss.Color(char)

	Success = lipgloss.Color(julep)
	SuccessDim = lipgloss.Color(guac)
	Info    = lipgloss.Color(malibu)
	InfoDim = lipgloss.Color(sardine)
	Warning = lipgloss.Color(mustard)
	WarnDim = lipgloss.Color(zest)
	Error   = lipgloss.Color(sriracha)
	Destroy = lipgloss.Color(coral)
	Denied  = lipgloss.Color(tang)
	Busy    = lipgloss.Color(citron)
)

// Logo gradient — a warm AUF-flavored sunset (yellow → orange → pink → purple)
// rather than crush's straight purple→magenta. Swapping this is one line.
var LogoGrad = []string{mustard, tang, coral, dolly, charple}

// Status → role, the pattern crush centralizes and the TS TUI copy-pastes in 4
// files. One source of truth for target-status color.
func StatusColor(status string) lipgloss.Color {
	switch status {
	case "Responded":
		return Success
	case "Contacted":
		return Info
	case "Pending":
		return Warning
	case "Bounced":
		return Error
	case "Skipped":
		return FgMostSubtle
	default:
		return FgSubtle
	}
}
