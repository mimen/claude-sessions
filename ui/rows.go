package ui

import (
	"sort"
	"strings"
	"unicode"

	"ccsspike/data"
)

func buildRows(sessions []data.Session) []row {
	return buildDefaultRows(sessions, "")
}

func buildDefaultRows(sessions []data.Session, query string) []row {
	indexes := matchingSessionIndexes(sessions, query)
	byCluster := make(map[string]map[string][]int)
	clusterRecent := make(map[string]int64)
	noSystem := make(map[string][]int)
	for _, idx := range indexes {
		session := sessions[idx]
		if session.Cluster == "" {
			state := session.State
			if state == "completed" {
				state = "done"
			}
			noSystem[state] = append(noSystem[state], idx)
			continue
		}
		role := session.Role
		if role == "" {
			role = "(unroled)"
		}
		if byCluster[session.Cluster] == nil {
			byCluster[session.Cluster] = make(map[string][]int)
		}
		byCluster[session.Cluster][role] = append(byCluster[session.Cluster][role], idx)
		if session.LastAt.UnixNano() > clusterRecent[session.Cluster] {
			clusterRecent[session.Cluster] = session.LastAt.UnixNano()
		}
	}

	clusters := make([]string, 0, len(byCluster))
	for cluster := range byCluster {
		clusters = append(clusters, cluster)
	}
	sort.Slice(clusters, func(i int, j int) bool {
		if clusterRecent[clusters[i]] != clusterRecent[clusters[j]] {
			return clusterRecent[clusters[i]] > clusterRecent[clusters[j]]
		}
		return clusters[i] < clusters[j]
	})

	rows := make([]row, 0, len(indexes)+len(clusters)*3+6)
	for _, cluster := range clusters {
		roles := make([]string, 0, len(byCluster[cluster]))
		total := 0
		for role, members := range byCluster[cluster] {
			roles = append(roles, role)
			total += len(members)
		}
		sort.Slice(roles, func(i int, j int) bool {
			left, right := rolePriority(roles[i]), rolePriority(roles[j])
			if left != right {
				return left < right
			}
			return roles[i] < roles[j]
		})
		rows = append(rows, row{header: true, key: "cluster:" + cluster, label: cluster, glyph: "◇", count: total})
		// Sessions sit directly under the cluster header — no role sub-sections
		// (role is already shown in its own column). Role-priority ordering is
		// kept so members still read in a sensible order.
		for _, role := range roles {
			for _, idx := range byCluster[cluster][role] {
				rows = append(rows, row{sIdx: idx, level: 1})
			}
		}
	}

	noSystemCount := 0
	for _, members := range noSystem {
		noSystemCount += len(members)
	}
	if noSystemCount > 0 {
		rows = append(rows, row{header: true, key: "no-system", label: "(no-system)", glyph: "·", count: noSystemCount})
		states := []struct {
			key, label, glyph string
		}{
			{key: "active", label: "active", glyph: "●"},
			{key: "idle", label: "idle", glyph: "○"},
			{key: "parked", label: "parked", glyph: "⏸"},
			{key: "done", label: "done", glyph: "✓"},
		}
		for _, state := range states {
			members := noSystem[state.key]
			if len(members) == 0 {
				continue
			}
			rows = append(rows, row{header: true, key: "no-system:" + state.key, label: state.label, glyph: state.glyph, level: 1, count: len(members)})
			for _, idx := range members {
				rows = append(rows, row{sIdx: idx, level: 1})
			}
		}
	}
	return rows
}

func buildFlatRows(sessions []data.Session, query string) []row {
	indexes := matchingSessionIndexes(sessions, query)
	rows := make([]row, 0, len(indexes))
	for _, idx := range indexes {
		rows = append(rows, row{sIdx: idx})
	}
	return rows
}

func matchingSessionIndexes(sessions []data.Session, query string) []int {
	query = strings.TrimSpace(strings.ToLower(query))
	if query == "" {
		indexes := make([]int, len(sessions))
		for i := range sessions {
			indexes[i] = i
		}
		return indexes
	}
	type scored struct {
		idx   int
		score int
	}
	matches := make([]scored, 0)
	for i, session := range sessions {
		haystacks := []string{session.Title, session.Project}
		haystacks = append(haystacks, session.TaskSubjects...)
		best := -1
		for _, haystack := range haystacks {
			if score, ok := fuzzyScore(query, strings.ToLower(haystack)); ok && score > best {
				best = score
			}
		}
		if best >= 0 {
			matches = append(matches, scored{idx: i, score: best})
		}
	}
	sort.SliceStable(matches, func(i int, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score > matches[j].score
		}
		return sessions[matches[i].idx].LastAt.After(sessions[matches[j].idx].LastAt)
	})
	indexes := make([]int, len(matches))
	for i, match := range matches {
		indexes[i] = match.idx
	}
	return indexes
}

func fuzzyScore(needle string, haystack string) (int, bool) {
	needleRunes := []rune(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		return unicode.ToLower(r)
	}, strings.TrimSpace(needle)))
	haystackRunes := []rune(strings.ToLower(haystack))
	if len(needleRunes) == 0 {
		return 0, true
	}
	position := 0
	score := 0
	streak := 0
	for _, want := range needleRunes {
		found := -1
		for i := position; i < len(haystackRunes); i++ {
			if haystackRunes[i] == want {
				found = i
				break
			}
		}
		if found < 0 {
			return 0, false
		}
		if found == position {
			streak++
			score += 8 + streak*3
		} else {
			streak = 0
			score += max(1, 5-(found-position))
		}
		if found == 0 || unicode.IsSpace(haystackRunes[found-1]) || strings.ContainsRune("/-_", haystackRunes[found-1]) {
			score += 12
		}
		position = found + 1
	}
	if strings.Contains(haystack, needle) {
		score += 80
	}
	return score, true
}

func rolePriority(role string) int {
	switch role {
	case "control", "coordinator":
		return 0
	case "concierge":
		return 1
	case "scout", "slack-scout":
		return 2
	case "eval", "designer", "loop-designer":
		return 3
	default:
		return 10
	}
}

func roleGlyph(role string) string {
	if rolePriority(role) < 4 {
		return "◆"
	}
	return "●"
}
