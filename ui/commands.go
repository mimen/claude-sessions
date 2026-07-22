package ui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"ccsspike/ccscli"
	"ccsspike/data"
	"ccsspike/inference"
	"ccsspike/transcript"

	tea "github.com/charmbracelet/bubbletea"
)

type writeFinishedMsg struct {
	preferredID string
	status      string
	snapshot    data.Snapshot
	err         error
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

func setTitleCmd(sessionID string, title string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := ccscli.SetTitle(ctx, sessionID, title); err != nil {
			return writeFinishedMsg{preferredID: sessionID, err: err}
		}
		return reloadAfterWrite(sessionID, "retitled → "+title)
	}
}

func markCompletedCmd(sessionID string, preferredID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := ccscli.MarkCompleted(ctx, sessionID, true); err != nil {
			return writeFinishedMsg{preferredID: preferredID, err: err}
		}
		return reloadAfterWrite(preferredID, "marked done")
	}
}

func archiveBatchCmd(sessionIDs []string, preferredID string, status string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(30, len(sessionIDs)*10))*time.Second)
		defer cancel()
		if err := ccscli.ArchiveBatch(ctx, sessionIDs); err != nil {
			return writeFinishedMsg{preferredID: preferredID, err: err}
		}
		return reloadAfterWrite(preferredID, status)
	}
}

func applyMutationsCmd(mutations []inference.MetadataMutation, preferredID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(30, len(mutations)*10))*time.Second)
		defer cancel()
		if err := ccscli.ApplyMutations(ctx, mutations); err != nil {
			return writeFinishedMsg{preferredID: preferredID, err: err}
		}
		return reloadAfterWrite(preferredID, fmt.Sprintf("applied %d metadata changes", len(mutations)))
	}
}

func reloadAfterWrite(preferredID string, status string) writeFinishedMsg {
	snapshot, err := data.Load()
	if err != nil {
		return writeFinishedMsg{preferredID: preferredID, status: status, err: fmt.Errorf("write succeeded; reload failed: %w", err)}
	}
	return writeFinishedMsg{preferredID: preferredID, status: status, snapshot: snapshot}
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
		indexes := fleetCandidateIndexes(snapshot.Sessions, query, 100)
		excerpts := make([]inference.SessionExcerpt, 0, len(indexes))
		for _, index := range indexes {
			session := snapshot.Sessions[index]
			recent, readErr := transcript.RecentText(session.Path, 80, 6_000)
			if readErr != nil && session.Skeleton == "" {
				continue
			}
			text := strings.TrimSpace("INDEXED SKELETON:\n" + session.Skeleton + "\nRECENT:\n" + recent)
			if len(text) > 12_000 {
				text = text[:12_000]
			}
			excerpts = append(excerpts, inference.SessionExcerpt{Session: session, Transcript: text})
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
			if len(text) > 10_000 {
				text = text[:10_000]
			}
			excerpts = append(excerpts, inference.SessionExcerpt{Session: session, Transcript: text})
		}
		ctx, cancel := inference.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		proposals, err := inference.ProposeCleanup(ctx, engine, excerpts)
		return cleanupProposedMsg{engine: engine.Name, proposals: proposals, err: err}
	}
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
