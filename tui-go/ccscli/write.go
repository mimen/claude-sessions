// Package ccscli owns TUI shell-outs to ccs; every metadata mutation crosses this boundary.
package ccscli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/mimen/claude-sessions/tui-go/inference"
)

// Run executes one ccs command without involving a shell.
func Run(ctx context.Context, args ...string) (string, error) {
	binary := strings.TrimSpace(os.Getenv("CCS_BINARY"))
	if binary == "" {
		binary = "ccs"
	}
	command := exec.CommandContext(ctx, binary, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("ccs %s timed out", strings.Join(args, " "))
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return strings.TrimSpace(stdout.String()), fmt.Errorf("ccs %s: %s", strings.Join(args, " "), message)
	}
	return strings.TrimSpace(stdout.String()), nil
}

func ensureCatalogued(ctx context.Context, sessionID string) error {
	output, err := Run(ctx, "session", sessionID, "--json")
	if err != nil {
		return fmt.Errorf("inspect session before write: %w", err)
	}
	var state struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return fmt.Errorf("decode ccs session state: %w", err)
	}
	switch state.State {
	case "catalogued":
		return nil
	case "indexed-unattached":
		_, err := Run(ctx, "session-fields", sessionID, "--json", `{"customTitle":null}`)
		if err != nil {
			return fmt.Errorf("materialize catalogue row through ccs: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("ccs returned unsupported session state %q", state.State)
	}
}

// SetTitle uses the preferred per-session title command.
func SetTitle(ctx context.Context, sessionID string, title string) error {
	if err := ensureCatalogued(ctx, sessionID); err != nil {
		return err
	}
	_, err := Run(ctx, "session", "title", sessionID, title)
	return err
}

// MarkCompleted changes per-session completion state through ccs mark.
func MarkCompleted(ctx context.Context, sessionID string, enabled bool) error {
	if err := ensureCatalogued(ctx, sessionID); err != nil {
		return err
	}
	args := []string{"mark", sessionID, "--completed"}
	if !enabled {
		args = append(args, "--off")
	}
	_, err := Run(ctx, args...)
	return err
}

// MarkArchived changes per-session archive state through ccs mark.
func MarkArchived(ctx context.Context, sessionID string, enabled bool) error {
	if err := ensureCatalogued(ctx, sessionID); err != nil {
		return err
	}
	args := []string{"mark", sessionID, "--archived"}
	if !enabled {
		args = append(args, "--off")
	}
	_, err := Run(ctx, args...)
	return err
}

// ApplyMutation maps a validated AI mutation to one existing ccs CLI primitive.
func ApplyMutation(ctx context.Context, mutation inference.MetadataMutation) error {
	switch mutation.Op {
	case "title":
		if mutation.Value == nil {
			if err := ensureCatalogued(ctx, mutation.SessionID); err != nil {
				return err
			}
			_, err := Run(ctx, "session", "unset", mutation.SessionID, "--title")
			return err
		}
		return SetTitle(ctx, mutation.SessionID, *mutation.Value)
	case "completed":
		return MarkCompleted(ctx, mutation.SessionID, mutation.Enabled != nil && *mutation.Enabled)
	case "archived":
		return MarkArchived(ctx, mutation.SessionID, mutation.Enabled != nil && *mutation.Enabled)
	case "parent", "parked", "identity":
		if err := ensureCatalogued(ctx, mutation.SessionID); err != nil {
			return err
		}
		flag := "--" + mutation.Op
		if mutation.Value == nil {
			_, err := Run(ctx, "session", "unset", mutation.SessionID, flag)
			return err
		}
		_, err := Run(ctx, "session", "set", mutation.SessionID, flag+"="+*mutation.Value)
		return err
	case "identity_field":
		if mutation.IdentityKey == "" {
			return errors.New("identity_field mutation has no identity key")
		}
		if mutation.Value == nil {
			_, err := Run(ctx, "identity", "set", mutation.IdentityKey, "--unset="+mutation.Field)
			return err
		}
		_, err := Run(ctx, "identity", "set", mutation.IdentityKey, "--"+mutation.Field+"="+*mutation.Value)
		return err
	default:
		return fmt.Errorf("unsupported metadata mutation %q", mutation.Op)
	}
}

// ApplyMutations applies each validated mutation separately, preserving the CLI invariant boundary.
func ApplyMutations(ctx context.Context, mutations []inference.MetadataMutation) error {
	for index, mutation := range mutations {
		if err := ApplyMutation(ctx, mutation); err != nil {
			return fmt.Errorf("mutation %d/%d: %w", index+1, len(mutations), err)
		}
	}
	return nil
}

// ArchiveBatch applies an approved cleanup set one ccs mark command at a time.
func ArchiveBatch(ctx context.Context, sessionIDs []string) error {
	for index, sessionID := range sessionIDs {
		if err := MarkArchived(ctx, sessionID, true); err != nil {
			return fmt.Errorf("archive %d/%d: %w", index+1, len(sessionIDs), err)
		}
	}
	return nil
}
