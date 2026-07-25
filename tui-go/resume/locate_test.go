package resume

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccsspike/data"
)

func TestEncodePathMatchesClaudeStorageEncoding(t *testing.T) {
	if got := encodePath("/Users/Milad/a-b_日本"); got != "-Users-Milad-a-b---" {
		t.Fatalf("encodePath = %q", got)
	}
}

func TestResolveCWDUsesStorageFolderMapping(t *testing.T) {
	actual := t.TempDir()
	real, err := filepath.EvalSymlinks(actual)
	if err != nil {
		t.Fatal(err)
	}
	folder := encodePath(real)
	session := data.Session{
		CWD:  filepath.Join(t.TempDir(), "wrong"),
		Path: filepath.Join(t.TempDir(), "projects", folder, "session.jsonl"),
	}
	cwd, note, err := resolveCWD(session)
	if err != nil {
		t.Fatal(err)
	}
	if cwd != real {
		t.Fatalf("cwd = %q, want %q", cwd, real)
	}
	if !strings.Contains(note, "recorded cwd") {
		t.Fatalf("note = %q", note)
	}
}

func TestResolveCWDRecreatesDeletedExactAnchor(t *testing.T) {
	anchor := filepath.Join(t.TempDir(), "deleted-worktree")
	realParent, err := filepath.EvalSymlinks(filepath.Dir(anchor))
	if err != nil {
		t.Fatal(err)
	}
	realAnchor := filepath.Join(realParent, filepath.Base(anchor))
	folder := encodePath(realAnchor)
	session := data.Session{CWD: anchor, Path: filepath.Join(t.TempDir(), "projects", folder, "session.jsonl")}
	cwd, note, err := resolveCWD(session)
	if err != nil {
		t.Fatal(err)
	}
	if cwd != anchor || !strings.Contains(note, "recreated") {
		t.Fatalf("cwd=%q note=%q", cwd, note)
	}
	info, err := os.Stat(anchor)
	if err != nil || !info.IsDir() {
		t.Fatalf("anchor was not recreated: %v", err)
	}
}

func TestDecodeStorageFolderDetectsAmbiguity(t *testing.T) {
	root := t.TempDir()
	left := filepath.Join(root, "a-b")
	right := filepath.Join(root, "a", "b")
	for _, path := range []string{left, right} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	realLeft, err := filepath.EvalSymlinks(left)
	if err != nil {
		t.Fatal(err)
	}
	folder := encodePath(realLeft)
	located, err := decodeStorageFolder(folder)
	if err != nil {
		t.Fatal(err)
	}
	if located == nil || located.AmbiguousWith == "" {
		t.Fatalf("located = %+v, want two verified matches", located)
	}
	matches := map[string]bool{located.Dir: true, located.AmbiguousWith: true}
	realRight, err := filepath.EvalSymlinks(right)
	if err != nil {
		t.Fatal(err)
	}
	if !matches[realLeft] || !matches[realRight] {
		t.Fatalf("matches = %v, want %q and %q", matches, realLeft, realRight)
	}
}
