package skills

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseFrontmatterFoldedDescription(t *testing.T) {
	frontmatter := parseFrontmatter("---\nname: sample\ndescription: >-\n  one line\n  two line\ncategory: dev\n---\nbody")
	if frontmatter["name"] != "sample" || frontmatter["description"] != "one line two line" || frontmatter["category"] != "dev" {
		t.Fatalf("frontmatter = %#v", frontmatter)
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
	ignored := filepath.Join(home, "Library", "hidden", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(ignored), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ignored, []byte("# ignored"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanned, err := scanMachine(home)
	if err != nil {
		t.Fatal(err)
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
