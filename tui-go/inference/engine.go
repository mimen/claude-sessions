// Package inference is the single structured model-call seam for ccs-go.
package inference

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// Name identifies one CCS-compatible inference backend.
type Name string

const (
	Codex  Name = "codex"
	Claude Name = "claude"
)

// Engine runs schema-forced, non-agentic inference through an installed CLI.
type Engine struct {
	Name            Name
	Binary          string
	Model           string
	ReasoningEffort string
}

type configFile struct {
	Inference struct {
		Engine string `toml:"engine"`
		Codex  struct {
			Binary          string `toml:"binary"`
			Model           string `toml:"model"`
			ReasoningEffort string `toml:"reasoningEffort"`
		} `toml:"codex"`
		Claude struct {
			Binary string `toml:"binary"`
			Model  string `toml:"model"`
		} `toml:"claude"`
	} `toml:"inference"`
}

// Resolve mirrors CCS engine.ts: env/config preference, otherwise Codex first and Claude fallback.
func Resolve() (Engine, error) {
	config, err := loadConfig()
	if err != nil {
		return Engine{}, err
	}
	codex := Engine{Name: Codex, Binary: "codex", ReasoningEffort: "low"}
	claude := Engine{Name: Claude, Binary: "claude", Model: "haiku"}
	if value := strings.TrimSpace(config.Inference.Codex.Binary); value != "" {
		codex.Binary = value
	}
	codex.Model = strings.TrimSpace(config.Inference.Codex.Model)
	if value := strings.TrimSpace(config.Inference.Codex.ReasoningEffort); value != "" {
		codex.ReasoningEffort = value
	}
	if value := strings.TrimSpace(config.Inference.Claude.Binary); value != "" {
		claude.Binary = value
	}
	if config.Inference.Claude.Model != "" {
		claude.Model = strings.TrimSpace(config.Inference.Claude.Model)
	}

	engines := []Engine{codex, claude}
	requested := normalizeName(os.Getenv("CCS_INFERENCE_ENGINE"))
	if requested == "" {
		requested = normalizeName(config.Inference.Engine)
	}
	if requested != "" && requested != "auto" {
		for _, engine := range engines {
			if string(engine.Name) == requested && engine.available() {
				return engine, nil
			}
		}
	}
	for _, engine := range engines {
		if engine.available() {
			return engine, nil
		}
	}
	return Engine{}, errors.New("no inference engine (codex/claude) found on PATH")
}

// RunStructured invokes one engine with an output schema and returns its decoded JSON object.
func (e Engine) RunStructured(ctx context.Context, prompt string, stdin string, schema []byte) (json.RawMessage, error) {
	if len(schema) == 0 {
		return nil, errors.New("empty output schema")
	}
	if !json.Valid(schema) {
		return nil, errors.New("invalid output schema")
	}
	switch e.Name {
	case Codex:
		return e.runCodex(ctx, prompt, stdin, schema)
	case Claude:
		return e.runClaude(ctx, prompt, stdin, schema)
	default:
		return nil, fmt.Errorf("unsupported inference engine %q", e.Name)
	}
}

func (e Engine) runCodex(ctx context.Context, prompt string, stdin string, schema []byte) (json.RawMessage, error) {
	dir, err := os.MkdirTemp("", "ccs-go-infer-")
	if err != nil {
		return nil, fmt.Errorf("create inference temp dir: %w", err)
	}
	defer os.RemoveAll(dir)
	schemaPath := filepath.Join(dir, "schema.json")
	outputPath := filepath.Join(dir, "output.json")
	if err := os.WriteFile(schemaPath, schema, 0o600); err != nil {
		return nil, fmt.Errorf("write inference schema: %w", err)
	}
	args := []string{
		"exec",
		"--ephemeral",
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"--ignore-rules",
		"--ignore-user-config",
		"-c", fmt.Sprintf("model_reasoning_effort=%q", e.ReasoningEffort),
		"--output-schema", schemaPath,
		"--output-last-message", outputPath,
	}
	if e.Model != "" {
		args = append(args, "-m", e.Model)
	}
	args = append(args, prompt)
	command := exec.CommandContext(ctx, e.Binary, args...)
	command.Stdin = strings.NewReader(stdin)
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Run(); err != nil {
		return nil, commandError(e.Name, ctx, err)
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("read %s structured output: %w", e.Name, err)
	}
	if !json.Valid(output) {
		return nil, fmt.Errorf("%s returned invalid JSON", e.Name)
	}
	return json.RawMessage(output), nil
}

func (e Engine) runClaude(ctx context.Context, prompt string, stdin string, schema []byte) (json.RawMessage, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, schema); err != nil {
		return nil, fmt.Errorf("compact inference schema: %w", err)
	}
	args := []string{
		"-p",
		"--no-session-persistence",
		"--strict-mcp-config",
		"--output-format", "json",
		"--json-schema", compact.String(),
	}
	if e.Model != "" {
		args = append(args, "--model", e.Model)
	}
	args = append(args, prompt)
	command := exec.CommandContext(ctx, e.Binary, args...)
	command.Stdin = strings.NewReader(stdin)
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = nil
	if err := command.Run(); err != nil {
		return nil, commandError(e.Name, ctx, err)
	}
	var envelope struct {
		Structured json.RawMessage `json:"structured_output"`
		Result     json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		return nil, fmt.Errorf("decode claude result envelope: %w", err)
	}
	if len(envelope.Structured) > 0 && string(envelope.Structured) != "null" {
		return envelope.Structured, nil
	}
	var result string
	if json.Unmarshal(envelope.Result, &result) == nil && json.Valid([]byte(result)) {
		return json.RawMessage(result), nil
	}
	return nil, errors.New("claude returned no structured output")
}

func (e Engine) available() bool {
	if strings.TrimSpace(e.Binary) == "" {
		return false
	}
	_, err := exec.LookPath(e.Binary)
	return err == nil
}

func loadConfig() (configFile, error) {
	var config configFile
	root := strings.TrimSpace(os.Getenv("CCS_ROOT"))
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return config, fmt.Errorf("resolve home directory: %w", err)
		}
		root = filepath.Join(home, ".ccs")
	}
	contents, err := os.ReadFile(filepath.Join(root, "config.toml"))
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, fmt.Errorf("read inference config: %w", err)
	}
	if err := toml.Unmarshal(contents, &config); err != nil {
		return config, fmt.Errorf("parse inference config: %w", err)
	}
	return config, nil
}

func normalizeName(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "codex":
		return "codex"
	case "claude":
		return "claude"
	case "auto":
		return "auto"
	default:
		return ""
	}
}

func commandError(name Name, ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out", name)
	}
	return fmt.Errorf("%s inference failed: %w", name, err)
}

// WithTimeout creates the standard bounded inference context.
func WithTimeout(parent context.Context, duration time.Duration) (context.Context, context.CancelFunc) {
	if duration <= 0 {
		duration = 90 * time.Second
	}
	return context.WithTimeout(parent, duration)
}
