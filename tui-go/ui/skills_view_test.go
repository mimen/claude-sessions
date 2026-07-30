package ui

import (
	"strings"
	"testing"

	"github.com/mimen/claude-sessions/tui-go/skills"

	"github.com/charmbracelet/x/ansi"
)

func TestSkillSourceOwnerShowsOwnerSegmentOrPlaceholder(t *testing.T) {
	cases := map[string]string{
		"jakubkrehel/skills": "jakubkrehel",
		"mattpocock/skills":  "mattpocock",
		"bare":               "bare",
		"":                   "—",
	}
	for source, want := range cases {
		if got := skillSourceOwner(source); got != want {
			t.Fatalf("skillSourceOwner(%q) = %q, want %q", source, got, want)
		}
	}
}

func TestSkillRowRendersSourceOwnerColumn(t *testing.T) {
	model := New(testSnapshot(1))
	// The SOURCE cell is 8 wide, so a long owner truncates with an ellipsis.
	vendored := ansi.Strip(model.renderSkillRow(100, skills.Skill{Name: "imported", Home: "global", Category: "dev", Source: "jakubkrehel/skills"}, false))
	if !strings.Contains(vendored, "jakubkr…") {
		t.Fatalf("vendored row lacked the truncated source owner: %q", vendored)
	}
	if strings.Contains(vendored, "/skills") {
		t.Fatalf("vendored row leaked the repo segment: %q", vendored)
	}
	short := ansi.Strip(model.renderSkillRow(100, skills.Skill{Name: "imported", Home: "global", Category: "dev", Source: "obra/skills"}, false))
	if !strings.Contains(short, "obra") || strings.Contains(short, "obra/") {
		t.Fatalf("short-owner row = %q", short)
	}
	// A first-party row carries two em-dashes (source + never-used age); a sourced row only one.
	firstParty := ansi.Strip(model.renderSkillRow(100, skills.Skill{Name: "homegrown", Home: "global", Category: "dev"}, false))
	if strings.Count(firstParty, "—") != 2 {
		t.Fatalf("first-party row lacked the source em-dash placeholder: %q", firstParty)
	}
	if strings.Count(vendored, "—") != 1 {
		t.Fatalf("vendored row = %q", vendored)
	}
}

func TestSkillPreviewShowsFullSourceSlug(t *testing.T) {
	model := New(testSnapshot(1))
	model.mode = ModeSkills
	model.skills = skills.Snapshot{Skills: []skills.Skill{{Name: "imported", Home: "global", Category: "dev", Source: "jakubkrehel/skills"}}}
	model.rebuildSkillRows()
	preview := ansi.Strip(model.renderSkillPreview(60, 30))
	if !strings.Contains(preview, "source") || !strings.Contains(preview, "jakubkrehel/skills") {
		t.Fatalf("preview lacked the full source slug:\n%s", preview)
	}

	model.skills = skills.Snapshot{Skills: []skills.Skill{{Name: "homegrown", Home: "global", Category: "dev"}}}
	model.rebuildSkillRows()
	firstParty := ansi.Strip(model.renderSkillPreview(60, 30))
	if !strings.Contains(firstParty, "source") || !strings.Contains(firstParty, "—") {
		t.Fatalf("first-party preview lacked the em-dash placeholder:\n%s", firstParty)
	}
}
