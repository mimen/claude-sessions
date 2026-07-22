package data

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

type cmuxTree struct {
	Windows []cmuxWindow `json:"windows"`
}

type cmuxWindow struct {
	Workspaces []cmuxWorkspace `json:"workspaces"`
}

type cmuxWorkspace struct {
	ID    string     `json:"id"`
	Title string     `json:"title"`
	Panes []cmuxPane `json:"panes"`
}

type cmuxPane struct {
	Surfaces []cmuxSurface `json:"surfaces"`
}

type cmuxSurface struct {
	ID string `json:"id"`
}

type hookStore struct {
	Sessions                map[string]hookSession `json:"sessions"`
	ActiveSessionsBySurface map[string]hookBinding `json:"activeSessionsBySurface"`
}

type hookSession struct {
	SurfaceID string  `json:"surfaceId"`
	PID       *int    `json:"pid"`
	UpdatedAt float64 `json:"updatedAt"`
}

type hookBinding struct {
	SessionID string `json:"sessionId"`
}

type liveSession struct {
	SessionID string
	Title     string
}

type surfaceWinner struct {
	SessionID string
	Detail    hookSession
}

func loadLiveSessions(home string) (map[string]liveSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "cmux", "tree", "--all", "--json", "--id-format", "both")
	treeJSON, err := command.Output()
	if err != nil {
		return map[string]liveSession{}, fmt.Errorf("read cmux tree: %w", err)
	}
	var tree cmuxTree
	if err := json.Unmarshal(treeJSON, &tree); err != nil {
		return map[string]liveSession{}, fmt.Errorf("decode cmux tree: %w", err)
	}
	storePath := filepath.Join(home, ".cmuxterm", "claude-hook-sessions.json")
	storeJSON, err := os.ReadFile(storePath)
	if err != nil {
		return map[string]liveSession{}, fmt.Errorf("read cmux hook store: %w", err)
	}
	var store hookStore
	if err := json.Unmarshal(storeJSON, &store); err != nil {
		return map[string]liveSession{}, fmt.Errorf("decode cmux hook store: %w", err)
	}

	winners := make(map[string]surfaceWinner)
	for sessionID, detail := range store.Sessions {
		if sessionID == "" || detail.SurfaceID == "" {
			continue
		}
		candidate := surfaceWinner{SessionID: sessionID, Detail: detail}
		current, exists := winners[detail.SurfaceID]
		if !exists || winnerPrecedes(candidate, current) {
			winners[detail.SurfaceID] = candidate
		}
	}
	for surfaceID, binding := range store.ActiveSessionsBySurface {
		if surfaceID == "" || binding.SessionID == "" {
			continue
		}
		if _, exists := winners[surfaceID]; exists {
			continue
		}
		winners[surfaceID] = surfaceWinner{
			SessionID: binding.SessionID,
			Detail:    store.Sessions[binding.SessionID],
		}
	}

	surfaces := make(map[string]string)
	for _, window := range tree.Windows {
		for _, workspace := range window.Workspaces {
			for _, pane := range workspace.Panes {
				for _, surface := range pane.Surfaces {
					if surface.ID != "" {
						surfaces[surface.ID] = workspace.Title
					}
				}
			}
		}
	}

	live := make(map[string]liveSession)
	for surfaceID, winner := range winners {
		title, exists := surfaces[surfaceID]
		if !exists {
			continue
		}
		if winner.Detail.PID != nil && !processAlive(*winner.Detail.PID) {
			continue
		}
		sessionID := normalizeInline(winner.SessionID)
		if sessionID == "" {
			continue
		}
		live[sessionID] = liveSession{SessionID: sessionID, Title: normalizeInline(title)}
	}
	return live, nil
}

func winnerPrecedes(candidate surfaceWinner, current surfaceWinner) bool {
	candidateValid := candidate.Detail.UpdatedAt > 0
	currentValid := current.Detail.UpdatedAt > 0
	if candidateValid != currentValid {
		return candidateValid
	}
	if candidateValid && candidate.Detail.UpdatedAt != current.Detail.UpdatedAt {
		return candidate.Detail.UpdatedAt > current.Detail.UpdatedAt
	}
	return candidate.SessionID < current.SessionID
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
