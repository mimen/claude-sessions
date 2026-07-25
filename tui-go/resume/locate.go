package resume

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/mimen/claude-sessions/tui-go/data"
)

const (
	maxLocateDepth   = 24
	maxLocateNodes   = 5000
	maxLocateMatches = 2
)

type locatedDir struct {
	Dir           string
	AmbiguousWith string
	Exhausted     bool
}

func resolveCWD(session data.Session) (string, string, error) {
	folder := filepath.Base(filepath.Dir(session.Path))
	if folder == "." || folder == string(filepath.Separator) || folder == "" {
		if isDirectory(session.CWD) {
			return session.CWD, "", nil
		}
		return fallbackCWD(session)
	}
	if isDirectory(session.CWD) && encodesTo(session.CWD, folder) {
		return session.CWD, "", nil
	}
	located, err := decodeStorageFolder(folder)
	if err != nil {
		return "", "", fmt.Errorf("locate resume directory: %w", err)
	}
	if located != nil {
		notes := make([]string, 0, 2)
		if session.CWD != "" && located.Dir != session.CWD {
			notes = append(notes, "recorded cwd no longer maps to the transcript; using "+located.Dir)
		}
		if located.AmbiguousWith != "" {
			notes = append(notes, "storage encoding is also matched by "+located.AmbiguousWith)
		}
		if located.Exhausted {
			notes = append(notes, "directory search exhausted its node budget")
		}
		return located.Dir, strings.Join(notes, " · "), nil
	}

	if session.CWD != "" {
		if _, statErr := os.Stat(session.CWD); errors.Is(statErr, os.ErrNotExist) {
			if mkdirErr := os.MkdirAll(session.CWD, 0o755); mkdirErr == nil {
				if encodesTo(session.CWD, folder) {
					return session.CWD, "recreated missing anchor directory to resume", nil
				}
				_ = os.Remove(session.CWD)
			}
		}
	}
	return fallbackCWD(session)
}

func fallbackCWD(session data.Session) (string, string, error) {
	if isDirectory(session.CWD) {
		return session.CWD, "could not confirm transcript storage mapping; using recorded cwd", nil
	}
	if isDirectory(session.ProjectRoot) {
		return session.ProjectRoot, "recorded cwd is gone; using project root", nil
	}
	home, err := os.UserHomeDir()
	if err == nil && isDirectory(home) {
		return home, "recorded cwd and project root are gone; using home", nil
	}
	return ".", "recorded cwd and project root are gone; using current directory", nil
}

func decodeStorageFolder(folder string) (*locatedDir, error) {
	if !strings.HasPrefix(folder, "-") {
		return nil, nil
	}
	if folder == "-" {
		if encodesTo(string(filepath.Separator), folder) {
			return &locatedDir{Dir: string(filepath.Separator)}, nil
		}
		return nil, nil
	}
	matches := make([]string, 0, maxLocateMatches)
	nodes := maxLocateNodes
	exhausted := false
	var rootErr error
	var walk func(base string, remaining string, depth int)
	walk = func(base string, remaining string, depth int) {
		if len(matches) >= maxLocateMatches {
			return
		}
		if depth > maxLocateDepth || nodes <= 0 {
			exhausted = true
			return
		}
		entries, err := os.ReadDir(base)
		if err != nil {
			if depth == 0 {
				rootErr = err
			}
			return
		}
		for _, entry := range entries {
			if len(matches) >= maxLocateMatches {
				return
			}
			if nodes <= 0 {
				exhausted = true
				return
			}
			if !entry.IsDir() {
				continue
			}
			nodes--
			encoded := encodePath(entry.Name())
			full := filepath.Join(base, entry.Name())
			if encoded == remaining {
				if encodesTo(full, folder) {
					matches = append(matches, full)
				}
			} else if strings.HasPrefix(remaining, encoded+"-") {
				walk(full, strings.TrimPrefix(remaining, encoded+"-"), depth+1)
			}
		}
	}
	walk(string(filepath.Separator), strings.TrimPrefix(folder, "-"), 0)
	if rootErr != nil {
		return nil, rootErr
	}
	if len(matches) == 0 {
		return nil, nil
	}
	located := &locatedDir{Dir: matches[0], Exhausted: exhausted}
	if len(matches) > 1 {
		located.AmbiguousWith = matches[1]
	}
	return located, nil
}

func encodesTo(directory string, folder string) bool {
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		resolved = directory
	}
	return encodePath(resolved) == folder
}

func encodePath(path string) string {
	return strings.Map(func(r rune) rune {
		if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			return r
		}
		return '-'
	}, path)
}
