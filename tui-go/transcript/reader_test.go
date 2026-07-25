package transcript

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTranscript(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadNormalizesClaudeAndGatewayRecords(t *testing.T) {
	path := writeTranscript(t,
		`{"type":"user","message":{"role":"user","content":"hello"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"native answer"},{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]}}`,
		`{"role":"assistant","content":[{"type":"output_text","text":"gateway answer"}]}`,
	)
	document, err := Read(path, 20)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, line := range document.Lines {
		if line.Text != "" {
			texts = append(texts, string(line.Kind)+":"+line.Text)
		}
	}
	got := strings.Join(texts, "|")
	for _, want := range []string{"user:hello", "assistant:native answer", "tool:→ Bash go test ./...", "assistant:gateway answer"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q does not contain %q", got, want)
		}
	}
	if document.Format != "mixed" {
		t.Fatalf("format = %q, want mixed", document.Format)
	}
}

func TestReadSupportsOpenAIResponsesEvents(t *testing.T) {
	path := writeTranscript(t,
		`{"type":"response.output_text.done","text":"done text"}`,
		`{"type":"response.output_item.done","item":{"role":"assistant","content":[{"type":"output_text","text":"item text"}]}}`,
	)
	document, err := Read(path, 20)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, line := range document.Lines {
		joined += line.Text
	}
	if !strings.Contains(joined, "done text") || !strings.Contains(joined, "item text") {
		t.Fatalf("joined = %q", joined)
	}
}

func TestReadAllRetainsEveryTurn(t *testing.T) {
	path := writeTranscript(t,
		`{"type":"user","message":{"content":"one"}}`,
		`{"type":"assistant","message":{"content":"two"}}`,
		`{"type":"user","message":{"content":"three"}}`,
	)
	document, err := ReadAll(path)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, line := range document.Lines {
		joined += line.Text
	}
	if document.Truncated || !strings.Contains(joined, "one") || !strings.Contains(joined, "two") || !strings.Contains(joined, "three") {
		t.Fatalf("unexpected full document: %+v", document)
	}
}

func TestReadRetainsRecentBoundedTurns(t *testing.T) {
	path := writeTranscript(t,
		`{"type":"user","message":{"content":"one"}}`,
		`{"type":"assistant","message":{"content":"two"}}`,
		`{"type":"user","message":{"content":"three"}}`,
	)
	document, err := Read(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, line := range document.Lines {
		joined += line.Text
	}
	if !document.Truncated || strings.Contains(joined, "one") || !strings.Contains(joined, "two") || !strings.Contains(joined, "three") {
		t.Fatalf("unexpected bounded document: %+v", document)
	}
}
