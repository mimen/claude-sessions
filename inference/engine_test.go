package inference

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolvePrefersCodexThenFallsBack(t *testing.T) {
	bin := t.TempDir()
	writeExecutable(t, filepath.Join(bin, "codex"))
	writeExecutable(t, filepath.Join(bin, "claude"))
	t.Setenv("PATH", bin)
	t.Setenv("CCS_ROOT", t.TempDir())
	engine, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if engine.Name != Codex {
		t.Fatalf("engine = %s, want codex", engine.Name)
	}

	if err := os.Remove(filepath.Join(bin, "codex")); err != nil {
		t.Fatal(err)
	}
	engine, err = Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if engine.Name != Claude {
		t.Fatalf("engine = %s, want claude", engine.Name)
	}
}

func TestResolveHonorsInstalledExplicitEngine(t *testing.T) {
	bin := t.TempDir()
	writeExecutable(t, filepath.Join(bin, "codex"))
	writeExecutable(t, filepath.Join(bin, "claude"))
	t.Setenv("PATH", bin)
	t.Setenv("CCS_ROOT", t.TempDir())
	t.Setenv("CCS_INFERENCE_ENGINE", "claude")
	engine, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if engine.Name != Claude {
		t.Fatalf("engine = %s, want claude", engine.Name)
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
}
