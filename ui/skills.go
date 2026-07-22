package ui

import (
	"sort"
	"strings"
	"time"

	"ccsspike/skills"

	tea "github.com/charmbracelet/bubbletea"
)

type skillView int

const (
	skillViewCategory skillView = iota
	skillViewHome
	skillViewName
	skillViewActivity
	skillViewFlat
)

type skillRow struct {
	header bool
	key    string
	label  string
	count  int
	sIdx   int
}

type skillReader struct {
	skill     skills.Skill
	files     []skills.File
	fileIndex int
	lines     []string
	scroll    int
	err       string
}

type skillsLoadedMsg struct {
	snapshot skills.Snapshot
	err      error
}

func loadSkillsCmd() tea.Cmd {
	return func() tea.Msg {
		snapshot, err := skills.Load()
		return skillsLoadedMsg{snapshot: snapshot, err: err}
	}
}

func (m Model) handleSkillKey(message tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.overlay == OverlayHelp {
		switch message.String() {
		case "esc", "q", "?":
			m.overlay = OverlayNone
		}
		return m, nil
	}
	if m.skillReader != nil {
		page := max(1, m.h-6)
		maxScroll := max(0, len(m.skillReader.lines)-page)
		switch message.String() {
		case "esc", "q", "v":
			m.skillReader = nil
		case "up", "k":
			m.skillReader.scroll = max(0, m.skillReader.scroll-1)
		case "down", "j":
			m.skillReader.scroll = min(maxScroll, m.skillReader.scroll+1)
		case "pgup":
			m.skillReader.scroll = max(0, m.skillReader.scroll-page)
		case "pgdown", " ":
			m.skillReader.scroll = min(maxScroll, m.skillReader.scroll+page)
		case "g":
			m.skillReader.scroll = 0
		case "G":
			m.skillReader.scroll = maxScroll
		case "tab", "right", "l":
			m.cycleSkillFile(1)
		case "left", "h":
			m.cycleSkillFile(-1)
		}
		return m, nil
	}
	if m.skillSearching {
		switch message.String() {
		case "esc":
			m.skillSearching = false
			m.skillQuery = ""
			m.rebuildSkillRows()
		case "enter":
			m.skillSearching = false
		case "up":
			m.moveSkill(-1)
		case "down":
			m.moveSkill(1)
		case "backspace", "delete":
			runes := []rune(m.skillQuery)
			if len(runes) > 0 {
				m.skillQuery = string(runes[:len(runes)-1])
				m.rebuildSkillRows()
			}
		default:
			if message.Type == tea.KeyRunes && !message.Alt {
				m.skillQuery += string(message.Runes)
				m.rebuildSkillRows()
			}
		}
		return m, nil
	}

	switch message.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "tab":
		m.mode = ModeSessions
		m.status = ""
	case "up", "k":
		m.moveSkill(-1)
	case "down", "j":
		m.moveSkill(1)
	case "g":
		m.skillView = (m.skillView + 1) % 5
		m.rebuildSkillRows()
	case "/":
		m.skillSearching = true
	case "p":
		m.skillPreview = !m.skillPreview
	case "v", "enter":
		m.openSkillReader()
	case "R":
		m.skillLoading = true
		m.skillError = ""
		return m, loadSkillsCmd()
	case "?":
		m.overlay = OverlayHelp
	}
	return m, nil
}

func (m *Model) rebuildSkillRows() {
	m.skillRows = buildSkillRows(m.skills.Skills, m.skillView, m.skillQuery)
	m.skillCursor = firstSkillRow(m.skillRows)
}

func buildSkillRows(all []skills.Skill, view skillView, query string) []skillRow {
	indexes := make([]int, 0, len(all))
	for index, skill := range all {
		if matchesSkill(skill, query) {
			indexes = append(indexes, index)
		}
	}
	sort.SliceStable(indexes, func(i int, j int) bool {
		left, right := all[indexes[i]], all[indexes[j]]
		if left.Usage.LastUsed != right.Usage.LastUsed {
			return left.Usage.LastUsed > right.Usage.LastUsed
		}
		return left.Name < right.Name
	})
	if view == skillViewFlat {
		rows := make([]skillRow, 0, len(indexes))
		for _, index := range indexes {
			rows = append(rows, skillRow{sIdx: index})
		}
		return rows
	}
	buckets := make(map[string][]int)
	for _, index := range indexes {
		key := all[index].Category
		switch view {
		case skillViewHome:
			key = all[index].Home
		case skillViewName:
			key = all[index].Name
		case skillViewActivity:
			key = skillActivity(all[index].Usage.LastUsed)
		}
		if key == "" {
			key = "uncategorized"
		}
		buckets[key] = append(buckets[key], index)
	}
	keys := make([]string, 0, len(buckets))
	for key := range buckets {
		keys = append(keys, key)
	}
	if view == skillViewActivity {
		keys = keys[:0]
		for _, key := range []string{"active", "dormant", "unobserved"} {
			if len(buckets[key]) > 0 {
				keys = append(keys, key)
			}
		}
	} else if view == skillViewName {
		unique := make([]int, 0)
		grouped := keys[:0]
		for _, key := range keys {
			if len(buckets[key]) > 1 {
				grouped = append(grouped, key)
			} else {
				unique = append(unique, buckets[key]...)
				delete(buckets, key)
			}
		}
		sort.Strings(grouped)
		keys = grouped
		if len(unique) > 0 {
			buckets["(unique names)"] = unique
			keys = append(keys, "(unique names)")
		}
	} else {
		sort.Slice(keys, func(i int, j int) bool {
			if view == skillViewCategory && (keys[i] == "uncategorized") != (keys[j] == "uncategorized") {
				return keys[j] == "uncategorized"
			}
			if len(buckets[keys[i]]) != len(buckets[keys[j]]) {
				return len(buckets[keys[i]]) > len(buckets[keys[j]])
			}
			return keys[i] < keys[j]
		})
	}
	rows := make([]skillRow, 0, len(indexes)+len(keys))
	for _, key := range keys {
		rows = append(rows, skillRow{header: true, key: key, label: key, count: len(buckets[key])})
		for _, index := range buckets[key] {
			rows = append(rows, skillRow{sIdx: index})
		}
	}
	return rows
}

func skillActivity(lastUsed string) string {
	if lastUsed == "" {
		return "unobserved"
	}
	usedAt, err := time.Parse(time.RFC3339Nano, lastUsed)
	if err != nil {
		return "unobserved"
	}
	if time.Since(usedAt) <= 30*24*time.Hour {
		return "active"
	}
	return "dormant"
}

func matchesSkill(skill skills.Skill, query string) bool {
	query = strings.TrimSpace(strings.ToLower(query))
	if query == "" {
		return true
	}
	haystack := strings.ToLower(strings.Join([]string{skill.Name, skill.Description, skill.Path, skill.Category, strings.Join(skill.Tags, " ")}, " "))
	_, matched := fuzzyScore(query, haystack)
	return matched
}

func firstSkillRow(rows []skillRow) int {
	for index, row := range rows {
		if !row.header {
			return index
		}
	}
	return 0
}

func (m *Model) moveSkill(delta int) {
	candidate := m.skillCursor + delta
	for candidate >= 0 && candidate < len(m.skillRows) {
		if !m.skillRows[candidate].header {
			m.skillCursor = candidate
			return
		}
		candidate += delta
	}
}

func (m Model) selectedSkill() (skills.Skill, bool) {
	if m.skillCursor < 0 || m.skillCursor >= len(m.skillRows) || m.skillRows[m.skillCursor].header {
		return skills.Skill{}, false
	}
	index := m.skillRows[m.skillCursor].sIdx
	if index < 0 || index >= len(m.skills.Skills) {
		return skills.Skill{}, false
	}
	return m.skills.Skills[index], true
}

func (m *Model) openSkillReader() {
	skill, ok := m.selectedSkill()
	if !ok {
		return
	}
	files := skills.Files(skill)
	if len(files) == 0 {
		m.skillError = "skill has no readable files"
		return
	}
	lines, err := skills.ReadFile(skill, files[0].Relative)
	reader := &skillReader{skill: skill, files: files, lines: lines}
	if err != nil {
		reader.err = err.Error()
	}
	m.skillReader = reader
}

func (m *Model) cycleSkillFile(delta int) {
	if m.skillReader == nil || len(m.skillReader.files) == 0 {
		return
	}
	reader := m.skillReader
	reader.fileIndex = (reader.fileIndex + delta + len(reader.files)) % len(reader.files)
	reader.scroll = 0
	reader.err = ""
	lines, err := skills.ReadFile(reader.skill, reader.files[reader.fileIndex].Relative)
	if err != nil {
		reader.lines = nil
		reader.err = err.Error()
		return
	}
	reader.lines = lines
}

func (m Model) skillWindow(height int) (int, int) {
	visible := max(1, height)
	start := m.skillCursor - visible/2
	start = clamp(start, 0, max(0, len(m.skillRows)-visible))
	return start, min(len(m.skillRows), start+visible)
}
