package data

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

// normalizeInline strips terminal escape sequences and turns all control
// characters into spaces before external text reaches Lipgloss. CCS titles and
// cwd values ultimately originate in transcripts and terminal metadata, so the
// TUI must not let a malformed row inject new lines or terminal commands.
func normalizeInline(value string) string {
	value = ansi.Strip(value)
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}
