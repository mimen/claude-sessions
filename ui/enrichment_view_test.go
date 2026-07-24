package ui

import (
	"strings"
	"testing"

	"ccsspike/data"
)

func enriched() data.Enrichment {
	return data.Enrichment{
		Summary:        "Designed and built the enrichment subsystem end to end.",
		Outstanding:    "The launchd agent is not installed yet.",
		Recommendation: "continue",
		Reason:         "Work is mid-flight with tests still to write.",
		CWDCorrect:     true,
		AtMessages:     100,
	}
}

// plain strips ANSI styling so assertions read against text rather than escape codes.
func plain(lines []string) string {
	joined := strings.Join(lines, "\n")
	var out strings.Builder
	skipping := false
	for _, r := range joined {
		switch {
		case r == '\x1b':
			skipping = true
		case skipping && r == 'm':
			skipping = false
		case !skipping:
			out.WriteRune(r)
		}
	}
	return out.String()
}

func TestRenderEnrichmentLeadsWithRecommendationAndSummary(t *testing.T) {
	session := data.Session{ID: "abcd1234-rest", Messages: 100, Enrichment: enriched()}
	got := plain(renderEnrichment(session, 60))

	for _, want := range []string{"continue", "Designed and built", "open", "launchd agent"} {
		if !strings.Contains(got, want) {
			t.Fatalf("dossier missing %q:\n%s", want, got)
		}
	}
}

func TestRenderEnrichmentShoutsWhenStale(t *testing.T) {
	// The property that matters most: a summary describing an older session must say so, or the
	// reader has no cue to distrust confidently worded prose.
	session := data.Session{ID: "abcd1234", Messages: 142, Enrichment: enriched()}
	if got := plain(renderEnrichment(session, 60)); !strings.Contains(got, "not updated in 42 turns") {
		t.Fatalf("stale enrichment did not announce itself:\n%s", got)
	}

	fresh := data.Session{ID: "abcd1234", Messages: 100, Enrichment: enriched()}
	if got := plain(renderEnrichment(fresh, 60)); strings.Contains(got, "not updated") {
		t.Fatalf("a current enrichment must not claim staleness:\n%s", got)
	}
}

func TestStaleLabelSingularPlural(t *testing.T) {
	if got := staleLabel(1); got != "not updated in 1 turn" {
		t.Fatalf("staleLabel(1) = %q", got)
	}
	if got := staleLabel(2); got != "not updated in 2 turns" {
		t.Fatalf("staleLabel(2) = %q", got)
	}
	if got := staleLabel(0); got != "" {
		t.Fatalf("staleLabel(0) = %q, want empty", got)
	}
}

func TestRenderEnrichmentFlagsAWrongDirectory(t *testing.T) {
	enrichment := enriched()
	enrichment.CWDCorrect = false
	enrichment.SuggestedLoc = "repos-ccs"
	session := data.Session{ID: "abcd1234", Messages: 100, Enrichment: enrichment}

	got := plain(renderEnrichment(session, 60))
	if !strings.Contains(got, "cwd") || !strings.Contains(got, "repos-ccs") {
		t.Fatalf("wrong-directory session did not surface its suggestion:\n%s", got)
	}
}

func TestRenderEnrichmentMarksAnUnregisteredSuggestion(t *testing.T) {
	// A free-text path means no registered location fit, which is a different fact from "move it
	// to this known place" — the reader has to register somewhere first.
	enrichment := enriched()
	enrichment.CWDCorrect = false
	enrichment.SuggestedCWD = "/Users/mimen/Programming/Repos/brand-new"
	session := data.Session{ID: "abcd1234", Messages: 100, Enrichment: enrichment}

	if got := plain(renderEnrichment(session, 60)); !strings.Contains(got, "unregistered") {
		t.Fatalf("free-text suggestion was not marked unregistered:\n%s", got)
	}
}

func TestRenderEnrichmentStaysQuietWhenNothingIsWrong(t *testing.T) {
	// Say less when the answer is boring: a correctly placed session with nothing outstanding
	// should not print empty cwd or open rows.
	enrichment := enriched()
	enrichment.Outstanding = ""
	session := data.Session{ID: "abcd1234", Messages: 100, Enrichment: enrichment}

	got := plain(renderEnrichment(session, 60))
	if strings.Contains(got, "cwd") || strings.Contains(got, "open ") {
		t.Fatalf("dossier printed empty rows:\n%s", got)
	}
}

func TestRenderEnrichmentOffersTheCommandWhenUnenriched(t *testing.T) {
	session := data.Session{ID: "ABCD1234-5678-90ab", Messages: 12}
	got := plain(renderEnrichment(session, 60))

	if !strings.Contains(got, "not enriched yet") {
		t.Fatalf("unenriched session should say so:\n%s", got)
	}
	// The hint has to be pasteable — `ccs enrich` accepts this 8-character prefix.
	if !strings.Contains(got, "ccs enrich abcd1234") {
		t.Fatalf("hint is not a runnable command:\n%s", got)
	}
}

func TestRenderEnrichmentMarksJunk(t *testing.T) {
	enrichment := enriched()
	enrichment.Junk = true
	session := data.Session{ID: "abcd1234", Messages: 100, Enrichment: enrichment}

	if got := plain(renderEnrichment(session, 60)); !strings.Contains(got, "junk") {
		t.Fatalf("junk session not marked:\n%s", got)
	}
}
