package inference

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"ccsspike/data"
)

// MetadataMutation is a validated, resolved session/identity mutation.
type MetadataMutation struct {
	SessionID   string
	IdentityKey string
	Op          string
	Field       string
	Value       *string
	Enabled     *bool
}

// AskMatch is one validated semantic fleet-search result.
type AskMatch struct {
	SessionID string
	Title     string
	Reason    string
	Answer    string
	Score     int
}

// CleanupProposal is one validated archive candidate.
type CleanupProposal struct {
	SessionID string
	Title     string
	Reason    string
}

// SessionExcerpt is a bounded transcript payload for cross-session inference.
type SessionExcerpt struct {
	Session    data.Session
	Transcript string
}

type rawMutation struct {
	N       int     `json:"n"`
	Op      string  `json:"op"`
	Field   *string `json:"field"`
	Value   *string `json:"value"`
	Enabled *bool   `json:"enabled"`
}

var metadataSchema = []byte(`{
  "type":"object",
  "additionalProperties":false,
  "required":["mutations"],
  "properties":{
    "mutations":{
      "type":"array",
      "maxItems":12,
      "items":{
        "type":"object",
        "additionalProperties":false,
        "required":["n","op","field","value","enabled"],
        "properties":{
          "n":{"type":"integer","minimum":1},
          "op":{"type":"string","enum":["title","completed","archived","parent","parked","identity","identity_field"]},
          "field":{"type":["string","null"]},
          "value":{"type":["string","null"]},
          "enabled":{"type":["boolean","null"]}
        }
      }
    }
  }
}`)

const metadataPrompt = `You edit organization metadata for CCS sessions. The payload contains a numbered list, a focus number, and one instruction. Return only the minimal mutations needed for the FOCUS session. Never target another n. Allowed operations:
- title: value is a short title, or null to clear.
- completed / archived: enabled is true or false.
- parent: value is another session number like #12, or null to clear.
- parked: value is a task id, or null to clear.
- identity: value is one of the listed identity keys, or null to detach.
- identity_field: field is a snake_case universal/per-role field or meta.<key>; value is a string or null. Never use stage, lifecycle fields, cluster, role, kind, or identity_key here.
Set unused field/value/enabled properties to null. Do not invent session numbers or identity keys. Respond using the provided JSON schema.`

// MetadataEdit asks the shared engine for mutations and validates every reference/value.
func MetadataEdit(ctx context.Context, engine Engine, instruction string, sessions []data.Session, focusSessionID string) ([]MetadataMutation, error) {
	focusIndex := -1
	for index, session := range sessions {
		if session.ID == focusSessionID {
			focusIndex = index
			break
		}
	}
	if focusIndex < 0 {
		return nil, errors.New("focus session is not in the snapshot")
	}
	stdin := "INSTRUCTION: " + strings.TrimSpace(instruction) + "\nFOCUS: #" + strconv.Itoa(focusIndex+1) + "\n\nSESSIONS:\n" + renderSessions(sessions)
	raw, err := engine.RunStructured(ctx, metadataPrompt, stdin, metadataSchema)
	if err != nil {
		return nil, err
	}
	var result struct {
		Mutations []rawMutation `json:"mutations"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode metadata mutations: %w", err)
	}
	knownIdentities := make(map[string]bool)
	for _, session := range sessions {
		if session.IdentityKey != "" {
			knownIdentities[session.IdentityKey] = true
		}
	}
	mutations := make([]MetadataMutation, 0, len(result.Mutations))
	seenMutations := make(map[string]bool)
	for _, candidate := range result.Mutations {
		if candidate.N != focusIndex+1 {
			return nil, fmt.Errorf("engine targeted session #%d outside focus", candidate.N)
		}
		mutation, err := validateMutation(candidate, sessions, sessions[focusIndex], knownIdentities)
		if err != nil {
			return nil, err
		}
		key := mutation.SessionID + "\x00" + mutation.Op
		if mutation.Op == "identity_field" {
			key += "\x00" + mutation.Field
		}
		if seenMutations[key] {
			return nil, fmt.Errorf("engine proposed duplicate or conflicting %s mutations", mutation.Op)
		}
		seenMutations[key] = true
		mutations = append(mutations, mutation)
	}
	return mutations, nil
}

func validateMutation(raw rawMutation, sessions []data.Session, focus data.Session, identities map[string]bool) (MetadataMutation, error) {
	mutation := MetadataMutation{SessionID: focus.ID, IdentityKey: focus.IdentityKey, Op: raw.Op, Enabled: raw.Enabled}
	if raw.Value != nil {
		value := cleanValue(*raw.Value, 300)
		mutation.Value = &value
	}
	if raw.Field != nil {
		mutation.Field = cleanValue(*raw.Field, 100)
	}
	switch raw.Op {
	case "title":
		if mutation.Value != nil && (*mutation.Value == "" || len([]rune(*mutation.Value)) > 120) {
			return MetadataMutation{}, errors.New("engine proposed an invalid title")
		}
	case "completed", "archived":
		if raw.Enabled == nil {
			return MetadataMutation{}, fmt.Errorf("%s mutation is missing enabled", raw.Op)
		}
		mutation.Value = nil
	case "parent":
		if mutation.Value != nil {
			value := strings.TrimPrefix(*mutation.Value, "#")
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > len(sessions) {
				return MetadataMutation{}, errors.New("engine proposed an unknown parent session")
			}
			parentID := sessions[n-1].ID
			if parentID == focus.ID {
				return MetadataMutation{}, errors.New("a session cannot parent itself")
			}
			mutation.Value = &parentID
		}
	case "parked":
		if mutation.Value != nil && *mutation.Value == "" {
			mutation.Value = nil
		}
	case "identity":
		if mutation.Value != nil && !identities[*mutation.Value] {
			return MetadataMutation{}, errors.New("engine proposed an unknown identity key")
		}
	case "identity_field":
		if focus.IdentityKey == "" {
			return MetadataMutation{}, errors.New("focused session has no identity for identity_field")
		}
		if !validIdentityField(mutation.Field) {
			return MetadataMutation{}, fmt.Errorf("engine proposed forbidden identity field %q", mutation.Field)
		}
	default:
		return MetadataMutation{}, fmt.Errorf("engine proposed unknown operation %q", raw.Op)
	}
	return mutation, nil
}

var identityFieldPattern = regexp.MustCompile(`^(?:[a-z_][a-z0-9_]*|meta\.[A-Za-z0-9_.-]+)$`)

func validIdentityField(field string) bool {
	if !identityFieldPattern.MatchString(field) {
		return false
	}
	switch field {
	case "stage", "completed", "archived", "cluster", "role", "kind", "identity_key":
		return false
	default:
		return true
	}
}

var summarySchema = []byte(`{
  "type":"object",
  "additionalProperties":false,
  "required":["summary"],
  "properties":{"summary":{"type":"string","minLength":1,"maxLength":600}}
}`)

// Summarize returns a bounded 2–3 line account of a session and its ending state.
func Summarize(ctx context.Context, engine Engine, title string, transcriptText string) (string, error) {
	prompt := "Summarize this coding session in 2–3 short lines: what it was about, what changed, and where it ended. Be concrete, neutral, and do not speculate. Respond using the provided JSON schema."
	stdin := "TITLE: " + title + "\n\nTRANSCRIPT:\n" + transcriptText
	raw, err := engine.RunStructured(ctx, prompt, stdin, summarySchema)
	if err != nil {
		return "", err
	}
	var result struct {
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("decode summary: %w", err)
	}
	summary := cleanMultiline(result.Summary, 600)
	if summary == "" {
		return "", errors.New("engine returned an empty summary")
	}
	return summary, nil
}

var askSchema = []byte(`{
  "type":"object",
  "additionalProperties":false,
  "required":["matches"],
  "properties":{
    "matches":{
      "type":"array",
      "maxItems":5,
      "items":{
        "type":"object",
        "additionalProperties":false,
        "required":["n","score","reason","answer"],
        "properties":{
          "n":{"type":"integer","minimum":1},
          "score":{"type":"integer","minimum":0,"maximum":100},
          "reason":{"type":"string","maxLength":240},
          "answer":{"type":"string","maxLength":500}
        }
      }
    }
  }
}`)

// AskFleet semantically ranks bounded normalized transcript excerpts.
func AskFleet(ctx context.Context, engine Engine, query string, excerpts []SessionExcerpt) ([]AskMatch, error) {
	prompt := "Search the supplied session transcript excerpts for the user's question. Return up to five best matching sessions, strongest first. Answer from evidence in each excerpt; explain why it matches. If nothing matches, return an empty array. Never invent a session number. Respond using the provided JSON schema."
	var payload strings.Builder
	payload.WriteString("QUESTION: ")
	payload.WriteString(strings.TrimSpace(query))
	payload.WriteString("\n\nSESSIONS:\n")
	for index, excerpt := range excerpts {
		fmt.Fprintf(&payload, "\n#%d %s [%s · %s]\n%s\n", index+1, excerpt.Session.Title, excerpt.Session.Project, excerpt.Session.ID, excerpt.Transcript)
	}
	raw, err := engine.RunStructured(ctx, prompt, payload.String(), askSchema)
	if err != nil {
		return nil, err
	}
	var result struct {
		Matches []struct {
			N      int    `json:"n"`
			Score  int    `json:"score"`
			Reason string `json:"reason"`
			Answer string `json:"answer"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode fleet matches: %w", err)
	}
	matches := make([]AskMatch, 0, len(result.Matches))
	seen := make(map[string]bool)
	for _, candidate := range result.Matches {
		if candidate.N < 1 || candidate.N > len(excerpts) {
			return nil, fmt.Errorf("engine returned unknown session #%d", candidate.N)
		}
		session := excerpts[candidate.N-1].Session
		if seen[session.ID] {
			continue
		}
		seen[session.ID] = true
		matches = append(matches, AskMatch{
			SessionID: session.ID,
			Title:     session.Title,
			Reason:    cleanValue(candidate.Reason, 240),
			Answer:    cleanValue(candidate.Answer, 500),
			Score:     clamp(candidate.Score, 0, 100),
		})
	}
	sort.SliceStable(matches, func(i int, j int) bool { return matches[i].Score > matches[j].Score })
	return matches, nil
}

var cleanupSchema = []byte(`{
  "type":"object",
  "additionalProperties":false,
  "required":["archives"],
  "properties":{
    "archives":{
      "type":"array",
      "maxItems":30,
      "items":{
        "type":"object",
        "additionalProperties":false,
        "required":["n","reason"],
        "properties":{
          "n":{"type":"integer","minimum":1},
          "reason":{"type":"string","minLength":1,"maxLength":240}
        }
      }
    }
  }
}`)

// ProposeCleanup chooses stale/done candidates; callers still require user approval.
func ProposeCleanup(ctx context.Context, engine Engine, excerpts []SessionExcerpt) ([]CleanupProposal, error) {
	prompt := "Review these already-filtered stale or completed CCS sessions. Propose only sessions that are safe to archive: clearly finished, superseded, abandoned, or administrative residue. Be conservative around ongoing work, loops, and reusable cluster roles. Give a one-line evidence-based reason. Return an empty array if unsure. Respond using the provided JSON schema."
	var payload strings.Builder
	payload.WriteString("ARCHIVE CANDIDATES:\n")
	for index, excerpt := range excerpts {
		fmt.Fprintf(&payload, "\n#%d %s [%s · state=%s · last=%s · id=%s]\n%s\n", index+1, excerpt.Session.Title, excerpt.Session.Project, excerpt.Session.State, excerpt.Session.LastAt.Format("2006-01-02"), excerpt.Session.ID, excerpt.Transcript)
	}
	raw, err := engine.RunStructured(ctx, prompt, payload.String(), cleanupSchema)
	if err != nil {
		return nil, err
	}
	var result struct {
		Archives []struct {
			N      int    `json:"n"`
			Reason string `json:"reason"`
		} `json:"archives"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode cleanup proposals: %w", err)
	}
	proposals := make([]CleanupProposal, 0, len(result.Archives))
	seen := make(map[string]bool)
	for _, candidate := range result.Archives {
		if candidate.N < 1 || candidate.N > len(excerpts) {
			return nil, fmt.Errorf("engine returned unknown cleanup session #%d", candidate.N)
		}
		session := excerpts[candidate.N-1].Session
		if seen[session.ID] {
			continue
		}
		seen[session.ID] = true
		reason := cleanValue(candidate.Reason, 240)
		if reason == "" {
			continue
		}
		proposals = append(proposals, CleanupProposal{SessionID: session.ID, Title: session.Title, Reason: reason})
	}
	return proposals, nil
}

func renderSessions(sessions []data.Session) string {
	var builder strings.Builder
	for index, session := range sessions {
		identity := session.IdentityKey
		if identity == "" {
			identity = "none"
		}
		parent := "none"
		if session.ParentID != "" {
			for parentIndex, candidate := range sessions {
				if candidate.ID == session.ParentID {
					parent = "#" + strconv.Itoa(parentIndex+1)
					break
				}
			}
		}
		fmt.Fprintf(&builder, "%d. %s [id=%s repo=%s state=%s identity=%s role=%s cluster=%s parent=%s]\n", index+1, session.Title, session.ID, session.Project, session.State, identity, emptyDash(session.Role), emptyDash(session.Cluster), parent)
	}
	return builder.String()
}

func cleanValue(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if limit > 0 && len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

func cleanMultiline(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if limit > 0 && len(runes) > limit {
		value = string(runes[:limit])
	}
	return value
}

func emptyDash(value string) string {
	if value == "" {
		return "none"
	}
	return value
}

func clamp(value int, low int, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}
