// Package transcript normalizes Claude-native and gateway session JSONL.
package transcript

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

// Kind controls transcript reader labels and colors.
type Kind string

const (
	KindUser      Kind = "user"
	KindAssistant Kind = "assistant"
	KindTool      Kind = "tool"
	KindMeta      Kind = "meta"
)

// Line is one normalized logical transcript line.
type Line struct {
	Kind Kind
	Text string
}

// Document is a bounded transcript plus its source metadata.
type Document struct {
	Lines     []Line
	Truncated bool
	Format    string
}

type envelope struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Text    string          `json:"text"`
	Name    string          `json:"name"`
	Message json.RawMessage `json:"message"`
	Item    json.RawMessage `json:"item"`
}

type message struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Name    string          `json:"name"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Arguments json.RawMessage `json:"arguments"`
	Content   json.RawMessage `json:"content"`
	Output    json.RawMessage `json:"output"`
}

// Read streams a JSONL transcript and retains the most recent maxMessages rendered turns.
// A zero/negative limit uses 2,000 turns. Corrupt records are skipped.
func Read(path string, maxMessages int) (Document, error) {
	if maxMessages <= 0 {
		maxMessages = 2000
	}
	file, err := os.Open(path)
	if err != nil {
		return Document{}, fmt.Errorf("open transcript: %w", err)
	}
	defer file.Close()
	return scanDocument(file, maxMessages, false)
}

// ReadAll streams and normalizes the entire transcript for the explicit full reader.
func ReadAll(path string) (Document, error) {
	file, err := os.Open(path)
	if err != nil {
		return Document{}, fmt.Errorf("open transcript: %w", err)
	}
	defer file.Close()
	return scanDocument(file, 0, false)
}

// ReadRecent reads only the byte tail before normalizing the most recent turns. It is used for
// fleet-wide inference so a query never rescans hundreds of multi-megabyte transcripts.
func ReadRecent(path string, maxMessages int, maxBytes int64) (Document, error) {
	if maxBytes <= 0 {
		maxBytes = 2 * 1024 * 1024
	}
	file, err := os.Open(path)
	if err != nil {
		return Document{}, fmt.Errorf("open transcript: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Document{}, fmt.Errorf("stat transcript: %w", err)
	}
	offset := info.Size() - maxBytes
	partial := offset > 0
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, 0); err != nil {
		return Document{}, fmt.Errorf("seek transcript tail: %w", err)
	}
	return scanDocument(file, maxMessages, partial)
}

// RecentText returns a bounded, role-labelled tail for inference prompts.
func RecentText(path string, maxMessages int, maxChars int) (string, error) {
	document, err := ReadRecent(path, maxMessages, 2*1024*1024)
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	for _, line := range document.Lines {
		if line.Text == "" {
			continue
		}
		label := string(line.Kind)
		if line.Kind == KindAssistant {
			label = "assistant"
		}
		builder.WriteString(label)
		builder.WriteString(": ")
		builder.WriteString(line.Text)
		builder.WriteByte('\n')
	}
	text := strings.TrimSpace(builder.String())
	if maxChars > 0 {
		runes := []rune(text)
		if len(runes) > maxChars {
			text = string(runes[len(runes)-maxChars:])
			if newline := strings.IndexByte(text, '\n'); newline >= 0 {
				text = text[newline+1:]
			}
		}
	}
	return text, nil
}

func scanDocument(file *os.File, maxMessages int, discardFirstPartial bool) (Document, error) {
	capacity := 256
	if maxMessages > 0 {
		capacity = min(maxMessages, capacity)
	}
	turns := make([][]Line, 0, capacity)
	truncated := discardFirstPartial
	format := "unknown"
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	if discardFirstPartial {
		scanner.Scan()
	}
	for scanner.Scan() {
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		lines, observedFormat := parseRecord([]byte(raw))
		if len(lines) == 0 {
			continue
		}
		if format == "unknown" && observedFormat != "" {
			format = observedFormat
		} else if observedFormat != "" && format != observedFormat {
			format = "mixed"
		}
		if maxMessages > 0 && len(turns) == maxMessages {
			copy(turns, turns[1:])
			turns[len(turns)-1] = lines
			truncated = true
		} else {
			turns = append(turns, lines)
		}
	}
	if err := scanner.Err(); err != nil {
		return Document{}, fmt.Errorf("read transcript: %w", err)
	}
	lines := make([]Line, 0, len(turns)*2)
	for _, turn := range turns {
		lines = append(lines, turn...)
		lines = append(lines, Line{Kind: KindMeta})
	}
	return Document{Lines: lines, Truncated: truncated, Format: format}, nil
}

func parseRecord(raw []byte) ([]Line, string) {
	var top envelope
	if json.Unmarshal(raw, &top) != nil {
		return nil, ""
	}
	if top.Type == "user" || top.Type == "assistant" {
		var msg message
		if len(top.Message) > 0 && json.Unmarshal(top.Message, &msg) == nil {
			return renderContent(roleKind(top.Type), msg.Content), "claude-jsonl"
		}
		if len(top.Content) > 0 {
			return renderContent(roleKind(top.Type), top.Content), "gateway-jsonl"
		}
	}
	if top.Role == "user" || top.Role == "assistant" {
		return renderContent(roleKind(top.Role), top.Content), "gateway-jsonl"
	}
	if strings.HasPrefix(top.Type, "response.output_text") || top.Type == "output_text" {
		if text := cleanText(top.Text); text != "" {
			return []Line{{Kind: KindAssistant, Text: text}}, "openai-responses-jsonl"
		}
	}
	if len(top.Item) > 0 {
		var item message
		if json.Unmarshal(top.Item, &item) == nil && (item.Role == "user" || item.Role == "assistant") {
			return renderContent(roleKind(item.Role), item.Content), "openai-responses-jsonl"
		}
		var itemBlock block
		if json.Unmarshal(top.Item, &itemBlock) == nil {
			return renderBlocks(roleKind(item.Role), []block{itemBlock}), "openai-responses-jsonl"
		}
	}
	return nil, ""
}

func renderContent(kind Kind, raw json.RawMessage) []Line {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if text = cleanText(text); text != "" {
			return []Line{{Kind: kind, Text: text}}
		}
		return nil
	}
	var blocks []block
	if json.Unmarshal(raw, &blocks) == nil {
		return renderBlocks(kind, blocks)
	}
	var one block
	if json.Unmarshal(raw, &one) == nil {
		return renderBlocks(kind, []block{one})
	}
	return nil
}

func renderBlocks(kind Kind, blocks []block) []Line {
	lines := make([]Line, 0, len(blocks))
	for _, item := range blocks {
		switch item.Type {
		case "text", "input_text", "output_text":
			if text := cleanText(item.Text); text != "" {
				lines = append(lines, Line{Kind: kind, Text: text})
			}
		case "tool_use", "function_call":
			name := cleanInline(item.Name)
			if name == "" {
				name = "tool"
			}
			input := item.Input
			if len(input) == 0 {
				input = item.Arguments
			}
			detail := summarizeInput(input)
			if detail != "" {
				detail = " " + detail
			}
			lines = append(lines, Line{Kind: KindTool, Text: "→ " + name + detail})
		case "tool_result", "function_call_output":
			detail := summarizeResult(item.Content)
			if detail == "" {
				detail = summarizeResult(item.Output)
			}
			if detail != "" {
				detail = " " + detail
			}
			lines = append(lines, Line{Kind: KindTool, Text: "← tool result" + detail})
		case "image", "input_image":
			lines = append(lines, Line{Kind: KindMeta, Text: "[image]"})
		case "thinking", "reasoning":
			// Deliberately omitted from the reader and inference payload.
		default:
			if text := cleanText(item.Text); text != "" {
				lines = append(lines, Line{Kind: kind, Text: text})
			}
		}
	}
	return lines
}

func summarizeInput(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return truncateInline(text, 120)
		}
		return ""
	}
	for _, key := range []string{"command", "file_path", "path", "pattern", "query", "url"} {
		var text string
		if value, ok := values[key]; ok && json.Unmarshal(value, &text) == nil {
			return truncateInline(text, 120)
		}
	}
	return ""
}

func summarizeResult(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return truncateInline(text, 100)
	}
	return ""
}

func cleanText(value string) string {
	value = ansi.Strip(value)
	value = strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\t':
			return r
		default:
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}
	}, value)
	return strings.TrimSpace(value)
}

func cleanInline(value string) string {
	return strings.Join(strings.Fields(cleanText(value)), " ")
}

func truncateInline(value string, limit int) string {
	value = cleanInline(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit-1]) + "…"
}

func roleKind(role string) Kind {
	if role == "user" {
		return KindUser
	}
	return KindAssistant
}

func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
