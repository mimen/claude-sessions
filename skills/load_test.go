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
