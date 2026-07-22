package ccscli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ccsspike/inference"
)

func TestApplyMutationShellsToCCS(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "calls")
	binary := filepath.Join(t.TempDir(), "ccs")
	script := "#!/bin/sh\nif [ \"$1\" = session ] && [ \"$3\" = --json ]; then printf '{\"state\":\"catalogued\"}'; exit 0; fi\nprintf '%s\\n' \"$*\" >> " + shellPath(logPath) + "\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_BINARY", binary)
	title := "A title with spaces"
	done := true
	fieldValue := "approved"
	mutations := []inference.MetadataMutation{
		{SessionID: "sid", Op: "title", Value: &title},
		{SessionID: "sid", Op: "completed", Enabled: &done},
		{SessionID: "sid", IdentityKey: "event:worker:key", Op: "identity_field", Field: "meta.review", Value: &fieldValue},
	}
	if err := ApplyMutations(context.Background(), mutations); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	got := string(contents)
	for _, want := range []string{
		"session title sid A title with spaces",
		"mark sid --completed",
		"identity set event:worker:key --meta.review=approved",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("calls %q missing %q", got, want)
		}
	}
}

func TestWriteMaterializesIndexedUnattachedSessionThroughCCS(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "calls")
	binary := filepath.Join(t.TempDir(), "ccs")
	script := "#!/bin/sh\nif [ \"$1\" = session ] && [ \"$3\" = --json ]; then printf '{\"state\":\"indexed-unattached\"}'; exit 0; fi\nprintf '%s\\n' \"$*\" >> " + shellPath(logPath) + "\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_BINARY", binary)
	if err := MarkArchived(context.Background(), "loose", true); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	got := string(contents)
	if got != "session-fields loose --json {\"customTitle\":null}\nmark loose --archived\n" {
		t.Fatalf("calls = %q", got)
	}
}

func TestUnsetTitleMaterializesIndexedUnattachedSession(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "calls")
	binary := filepath.Join(t.TempDir(), "ccs")
	script := "#!/bin/sh\nif [ \"$1\" = session ] && [ \"$3\" = --json ]; then printf '{\"state\":\"indexed-unattached\"}'; exit 0; fi\nprintf '%s\\n' \"$*\" >> " + shellPath(logPath) + "\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_BINARY", binary)
	if err := ApplyMutation(context.Background(), inference.MetadataMutation{SessionID: "loose", Op: "title"}); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(contents); got != "session-fields loose --json {\"customTitle\":null}\nsession unset loose --title\n" {
		t.Fatalf("calls = %q", got)
	}
}

func TestArchiveBatchUsesIndividualMarkCommands(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "calls")
	binary := filepath.Join(t.TempDir(), "ccs")
	script := "#!/bin/sh\nif [ \"$1\" = session ] && [ \"$3\" = --json ]; then printf '{\"state\":\"catalogued\"}'; exit 0; fi\nprintf '%s\\n' \"$*\" >> " + shellPath(logPath) + "\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCS_BINARY", binary)
	if err := ArchiveBatch(context.Background(), []string{"one", "two"}); err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(logPath)
	if got := string(contents); got != "mark one --archived\nmark two --archived\n" {
		t.Fatalf("calls = %q", got)
	}
}

func shellPath(path string) string {
	return "'" + strings.ReplaceAll(path, "'", "'\\''") + "'"
}
