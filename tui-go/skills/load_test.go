package skills

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestParseFrontmatterFoldedDescription(t *testing.T) {
	frontmatter := parseFrontmatter("---\nname: sample\ndescription: >-\n  one line\n  two line\ncategory: dev\nsource: jakubkrehel/skills\n---\nbody")
	if frontmatter["name"] != "sample" || frontmatter["description"] != "one line two line" || frontmatter["category"] != "dev" {
		t.Fatalf("frontmatter = %#v", frontmatter)
	}
	if frontmatter["source"] != "jakubkrehel/skills" {
		t.Fatalf("source = %q", frontmatter["source"])
	}
}

func writeSkillsCache(t *testing.T, statements []string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "skills.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
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
	return path
}

func TestLoadCacheReadsSourceColumn(t *testing.T) {
	path := writeSkillsCache(t, []string{
		`CREATE TABLE skills (name TEXT, path TEXT, real_path TEXT, ecosystem TEXT, description TEXT, aliases TEXT, mtime_ms REAL, content_hash TEXT, category TEXT, source TEXT)`,
		`INSERT INTO skills VALUES ('vendored', '/skills/vendored', '/skills/vendored', 'claude-user', '', '[]', 0, 'a', 'dev', 'jakubkrehel/skills')`,
		`INSERT INTO skills VALUES ('homegrown', '/skills/homegrown', '/skills/homegrown', 'claude-user', '', '[]', 0, 'b', 'dev', NULL)`,
	})
	loaded, err := loadCache(path, "/Users/test")
	if err != nil {
		t.Fatal(err)
	}
	bySource := make(map[string]string, len(loaded))
	for _, skill := range loaded {
		bySource[skill.Name] = skill.Source
	}
	if bySource["vendored"] != "jakubkrehel/skills" {
		t.Fatalf("vendored source = %q", bySource["vendored"])
	}
	if bySource["homegrown"] != "" {
		t.Fatalf("homegrown source = %q", bySource["homegrown"])
	}
}

func TestLoadCacheToleratesMissingSourceColumn(t *testing.T) {
	path := writeSkillsCache(t, []string{
		`CREATE TABLE skills (name TEXT, path TEXT, real_path TEXT, ecosystem TEXT, description TEXT, aliases TEXT, mtime_ms REAL, content_hash TEXT, category TEXT)`,
		`INSERT INTO skills VALUES ('legacy', '/skills/legacy', '/skills/legacy', 'claude-user', '', '[]', 0, 'a', 'dev')`,
	})
	loaded, err := loadCache(path, "/Users/test")
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 1 || loaded[0].Source != "" || loaded[0].Category != "dev" {
		t.Fatalf("loaded = %+v", loaded)
	}
}

func TestScanMachineReadsFrontmatterSource(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "Documents", "vendor", "skills", "imported", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nname: imported\nsource: mattpocock/skills\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanned, _, err := scanMachine(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(scanned) != 1 || scanned[0].Source != "mattpocock/skills" {
		t.Fatalf("scanned = %+v", scanned)
	}
}

func TestClassifyAndHome(t *testing.T) {
	home := "/Users/test"
	path := home + "/Documents/vault/ClaudeConfig/skills/one"
	if got := classifyPath(path, home); got != "claude-user" {
		t.Fatalf("classifyPath = %q", got)
	}
	if got := homeOf(path, home); got != "global" {
		t.Fatalf("homeOf = %q", got)
	}
}

func TestScanMachineDiscoversSkillsAcrossHome(t *testing.T) {
	home := t.TempDir()
	paths := []string{
		filepath.Join(home, "Documents", "scout-core", "skills", "todoist-scout", "SKILL.md"),
		filepath.Join(home, "Documents", "vault", ".claude", "skills", "wiki-session-startup", "SKILL.md"),
	}
	for _, path := range paths {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("---\nname: "+filepath.Base(filepath.Dir(path))+"\n---\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ignored := []string{
		filepath.Join(home, "Library", "hidden", "SKILL.md"),
		filepath.Join(home, ".cache", "package", "SKILL.md"),
		filepath.Join(home, ".bun", "install", "cache", "package", "skills", "cached", "SKILL.md"),
	}
	for _, path := range ignored {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("# ignored"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	scanned, warnings, err := scanMachine(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	if len(scanned) != 2 {
		t.Fatalf("scanned = %+v", scanned)
	}
}

func TestVisibleSkillsKeepsAllInstalledEcosystems(t *testing.T) {
	registry := []Skill{
		{Name: "claude", Path: "/skills/claude", RealPath: "/skills/claude", Ecosystem: "claude-user", Hash: "a"},
		{Name: "codex", Path: "/skills/codex", RealPath: "/skills/codex", Ecosystem: "codex", Hash: "b"},
		{Name: "hermes", Path: "/skills/hermes", RealPath: "/skills/hermes", Ecosystem: "hermes", Hash: "c"},
		{Name: "cursor", Path: "/skills/cursor", RealPath: "/skills/cursor", Ecosystem: "cursor", Hash: "d"},
		{Name: "listing", Path: "/skills/listing", RealPath: "/skills/listing", Ecosystem: "marketplace", Hash: "e"},
	}
	visible := visibleSkills(registry)
	if len(visible) != 4 {
		t.Fatalf("visible = %+v", visible)
	}
	for _, skill := range visible {
		if skill.Ecosystem == "marketplace" {
			t.Fatal("marketplace listing remained visible")
		}
	}
}

func TestFilesKeepsSkillFirstAndReadContainsPath(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("# Skill"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ref.md"), []byte("reference"), 0o600); err != nil {
		t.Fatal(err)
	}
	skill := Skill{RealPath: root}
	files := Files(skill)
	if len(files) != 2 || files[0].Relative != "SKILL.md" {
		t.Fatalf("files = %+v", files)
	}
	if _, err := ReadFile(skill, "../outside"); err == nil {
		t.Fatal("expected containment error")
	}
}
