package data

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// v38Catalogue builds a catalogue carrying the enrichment columns, so these tests exercise the
// same shape `ccs enrich` writes rather than a hand-rolled approximation.
func v38Catalogue(t *testing.T, rows ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "catalogue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	statements := append([]string{
		`CREATE TABLE catalogue (
			session_id TEXT PRIMARY KEY,
			identity_key TEXT,
			enrichment_summary TEXT,
			enrichment_outstanding TEXT,
			enrichment_recommendation TEXT,
			enrichment_reason TEXT,
			enrichment_junk INTEGER,
			enrichment_cwd_correct INTEGER,
			enrichment_suggested_location TEXT,
			enrichment_suggested_cwd TEXT,
			enrichment_at_messages INTEGER,
			enrichment_at TEXT
		)`,
	}, rows...)
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadCatalogueReadsEnrichment(t *testing.T) {
	path := v38Catalogue(t, `INSERT INTO catalogue (
		session_id, enrichment_summary, enrichment_outstanding, enrichment_recommendation,
		enrichment_reason, enrichment_junk, enrichment_cwd_correct,
		enrichment_suggested_location, enrichment_at_messages, enrichment_at
	) VALUES (
		'session-1', 'Built the sweep.', 'Agent not installed.', 'continue',
		'Work is mid-flight.', 0, 0, 'repos-ccs', 412, '2026-07-24T12:00:00Z'
	)`)

	catalogue, err := loadCatalogue(path)
	if err != nil {
		t.Fatal(err)
	}
	enrichment := catalogue["session-1"].Enrichment
	if !enrichment.Present() {
		t.Fatal("enrichment should be present")
	}
	if enrichment.Summary != "Built the sweep." || enrichment.Recommendation != "continue" {
		t.Fatalf("enrichment = %+v", enrichment)
	}
	if enrichment.CWDCorrect || enrichment.SuggestedLoc != "repos-ccs" {
		t.Fatalf("cwd judgement = %+v", enrichment)
	}
	if enrichment.AtMessages != 412 || enrichment.At.IsZero() {
		t.Fatalf("provenance = %+v", enrichment)
	}
}

func TestLoadCatalogueTreatsUnenrichedRowsAsAbsent(t *testing.T) {
	// A row with columns but no recommendation was never enriched. It must read as absent rather
	// than as an enrichment with an empty summary, which would render as a confident blank.
	path := v38Catalogue(t, `INSERT INTO catalogue (session_id) VALUES ('session-1')`)

	catalogue, err := loadCatalogue(path)
	if err != nil {
		t.Fatal(err)
	}
	if catalogue["session-1"].Enrichment.Present() {
		t.Fatal("a row with no recommendation must not report an enrichment")
	}
}

func TestLoadCatalogueWithoutEnrichmentColumns(t *testing.T) {
	// The compatibility case that matters in practice: a machine whose CCS predates v38, or a
	// store not yet opened by a v38 binary. The TUI must still load every other field.
	path := filepath.Join(t.TempDir(), "catalogue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE catalogue (session_id TEXT PRIMARY KEY, custom_title TEXT, archived INTEGER)`,
		`INSERT INTO catalogue (session_id, custom_title, archived) VALUES ('session-1', 'Pre-v38', 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	catalogue, err := loadCatalogue(path)
	if err != nil {
		t.Fatalf("a pre-v38 catalogue must still load: %v", err)
	}
	meta := catalogue["session-1"]
	if meta.CustomTitle != "Pre-v38" || !meta.Archived {
		t.Fatalf("non-enrichment fields lost: %+v", meta)
	}
	if meta.Enrichment.Present() {
		t.Fatal("no enrichment columns means no enrichment")
	}
}

func TestEnrichmentStaleBy(t *testing.T) {
	enrichment := Enrichment{Recommendation: "continue", AtMessages: 100}
	if got := enrichment.StaleBy(142); got != 42 {
		t.Fatalf("StaleBy(142) = %d, want 42", got)
	}
	if got := enrichment.StaleBy(100); got != 0 {
		t.Fatalf("an unchanged session is not stale, got %d", got)
	}
	// Transcripts can shrink when a duplicate is resolved or a file is replaced; a negative
	// delta must never render as "not updated in -8 turns".
	if got := enrichment.StaleBy(92); got != 0 {
		t.Fatalf("a rewound count must clamp to 0, got %d", got)
	}
	if got := (Enrichment{}).StaleBy(500); got != 0 {
		t.Fatalf("an absent enrichment has no staleness, got %d", got)
	}
}
