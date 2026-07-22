package resume

import (
	"strings"
	"testing"

	"ccsspike/data"
)

func TestBuildUsesResumeIDAndLauncher(t *testing.T) {
	cwd := t.TempDir()
	command, note := Build(data.Session{ID: "filename", ResumeID: "internal", CWD: cwd}, data.Launcher{
		Backend: "claude-gpt",
		Env:     map[string]string{"GATEWAY": "one two"},
	})
	if note != "" {
		t.Fatalf("note = %q", note)
	}
	if got := strings.Join(command.Argv, " "); got != "claude-gpt --resume internal" {
		t.Fatalf("argv = %q", got)
	}
	if got := Shell(command); got != "env GATEWAY='one two' claude-gpt --resume internal" {
		t.Fatalf("shell = %q", got)
	}
}

func TestBuildFallsBackToProjectRoot(t *testing.T) {
	root := t.TempDir()
	command, note := Build(data.Session{ResumeID: "id", CWD: root + "/gone", ProjectRoot: root}, data.Launcher{Backend: "claude"})
	if command.CWD != root || note == "" {
		t.Fatalf("cwd=%q note=%q", command.CWD, note)
	}
}

func TestShellQuotesSingleQuotes(t *testing.T) {
	got := shellQuote("Milad's session")
	if got != "'Milad'\\''s session'" {
		t.Fatalf("shellQuote = %q", got)
	}
}
