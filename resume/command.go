// Package resume builds and runs the interactive handoff selected in the TUI.
package resume

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"ccsspike/data"
)

// Command is a fully resolved resume invocation.
type Command struct {
	Argv []string
	CWD  string
	Env  map[string]string
}

// Build constructs the origin/cross-backend resume command from indexed metadata.
func Build(session data.Session, launcher data.Launcher) (Command, string, error) {
	cwd, note, err := resolveCWD(session)
	if err != nil {
		return Command{}, "", err
	}
	binary := strings.TrimSpace(launcher.Backend)
	if binary == "" {
		binary = "claude"
	}
	resumeID := strings.TrimSpace(session.ResumeID)
	if resumeID == "" {
		resumeID = session.ID
	}
	return Command{
		Argv: []string{binary, "--resume", resumeID},
		CWD:  cwd,
		Env:  copyEnv(launcher.Env),
	}, note, nil
}

// RunInline hands stdin/stdout/stderr to the interactive launcher.
func RunInline(command Command) error {
	if len(command.Argv) == 0 {
		return errors.New("empty resume command")
	}
	cmd := exec.Command(command.Argv[0], command.Argv[1:]...)
	cmd.Dir = command.CWD
	cmd.Env = mergeEnv(os.Environ(), command.Env)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return fmt.Errorf("%s exited %d", command.Argv[0], exitError.ExitCode())
		}
		return fmt.Errorf("run %s: %w", command.Argv[0], err)
	}
	return nil
}

// FocusLive switches cmux to the exact workspace/window already running a session.
func FocusLive(session data.Session) error {
	if session.LiveWorkspaceRef == "" || session.LiveWindowRef == "" {
		return errors.New("session has no live cmux location")
	}
	binary := strings.TrimSpace(os.Getenv("CMUX_BIN"))
	if binary == "" {
		binary = "cmux"
	}
	selectCtx, cancelSelect := context.WithTimeout(context.Background(), 3*time.Second)
	selectCommand := exec.CommandContext(selectCtx, binary, "select-workspace", "--workspace", session.LiveWorkspaceRef, "--window", session.LiveWindowRef)
	output, err := selectCommand.CombinedOutput()
	cancelSelect()
	if err != nil {
		return fmt.Errorf("focus live workspace: %s", commandOutput(output, err))
	}
	focusCtx, cancelFocus := context.WithTimeout(context.Background(), 3*time.Second)
	focusCommand := exec.CommandContext(focusCtx, binary, "focus-window", "--window", session.LiveWindowRef)
	output, err = focusCommand.CombinedOutput()
	cancelFocus()
	if err != nil {
		return fmt.Errorf("focus live window: %s", commandOutput(output, err))
	}
	return nil
}

// OpenCmux starts the resume in a focused workspace without taking over this terminal.
func OpenCmux(command Command, title string) error {
	if len(command.Argv) == 0 {
		return errors.New("empty resume command")
	}
	args := []string{
		"new-workspace",
		"--name", cleanTitle(title),
		"--cwd", command.CWD,
		"--command", Shell(command),
		"--focus", "true",
	}
	binary := strings.TrimSpace(os.Getenv("CMUX_BIN"))
	if binary == "" {
		binary = "cmux"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("open cmux workspace: %s", commandOutput(output, err))
	}
	return nil
}

// Shell returns a safely quoted POSIX command for cmux's integrated shell.
func Shell(command Command) string {
	parts := make([]string, 0, len(command.Argv)+len(command.Env)+1)
	if len(command.Env) > 0 {
		parts = append(parts, "env")
		keys := make([]string, 0, len(command.Env))
		for key := range command.Env {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			parts = append(parts, key+"="+shellQuote(command.Env[key]))
		}
	}
	for _, arg := range command.Argv {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func isDirectory(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(filepath.Clean(path))
	return err == nil && info.IsDir()
}

var safeShellArg = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

func shellQuote(value string) string {
	if safeShellArg.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func mergeEnv(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}
	values := make(map[string]string, len(base)+len(extra))
	for _, pair := range base {
		key, value, found := strings.Cut(pair, "=")
		if found {
			values[key] = value
		}
	}
	for key, value := range extra {
		values[key] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+values[key])
	}
	return out
}

func copyEnv(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	out := make(map[string]string, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func commandOutput(output []byte, err error) string {
	message := strings.TrimSpace(string(output))
	if message == "" {
		message = err.Error()
	}
	return message
}

func cleanTitle(title string) string {
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		return "ccs resume"
	}
	if len([]rune(title)) <= 80 {
		return title
	}
	return string([]rune(title)[:79]) + "…"
}
