package ui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mimen/claude-sessions/tui-go/ccscli"
	"github.com/mimen/claude-sessions/tui-go/data"
	"github.com/mimen/claude-sessions/tui-go/inference"
	"github.com/mimen/claude-sessions/tui-go/transcript"

	tea "github.com/charmbracelet/bubbletea"
)

type writeFinishedMsg struct {
	preferredID      string
	status           string
	snapshot         data.Snapshot
	loadOptions      data.LoadOptions
	reloaded         bool
	refresh          bool
	silent           bool
	catalogueChecked bool
	completedAt      time.Time
	err              error
}

type metadataProposedMsg struct {
	engine    inference.Name
	mutations []inference.MetadataMutation
	err       error
}

type summaryLoadedMsg struct {
	sessionID string
	engine    inference.Name
	summary   string
	err       error
}

type fleetAskedMsg struct {
	query   string
	engine  inference.Name
	matches []inference.AskMatch
	err     error
}

type cleanupProposedMsg struct {
	engine    inference.Name
	proposals []inference.CleanupProposal
	err       error
}

func setTitleCmd(sessionID string, title string, options data.LoadOptions) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := ccscli.SetTitle(ctx, sessionID, title); err != nil {
			return reloadAfterFailure(options, sessionID, err)
		}
		return reloadAfterWrite(options, sessionID, "retitled → "+title)
	}
}

func markCompletedCmd(sessionID string, preferredID string, options data.LoadOptions) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := ccscli.MarkCompleted(ctx, sessionID, true); err != nil {
			return reloadAfterFailure(options, preferredID, err)
		}
		return reloadAfterWrite(options, preferredID, "marked done")
	}
}

func archiveBatchCmd(sessionIDs []string, preferredID string, status string, options data.LoadOptions) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(30, len(sessionIDs)*10))*time.Second)
		defer cancel()
		if err := ccscli.ArchiveBatch(ctx, sessionIDs); err != nil {
			return reloadAfterFailure(options, preferredID, err)
		}
		return reloadAfterWrite(options, preferredID, status)
	}
}

func markArchivedCmd(sessionID string, enabled bool, preferredID string, status string, options data.LoadOptions) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := ccscli.MarkArchived(ctx, sessionID, enabled); err != nil {
			return reloadAfterFailure(options, preferredID, err)
		}
		return reloadAfterWrite(options, preferredID, status)
	}
}

func applyMutationsCmd(mutations []inference.MetadataMutation, preferredID string, options data.LoadOptions) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(30, len(mutations)*10))*time.Second)
		defer cancel()
		if err := ccscli.ApplyMutations(ctx, mutations); err != nil {
			return reloadAfterFailure(options, preferredID, err)
		}
		return reloadAfterWrite(options, preferredID, fmt.Sprintf("applied %d metadata changes", len(mutations)))
	}
}

func reloadAfterWrite(options data.LoadOptions, preferredID string, status string) writeFinishedMsg {
	snapshot, err := data.Load(options)
	if err != nil {
		return writeFinishedMsg{preferredID: preferredID, status: status, loadOptions: options, err: fmt.Errorf("write succeeded; reload failed: %w", err)}
	}
	return writeFinishedMsg{preferredID: preferredID, status: status, snapshot: snapshot, loadOptions: options, reloaded: true}
}

func reloadAfterFailure(options data.LoadOptions, preferredID string, writeErr error) writeFinishedMsg {
	snapshot, reloadErr := data.Load(options)
	if reloadErr != nil {
		return writeFinishedMsg{preferredID: preferredID, loadOptions: options, err: fmt.Errorf("%w; reload after partial write also failed: %v", writeErr, reloadErr)}
	}
	return writeFinishedMsg{preferredID: preferredID, snapshot: snapshot, loadOptions: options, reloaded: true, err: writeErr}
}

// refreshCmd reloads the read-only caches while keeping the current selection.
// Startup, manual refresh, and a throttled automatic pass also check and heal the
// catalogue; ordinary automatic reloads avoid rescanning the transcript store.
func refreshCmd(options data.LoadOptions, preferredID string, silent bool, checkCatalogue bool) tea.Cmd {
	return func() tea.Msg {
		var snapshot data.Snapshot
		var err error
		if checkCatalogue {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			snapshot, err = ccscli.LoadSnapshot(ctx, options)
		} else {
			snapshot, err = data.Load(options)
		}
		return writeFinishedMsg{
			preferredID:      preferredID,
			status:           "refreshed",
			snapshot:         snapshot,
			loadOptions:      options,
			reloaded:         err == nil,
			refresh:          true,
			silent:           silent,
			catalogueChecked: checkCatalogue,
			completedAt:      time.Now(),
			err:              err,
		}
	}
}

func metadataEditCmd(snapshot data.Snapshot, sessionID string, instruction string) tea.Cmd {
	return func() tea.Msg {
		engine, err := inference.Resolve()
		if err != nil {
			return metadataProposedMsg{err: err}
		}
		ctx, cancel := inference.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		mutations, err := inference.MetadataEdit(ctx, engine, instruction, snapshot.Sessions, sessionID)
		return metadataProposedMsg{engine: engine.Name, mutations: mutations, err: err}
	}
}

func summaryCmd(session data.Session) tea.Cmd {
	return func() tea.Msg {
		engine, err := inference.Resolve()
		if err != nil {
			return summaryLoadedMsg{sessionID: session.ID, err: err}
		}
		recent, err := transcript.RecentText(session.Path, 500, 50_000)
		if err != nil {
			return summaryLoadedMsg{sessionID: session.ID, engine: engine.Name, err: err}
		}
		payload := "INDEXED OPEN/CLOSE SKELETON:\n" + session.Skeleton + "\n\nRECENT NORMALIZED TRANSCRIPT:\n" + recent
		ctx, cancel := inference.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		summary, err := inference.Summarize(ctx, engine, session.Title, payload)
		return summaryLoadedMsg{sessionID: session.ID, engine: engine.Name, summary: summary, err: err}
	}
}

func askFleetCmd(snapshot data.Snapshot, query string) tea.Cmd {
	return func() tea.Msg {
		engine, err := inference.Resolve()
		if err != nil {
			return fleetAskedMsg{query: query, err: err}
		}
		indexes := fleetCandidateIndexes(snapshot.Sessions, query, 0)
		excerpts := make([]inference.SessionExcerpt, 0, len(indexes))
		perSessionChars := clamp(700_000/max(1, len(indexes)), 1_200, 4_000)
		for _, index := range indexes {
			session := snapshot.Sessions[index]
			skeleton := truncateRunes(session.Skeleton, perSessionChars/2)
			recent, readErr := transcript.RecentText(session.Path, 40, perSessionChars-len([]rune(skeleton)))
			if readErr != nil && skeleton == "" {
				recent = ""
			}
			text := strings.TrimSpace("INDEXED SKELETON:\n" + skeleton + "\nRECENT:\n" + recent)
			excerpts = append(excerpts, inference.SessionExcerpt{Session: session, Transcript: truncateRunes(text, perSessionChars)})
		}
		ctx, cancel := inference.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		matches, err := inference.AskFleet(ctx, engine, query, excerpts)
		return fleetAskedMsg{query: query, engine: engine.Name, matches: matches, err: err}
	}
}

func cleanupCmd(snapshot data.Snapshot) tea.Cmd {
	return func() tea.Msg {
		engine, err := inference.Resolve()
		if err != nil {
			return cleanupProposedMsg{err: err}
		}
		cutoff := snapshot.LoadedAt.Add(-14 * 24 * time.Hour)
		candidates := make([]data.Session, 0, 80)
		for _, session := range snapshot.Sessions {
			if session.IsLoop || session.Cluster != "" || session.State == "active" || session.State == "parked" {
				continue
			}
			if session.State != "completed" && (session.LastAt.IsZero() || !session.LastAt.Before(cutoff)) {
				continue
			}
			candidates = append(candidates, session)
		}
		sort.SliceStable(candidates, func(i int, j int) bool {
			if (candidates[i].State == "completed") != (candidates[j].State == "completed") {
				return candidates[i].State == "completed"
			}
			return candidates[i].LastAt.Before(candidates[j].LastAt)
		})
		if len(candidates) > 80 {
			candidates = candidates[:80]
		}
		excerpts := make([]inference.SessionExcerpt, 0, len(candidates))
		for _, session := range candidates {
			recent, readErr := transcript.RecentText(session.Path, 60, 5_000)
			if readErr != nil && session.Skeleton == "" {
				continue
			}
			text := strings.TrimSpace("INDEXED SKELETON:\n" + session.Skeleton + "\nRECENT:\n" + recent)
			excerpts = append(excerpts, inference.SessionExcerpt{Session: session, Transcript: truncateRunes(text, 10_000)})
		}
		ctx, cancel := inference.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		proposals, err := inference.ProposeCleanup(ctx, engine, excerpts)
		return cleanupProposedMsg{engine: engine.Name, proposals: proposals, err: err}
	}
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func fleetCandidateIndexes(sessions []data.Session, query string, limit int) []int {
	terms := strings.Fields(strings.ToLower(query))
	type candidate struct {
		index int
		score int
	}
	candidates := make([]candidate, 0, len(sessions))
	for index, session := range sessions {
		haystack := strings.ToLower(strings.Join(append([]string{session.Title, session.Project, session.Skeleton}, session.TaskSubjects...), " "))
		score := 0
		for _, term := range terms {
			if strings.Contains(haystack, term) {
				score += 10
			}
		}
		if queryScore, matched := fuzzyScore(strings.ToLower(query), strings.ToLower(session.Title+" "+session.Project)); matched {
			score += queryScore
		}
		candidates = append(candidates, candidate{index: index, score: score})
	}
	sort.SliceStable(candidates, func(i int, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return sessions[candidates[i].index].LastAt.After(sessions[candidates[j].index].LastAt)
	})
	if limit <= 0 || limit > len(candidates) {
		limit = len(candidates)
	}
	indexes := make([]int, limit)
	for index := 0; index < limit; index++ {
		indexes[index] = candidates[index].index
	}
	return indexes
}
