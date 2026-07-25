package ui

import (
	"fmt"
	"strings"

	"github.com/mimen/claude-sessions/tui-go/theme"
	"github.com/mimen/claude-sessions/tui-go/transcript"

	"github.com/charmbracelet/lipgloss"
)

type visualTranscriptLine struct {
	kind  transcript.Kind
	text  string
	label string
}

func (m Model) renderTranscriptReader(width int, height int) string {
	if m.reader == nil {
		return ""
	}
	width = max(8, width)
	height = max(5, height)
	bodyHeight := max(1, height-4)
	visual := m.reader.visual
	if m.reader.visualWidth != max(4, width-6) || visual == nil {
		visual = transcriptVisualLines(m.reader.document.Lines, max(4, width-6))
	}
	maxScroll := max(0, len(visual)-bodyHeight)
	scroll := clamp(m.reader.scroll, 0, maxScroll)
	window := visual[scroll:min(len(visual), scroll+bodyHeight)]

	title := fg(theme.FgBase).Bold(true).Render(truncate(m.reader.title, max(1, width-24)))
	meta := fmt.Sprintf(" · %d lines · %s", len(visual), m.reader.document.Format)
	if m.reader.document.Truncated {
		meta += " · recent tail"
	}
	header := fit(title+fg(theme.FgMoreSubtle).Render(meta), width)
	rule := fg(theme.Sep).Render(strings.Repeat("─", width))
	lines := make([]string, 0, height)
	lines = append(lines, header, rule)
	for _, item := range window {
		label := fg(theme.FgMostSubtle).Render(pad(item.label, 4))
		color := theme.FgSubtle
		switch item.kind {
		case transcript.KindUser:
			color = theme.Accent
		case transcript.KindAssistant:
			color = theme.FgBase
		case transcript.KindTool:
			color = theme.FgMostSubtle
		case transcript.KindMeta:
			color = theme.FgMoreSubtle
		}
		lines = append(lines, fit(label+fg(color).Render(item.text), width))
	}
	for len(lines) < height-1 {
		lines = append(lines, "")
	}
	position := "END"
	if scroll < maxScroll {
		position = fmt.Sprintf("%d%%", scroll*100/max(1, maxScroll))
	}
	footer := fg(theme.FgMoreSubtle).Render("j/k · PgUp/PgDn · g/G · v/esc close · " + position)
	lines = append(lines, fit(footer, width))
	return strings.Join(lines, "\n")
}

func transcriptVisualLines(lines []transcript.Line, width int) []visualTranscriptLine {
	visual := make([]visualTranscriptLine, 0, len(lines)*2)
	for _, line := range lines {
		wrapped := wrapPlain(line.Text, width)
		label := transcriptLabel(line.Kind)
		for index, text := range wrapped {
			rowLabel := ""
			if index == 0 {
				rowLabel = label
			}
			visual = append(visual, visualTranscriptLine{kind: line.Kind, text: text, label: rowLabel})
		}
	}
	return visual
}

func wrapPlain(value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	if value == "" {
		return []string{""}
	}
	var out []string
	for _, paragraph := range strings.Split(value, "\n") {
		runes := []rune(paragraph)
		if len(runes) == 0 {
			out = append(out, "")
			continue
		}
		for len(runes) > width {
			out = append(out, string(runes[:width]))
			runes = runes[width:]
		}
		out = append(out, string(runes))
	}
	return out
}

// wrapWords wraps prose at word boundaries (never mid-word), falling back to a
// hard break only for a single token longer than the width. Used for
// human-readable text (summaries, proposal reasons) where mid-word breaks read
// as garbled; wrapPlain stays for transcript/code where column alignment wins.
func wrapWords(value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	var out []string
	for _, paragraph := range strings.Split(value, "\n") {
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			out = append(out, "")
			continue
		}
		line := ""
		lineLen := 0
		for _, word := range words {
			wl := len([]rune(word))
			for wl > width { // a single token wider than the line: hard-break it
				if line != "" {
					out = append(out, line)
					line, lineLen = "", 0
				}
				runes := []rune(word)
				out = append(out, string(runes[:width]))
				word = string(runes[width:])
				wl = len([]rune(word))
			}
			switch {
			case line == "":
				line, lineLen = word, wl
			case lineLen+1+wl <= width:
				line += " " + word
				lineLen += 1 + wl
			default:
				out = append(out, line)
				line, lineLen = word, wl
			}
		}
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// meaningfulLines drops tool-call/result lines so the peek shows the actual
// conversation when catching up — not "→ Bash …" / "← tool result …" noise. The
// full `v` reader still shows everything.
func meaningfulLines(lines []transcript.Line) []transcript.Line {
	out := make([]transcript.Line, 0, len(lines))
	for _, line := range lines {
		// Drop tool calls/results and blank/separator lines entirely — the peek
		// is a tight list of recent messages with no gaps between them.
		if line.Kind == transcript.KindTool || line.Kind == transcript.KindMeta {
			continue
		}
		if strings.TrimSpace(line.Text) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

func transcriptLabel(kind transcript.Kind) string {
	switch kind {
	case transcript.KindUser:
		return "you"
	case transcript.KindAssistant:
		return "ai"
	default:
		return ""
	}
}

func peekColor(kind transcript.Kind) lipgloss.Color {
	switch kind {
	case transcript.KindUser:
		return theme.Accent
	case transcript.KindAssistant:
		return theme.FgBase
	default:
		return theme.FgSubtle
	}
}

// renderPeekRows expands recent messages into full, word-wrapped display rows:
// the "you"/"ai" label sits on the first row, continuations indent under it. No
// truncation — the peek shows whole messages (scroll with J/K). Embedded
// newlines are flattened first so wrapping is clean at the pane width.
// maxPeekLinesPerMessage caps how tall a single message gets in the peek so one
// long message can't swallow the whole pane; the last shown line gets an ellipsis.
const maxPeekLinesPerMessage = 3

func renderPeekRows(msgs []transcript.Line, width int) []string {
	rows := make([]string, 0, len(msgs)*maxPeekLinesPerMessage)
	textWidth := max(1, width-4)
	for _, line := range msgs {
		label := transcriptLabel(line.Kind)
		color := peekColor(line.Kind)
		text := strings.Join(strings.Fields(line.Text), " ")
		wrapped := wrapWords(text, textWidth)
		if len(wrapped) > maxPeekLinesPerMessage {
			wrapped = wrapped[:maxPeekLinesPerMessage]
			last := []rune(wrapped[maxPeekLinesPerMessage-1])
			if len(last) >= textWidth {
				last = last[:textWidth-1]
			}
			wrapped[maxPeekLinesPerMessage-1] = string(last) + "…"
		}
		for i, w := range wrapped {
			prefix := theme.Main.Render("    ")
			if i == 0 {
				prefix = fg(theme.FgMostSubtle).Render(pad(label, 4))
			}
			rows = append(rows, fit(prefix+lipgloss.NewStyle().Foreground(color).Background(theme.BgBase).Render(w), width))
		}
	}
	return rows
}
