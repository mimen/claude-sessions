package resume

import (
	"os"
	"path/filepath"
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

func TestFocusLiveUsesExactWorkspaceAndWindow(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "calls")
	binary := filepath.Join(t.TempDir(), "cmux")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CMUX_BIN", binary)
	if err := FocusLive(data.Session{LiveWorkspaceRef: "workspace:7", LiveWindowRef: "window:2"}); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	got := string(contents)
	if got != "select-workspace --workspace workspace:7 --window window:2\nfocus-window --window window:2\n" {
		t.Fatalf("calls = %q", got)
	}
}

func TestShellQuotesSingleQuotes(t *testing.T) {
	got := shellQuote("Milad's session")
	if got != "'Milad'\\''s session'" {
		t.Fatalf("shellQuote = %q", got)
	}
}
