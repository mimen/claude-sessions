package data

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestLoadIndexReadsLastModelWithLegacyFallback(t *testing.T) {
	tests := []struct {
		name       string
		lastColumn string
		insert     string
		wantLast   string
	}{
		{
			name:       "indexed final model",
			lastColumn: ", last_model TEXT",
			insert:     `INSERT INTO sessions (session_id, host, project_name, fallback_label, models, last_model) VALUES ('session-1', 'host', 'project', 'title', '["claude-fable-5","gpt-5.6-sol"]', 'gpt-5.6-sol')`,
			wantLast:   "gpt-5.6-sol",
		},
		{
			name:     "upgraded database before last model column",
			insert:   `INSERT INTO sessions (session_id, host, project_name, fallback_label, models) VALUES ('session-1', 'host', 'project', 'title', '["claude-fable-5","gpt-5.6-sol"]')`,
			wantLast: "",
		},
		{
			name:       "nullable upgraded row",
			lastColumn: ", last_model TEXT",
			insert:     `INSERT INTO sessions (session_id, host, project_name, fallback_label, models, last_model) VALUES ('session-1', 'host', 'project', 'title', '["claude-fable-5","gpt-5.6-sol"]', NULL)`,
			wantLast:   "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "index.db")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			create := `CREATE TABLE sessions (
				session_id TEXT PRIMARY KEY,
				host TEXT NOT NULL,
				project_name TEXT NOT NULL,
				fallback_label TEXT NOT NULL,
				models TEXT NOT NULL` + test.lastColumn + `
			)`
			for _, statement := range []string{create, test.insert} {
				if _, err := db.Exec(statement); err != nil {
					db.Close()
					t.Fatal(err)
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}

			rows, err := loadIndex(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].LastModel != test.wantLast {
				t.Fatalf("rows = %+v, want last model %q", rows, test.wantLast)
			}
		})
	}
}
