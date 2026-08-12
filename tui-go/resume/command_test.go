package resume

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mimen/claude-sessions/tui-go/data"
)

func TestBuildUsesResumeIDAndLauncher(t *testing.T) {
	cwd := t.TempDir()
	command, note, err := Build(data.Session{ID: "filename", ResumeID: "internal", CWD: cwd}, data.Launcher{
		Backend: "claude-gpt",
		Env:     map[string]string{"GATEWAY": "one two"},
	})
	if err != nil {
		t.Fatal(err)
	}
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

func TestBuildUsesCCSResumePathForSavedSession(t *testing.T) {
	cwd := t.TempDir()
	command, _, err := Build(data.Session{ID: "saved-id", ResumeID: "internal", CWD: cwd, State: "saved"}, data.Launcher{
		Name:    "gateway",
		Backend: "claude-gpt",
		Env:     map[string]string{"GATEWAY": "one two"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(command.Argv, " "); got != "ccs resume-session saved-id --via gateway" {
		t.Fatalf("argv = %q", got)
	}
	if got := Shell(command); got != "env GATEWAY='one two' ccs resume-session saved-id --via gateway" {
		t.Fatalf("shell = %q", got)
	}
}

func TestBuildRefusesDoneSession(t *testing.T) {
	_, _, err := Build(data.Session{ID: "done-id", State: "completed", CWD: t.TempDir()}, data.Launcher{Backend: "claude"})
	if err == nil || !strings.Contains(err.Error(), "done") {
		t.Fatalf("error = %v, want done refusal", err)
	}
}

func TestBuildFallsBackToProjectRoot(t *testing.T) {
	root := t.TempDir()
	command, note, err := Build(data.Session{ResumeID: "id", CWD: root + "/gone", ProjectRoot: root}, data.Launcher{Backend: "claude"})
	if err != nil {
		t.Fatal(err)
	}
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
