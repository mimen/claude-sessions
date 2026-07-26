package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/mimen/claude-sessions/tui-go/data"
	"github.com/mimen/claude-sessions/tui-go/theme"
)

// Enrichment is what the dossier leads with, because it answers the question you actually opened
// the panel to ask — what was this, and what should I do with it — which a wall of recent
// transcript lines never did.
//
// The rendering rule throughout: say less when the answer is boring. A session in the right place
// with nothing outstanding prints a summary and a recommendation and stops; the cwd note and the
// junk marker only appear when they carry information.

// staleLabel is the warning that a stored summary describes an older session than the one in
// front of you. It has to be loud and adjacent to the summary, not tucked into a metadata row —
// enrichment is written confidently, and a confident description of a session as it was forty
// turns ago is worse than no description, because nothing cues the reader to distrust it.
func staleLabel(messagesSince int) string {
	if messagesSince <= 0 {
		return ""
	}
	turns := "turns"
	if messagesSince == 1 {
		turns = "turn"
	}
	return fmt.Sprintf("not updated in %d %s", messagesSince, turns)
}

// renderEnrichment returns the dossier's leading block, or nil when the session has never been
// enriched. Callers append it directly; it owns its own spacing.
func renderEnrichment(session data.Session, contentWidth int) []string {
	enrichment := session.Enrichment
	if !enrichment.Present() {
		// Nothing invented, and no apology. The sweep reaches every session eventually, so an
		// unenriched one is a matter of timing rather than an error worth a warning color.
		return []string{
			"",
			sect("Summary"),
			fg(theme.FgMostSubtle).Render("not enriched yet · ccs enrich " + shortID(session.ID)),
		}
	}

	header := theme.Pill(enrichment.Recommendation, theme.RecommendationColor(enrichment.Recommendation))
	if stale := staleLabel(enrichment.StaleBy(session.Messages)); stale != "" {
		header += fg(theme.FgMoreSubtle).Render("  " + stale)
	}
	if enrichment.Junk {
		header += fg(theme.FgMostSubtle).Render("  junk")
	}

	// "Summary" was the v39 field name. The section answers "where does this stand", so it says so.
	lines := []string{"", sect("State"), fit(header, contentWidth)}
	for _, wrapped := range wrapWords(enrichment.State, contentWidth) {
		lines = append(lines, fg(theme.FgSubtle).Render(wrapped))
	}

	// The reason justifies the pill, not the state, so it needs air above it — run together they
	// read as one paragraph and the eye loses which sentence is the verdict. Under v40 this is
	// empty on every continue and complete, so the block below simply does not appear for the
	// ~70% of sessions where the verdict speaks for itself.
	if enrichment.Reason != "" {
		lines = append(lines, "")
		for _, wrapped := range wrapWords(enrichment.Reason, contentWidth) {
			lines = append(lines, fg(theme.FgMoreSubtle).Render(wrapped))
		}
	}

	// Wrapped, not truncated: this is the most actionable line in the panel, and "Milad must
	// decide whether nine worker tab…" is exactly the half-sentence that makes you open the
	// transcript anyway — which is the trip this panel exists to save.
	if enrichment.Next != "" {
		lines = append(lines, "")
		lines = append(lines, hangingIndent("next", enrichment.Next, contentWidth, theme.Warning)...)
	}

	// Scope, not instruction: what is left after the next action, so the reader can judge whether
	// resuming is twenty minutes or two days. Quieter than `next` on purpose.
	if enrichment.Remaining != "" {
		lines = append(lines, hangingIndent("also", enrichment.Remaining, contentWidth, theme.FgMoreSubtle)...)
	}

	// A wrong working directory is the one enrichment field that is a defect rather than a
	// description, so it gets its own line and a warning color instead of sitting in Meta.
	// The arrow belongs to the label, not the value: a long path is one unbreakable token, so
	// prefixing the value with "→ " strands the arrow alone on the first line and the path starts
	// on the second, which reads as a rendering bug.
	//
	// CWDJudged gates the whole thing: a row written with no location registry never had the
	// question put to it, and NULL scanning to false would otherwise mark it as misplaced.
	if enrichment.CWDJudged && !enrichment.CWDCorrect {
		if target := enrichment.SuggestedLoc; target != "" {
			lines = append(lines, hangingIndent("cwd →", target, contentWidth, theme.Warning)...)
		} else if target := enrichment.SuggestedCWD; target != "" {
			// No registry key fit, so this is a proposal for a location that does not exist yet.
			lines = append(lines, hangingIndent("cwd →", compactHome(target)+" (unregistered)", contentWidth, theme.Warning)...)
		}
	}

	return lines
}

// hangingIndent renders a short label beside wrapped text, with continuation lines aligned under
// the text rather than the label — so a long value stays readable instead of being cut off.
func hangingIndent(label string, value string, contentWidth int, labelColor lipgloss.Color) []string {
	const gutter = 6
	wrapped := wrapWords(value, max(1, contentWidth-gutter))
	if len(wrapped) == 0 {
		return nil
	}
	out := make([]string, 0, len(wrapped))
	out = append(out, fg(labelColor).Render(pad(label, gutter))+fg(theme.FgSubtle).Render(wrapped[0]))
	for _, line := range wrapped[1:] {
		out = append(out, strings.Repeat(" ", gutter)+fg(theme.FgSubtle).Render(line))
	}
	return out
}

// shortID is the 8-character form every other CCS surface prints, and which `ccs enrich` accepts
// as a prefix — so the hint above can be typed straight into a shell.
func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return strings.ToLower(id[:8])
}
