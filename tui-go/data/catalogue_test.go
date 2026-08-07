package data

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLoadCatalogueReadsIdentityStageAndPRFacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalogue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE catalogue (session_id TEXT PRIMARY KEY, identity_key TEXT)`,
		`CREATE TABLE identities (identity_key TEXT PRIMARY KEY, cluster TEXT, role TEXT, kind TEXT, stage TEXT, completed INTEGER, archived INTEGER, parked_task_id TEXT)`,
		`CREATE TABLE identity_pr_agent (identity_key TEXT PRIMARY KEY, pr_number INTEGER, pr_state TEXT)`,
		`INSERT INTO catalogue (session_id, identity_key) VALUES ('session-1', 'pr-watch:pr-agent:123')`,
		`INSERT INTO identities (identity_key, cluster, role, kind, stage, completed, archived) VALUES ('pr-watch:pr-agent:123', 'pr-watch', 'pr-agent', 'fleet', 'milad-review', 0, 0)`,
		`INSERT INTO identity_pr_agent (identity_key, pr_number, pr_state) VALUES ('pr-watch:pr-agent:123', 123, 'open')`,
	}
	for _, statement := range statements {
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
		t.Fatal(err)
	}
	meta := catalogue["session-1"]
	if meta.Stage != "milad-review" || meta.PRNumber != 123 || meta.PRState != "open" {
		t.Fatalf("catalogue metadata = %+v", meta)
	}
}

func TestLoadCatalogueReadsCategoryAssignmentWhenPresent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalogue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE catalogue (session_id TEXT PRIMARY KEY)`,
		`CREATE TABLE session_category_assignments (session_id TEXT PRIMARY KEY, slug TEXT, source TEXT)`,
		`INSERT INTO catalogue (session_id) VALUES ('session-1')`,
		`INSERT INTO session_category_assignments (session_id, slug, source) VALUES ('session-1', 'events', 'manual')`,
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
		t.Fatal(err)
	}
	if got := catalogue["session-1"].StoredCategory; got != "events" {
		t.Fatalf("stored category = %q", got)
	}
}

func TestLoadCatalogueFallsBackToLegacySessionStage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalogue.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE catalogue (session_id TEXT PRIMARY KEY, stage TEXT, pr_number INTEGER, pr_state TEXT)`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO catalogue (session_id, stage, pr_number, pr_state) VALUES ('session-1', 'approved', 77, 'open')`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	catalogue, err := loadCatalogue(path)
	if err != nil {
		t.Fatal(err)
	}
	meta := catalogue["session-1"]
	if meta.Stage != "approved" || meta.PRNumber != 77 || meta.PRState != "open" {
		t.Fatalf("legacy catalogue metadata = %+v", meta)
	}
}
