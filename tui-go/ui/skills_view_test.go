package ui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/mimen/claude-sessions/tui-go/skills"

	tea "github.com/charmbracelet/bubbletea"
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

func TestSkillViewCycleReachesSourceAndNamesIt(t *testing.T) {
	model := New(testSnapshot(1))
	model.mode = ModeSkills
	model.w, model.h = 120, 40
	model.skills = skills.Snapshot{Skills: []skills.Skill{{Name: "imported", Home: "global", Category: "dev", Source: "jakubkrehel/skills"}}}
	model.rebuildSkillRows()

	seen := make(map[skillView]bool)
	labels := make(map[skillView]string)
	for step := 0; step < 6; step++ {
		seen[model.skillView] = true
		labels[model.skillView] = ansi.Strip(model.renderSkillsScreen())
		next, _ := model.handleSkillKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
		model = next.(Model)
	}
	if !seen[skillViewSource] {
		t.Fatalf("the g cycle never reached skillViewSource: %+v", seen)
	}
	if model.skillView != skillViewCategory {
		t.Fatalf("six presses of g landed on %d, want back at skillViewCategory", model.skillView)
	}
	if !strings.Contains(labels[skillViewSource], "source ·") {
		t.Fatalf("the source view header lacked its label:\n%s", labels[skillViewSource])
	}
}

func TestSkillsSourceViewBucketsByFullSlugWithFirstPartyLast(t *testing.T) {
	registry := []skills.Skill{
		{Name: "alpha", Source: "jakubkrehel/skills"},
		{Name: "beta"},
		{Name: "gamma", Source: "mattpocock/skills"},
		{Name: "delta", Source: "jakubkrehel/skills"},
		{Name: "epsilon", Source: "jakubkrehel/other-skills"},
	}
	rows := buildSkillRows(registry, skillViewSource, "")
	headers := make([]string, 0, 4)
	for _, row := range rows {
		if row.header {
			headers = append(headers, fmt.Sprintf("%s:%d", row.label, row.count))
		}
	}
	want := "jakubkrehel/skills:2,jakubkrehel/other-skills:1,mattpocock/skills:1,first-party:1"
	if got := strings.Join(headers, ","); got != want {
		t.Fatalf("source headers = %q, want %q", got, want)
	}
}

func TestMatchesSkillFindsVendoredSkillBySourceOwner(t *testing.T) {
	vendored := skills.Skill{Name: "imported", Description: "no owner here", Source: "jakubkrehel/skills"}
	homegrown := skills.Skill{Name: "homegrown", Description: "no owner here"}
	if !matchesSkill(vendored, "jakubkrehel") {
		t.Fatal("searching the source owner did not match the vendored skill")
	}
	if !matchesSkill(vendored, "jakubkrehel/skills") {
		t.Fatal("searching the full source slug did not match the vendored skill")
	}
	if matchesSkill(homegrown, "jakubkrehel") {
		t.Fatal("searching an owner matched a first-party skill")
	}
}
