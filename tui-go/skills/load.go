package skills

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Load reads the CCS skills cache in mode=ro and falls back to a read-only filesystem scan.
func Load() (Snapshot, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Snapshot{}, fmt.Errorf("resolve home directory: %w", err)
	}
	path := strings.TrimSpace(os.Getenv("CCS_SKILLS_DB_PATH"))
	if path == "" {
		root := strings.TrimSpace(os.Getenv("CCS_ROOT"))
		if root == "" {
			root = filepath.Join(home, ".ccs")
		}
		path = filepath.Join(root, "cache", "skills.db")
	}
	cached, cacheErr := loadCache(path, home)
	if cacheErr == nil && len(cached) > 0 {
		markDrift(cached)
		return Snapshot{Skills: visibleSkills(cached), Source: path}, nil
	}
	scanned, scanWarnings, scanErr := scanMachine(home)
	if scanErr != nil {
		if cacheErr != nil {
			return Snapshot{}, fmt.Errorf("skills cache: %v; scan: %w", cacheErr, scanErr)
		}
		return Snapshot{}, scanErr
	}
	warnings := append([]string(nil), scanWarnings...)
	if cacheErr != nil && !errors.Is(cacheErr, os.ErrNotExist) {
		warnings = append(warnings, cacheErr.Error())
	}
	markDrift(scanned)
	return Snapshot{Skills: visibleSkills(scanned), Warnings: warnings, Source: "filesystem scan"}, nil
}

// Scan performs a fresh read-only full-home discovery, bypassing the rebuildable cache.
func Scan() (Snapshot, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Snapshot{}, fmt.Errorf("resolve home directory: %w", err)
	}
	scanned, warnings, err := scanMachine(home)
	if err != nil {
		return Snapshot{}, err
	}
	markDrift(scanned)
	return Snapshot{Skills: visibleSkills(scanned), Warnings: warnings, Source: "filesystem scan"}, nil
}

func loadCache(path string, home string) ([]Skill, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	u := &url.URL{Scheme: "file", Path: path}
	query := u.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open skills cache: %w", err)
	}
	defer db.Close()
	var exists int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='skills'").Scan(&exists); err != nil || exists == 0 {
		return nil, errors.New("skills cache has no skills table")
	}
	columns := make(map[string]bool)
	if columnRows, columnErr := db.Query("PRAGMA table_info(skills)"); columnErr == nil {
		defer columnRows.Close()
		for columnRows.Next() {
			var cid, notNull, primaryKey int
			var name, columnType string
			var defaultValue sql.NullString
			if columnRows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey) == nil {
				columns[name] = true
			}
		}
	}
	categoryColumn := "''"
	if columns["category"] {
		categoryColumn = "coalesce(category, '')"
	} else if columns["fm_category"] {
		categoryColumn = "coalesce(fm_category, '')"
	}
	sourceColumn := "''"
	if columns["source"] {
		sourceColumn = "coalesce(source, '')"
	}
	rows, err := db.Query("SELECT name, path, real_path, ecosystem, description, aliases, content_hash, " + categoryColumn + ", " + sourceColumn + " FROM skills")
	if err != nil {
		return nil, fmt.Errorf("query skills cache: %w", err)
	}
	defer rows.Close()
	skills := make([]Skill, 0)
	for rows.Next() {
		var skill Skill
		var aliasesJSON string
		if err := rows.Scan(&skill.Name, &skill.Path, &skill.RealPath, &skill.Ecosystem, &skill.Description, &aliasesJSON, &skill.Hash, &skill.Category, &skill.Source); err != nil {
			return nil, fmt.Errorf("scan skills cache: %w", err)
		}
		_ = json.Unmarshal([]byte(aliasesJSON), &skill.Aliases)
		skill.Home = homeOf(skill.Path, home)
		skills = append(skills, skill)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read skills cache: %w", err)
	}
	loadUsage(db, skills)
	loadTagsAndCategories(db, skills)
	return skills, nil
}

func loadUsage(db *sql.DB, skills []Skill) {
	rows, err := db.Query("SELECT skill, kind, sum(count), max(last_ts) FROM usage_counts GROUP BY skill, kind")
	if err != nil {
		return
	}
	defer rows.Close()
	byName := make(map[string]*Usage)
	for rows.Next() {
		var name, kind, last string
		var count int
		if rows.Scan(&name, &kind, &count, &last) != nil {
			continue
		}
		usage := byName[name]
		if usage == nil {
			usage = &Usage{}
			byName[name] = usage
		}
		switch kind {
		case "invoke":
			usage.Invocations += count
		case "command":
			usage.Commands += count
		case "read":
			usage.Reads += count
		}
		if last > usage.LastUsed {
			usage.LastUsed = last
		}
	}
	for index := range skills {
		if usage := byName[skills[index].Name]; usage != nil {
			skills[index].Usage = *usage
		}
	}
}

func loadTagsAndCategories(db *sql.DB, skills []Skill) {
	tags := make(map[string][]string)
	if rows, err := db.Query("SELECT skill_name, tag FROM tags ORDER BY tag"); err == nil {
		defer rows.Close()
		for rows.Next() {
			var name, tag string
			if rows.Scan(&name, &tag) == nil {
				tags[name] = append(tags[name], tag)
			}
		}
	}
	categories := make(map[string]string)
	if rows, err := db.Query("SELECT skill_name, category FROM categories"); err == nil {
		defer rows.Close()
		for rows.Next() {
			var name, category string
			if rows.Scan(&name, &category) == nil {
				categories[name] = category
			}
		}
	}
	for index := range skills {
		skills[index].Tags = append([]string(nil), tags[skills[index].Name]...)
		if skills[index].Category == "" {
			skills[index].Category = categories[skills[index].Name]
		}
	}
}

func skillScanRoots(home string) ([]string, error) {
	entries, err := os.ReadDir(home)
	if err != nil {
		return nil, fmt.Errorf("read home for skill scan: %w", err)
	}
	roots := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "Library" || entry.Name() == ".Trash" {
			continue
		}
		roots = append(roots, filepath.Join(home, entry.Name()))
	}
	if len(roots) == 0 {
		return nil, errors.New("no skill registry roots exist")
	}
	priority := map[string]int{
		"Documents": 0, "Programming": 1, "Downloads": 2, ".claude": 3,
		".bun": 4, ".hermes": 5, ".cursor": 6, ".grok": 7,
	}
	sort.Slice(roots, func(i int, j int) bool {
		leftName, rightName := filepath.Base(roots[i]), filepath.Base(roots[j])
		left, leftKnown := priority[leftName]
		right, rightKnown := priority[rightName]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown && left != right {
			return left < right
		}
		return roots[i] < roots[j]
	})
	return roots, nil
}

func skillFindArgs(root string) []string {
	return []string{
		root,
		"-maxdepth", "9",
		"(",
		"-path", "*/node_modules", "-o",
		"-path", "*/.git", "-o",
		"-path", "*/.archive", "-o",
		"-path", "*/Library", "-o",
		"-path", "*/.Trash", "-o",
		"-path", "*/.cache", "-o",
		"-path", "*/.bun/install/cache", "-o",
		"-path", "*/.claude/worktrees", "-o",
		"-path", "*/.milad-vault-worktrees", "-o",
		"-path", "*/.claude/plugins/marketplaces", "-o",
		"-path", "*/.codex/.tmp", "-o",
		"-path", "*/.codex/vendor_imports", "-o",
		"-path", "*/.grok/marketplace-cache", "-o",
		"-path", "*/.grok/bundled", "-o",
		"-path", "*/.hermes/hermes-agent/optional-skills",
		")", "-prune", "-o",
		"-name", "SKILL.md", "-print",
	}
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func scanMachine(home string) ([]Skill, []string, error) {
	roots, err := skillScanRoots(home)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	type scanResult struct {
		output []byte
		err    error
	}
	results := make(chan scanResult, len(roots))
	semaphore := make(chan struct{}, 8)
	var wait sync.WaitGroup
	for _, root := range roots {
		root := root
		wait.Add(1)
		go func() {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			output, scanErr := exec.CommandContext(ctx, "find", skillFindArgs(root)...).Output()
			results <- scanResult{output: output, err: scanErr}
		}()
	}
	wait.Wait()
	close(results)
	outputs := make([]byte, 0, 256*1024)
	var firstErr error
	for result := range results {
		outputs = append(outputs, result.output...)
		if len(result.output) > 0 && result.output[len(result.output)-1] != '\n' {
			outputs = append(outputs, '\n')
		}
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
	}
	if direct := filepath.Join(home, "SKILL.md"); isRegularFile(direct) {
		outputs = append(outputs, direct...)
		outputs = append(outputs, '\n')
	}
	if len(outputs) == 0 && firstErr != nil {
		return nil, nil, fmt.Errorf("scan machine for skills: %w", firstErr)
	}
	warnings := make([]string, 0, 1)
	if firstErr != nil {
		message := "skill scan was partial: " + firstErr.Error()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			message = "skill scan was partial: 30-second scan budget exhausted"
		}
		warnings = append(warnings, message)
	}
	byReal := make(map[string]*Skill)
	for _, line := range strings.Split(string(outputs), "\n") {
		if !strings.HasSuffix(line, string(filepath.Separator)+"SKILL.md") {
			continue
		}
		dir := filepath.Dir(line)
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			continue
		}
		if existing := byReal[real]; existing != nil {
			if dir != existing.Path && !contains(existing.Aliases, dir) {
				existing.Aliases = append(existing.Aliases, dir)
			}
			continue
		}
		contents, readErr := os.ReadFile(line)
		name := filepath.Base(dir)
		description := ""
		category := ""
		source := ""
		hash := ""
		if readErr == nil {
			frontmatter := parseFrontmatter(string(contents))
			if frontmatter["name"] != "" {
				name = frontmatter["name"]
			}
			description = frontmatter["description"]
			category = frontmatter["category"]
			source = frontmatter["source"]
			digest := sha256.Sum256(contents)
			hash = hex.EncodeToString(digest[:8])
		}
		byReal[real] = &Skill{
			Name: name, Path: dir, RealPath: real, Ecosystem: classifyPath(real, home),
			Home: homeOf(dir, home), Description: description, Category: category, Source: source, Hash: hash,
		}
	}
	probeSymlinkFarms(byReal, home)
	skills := make([]Skill, 0, len(byReal))
	for _, skill := range byReal {
		runtimePrefix := filepath.Join(home, ".claude", "skills") + string(filepath.Separator)
		addresses := append([]string{skill.Path}, skill.Aliases...)
		for _, address := range addresses {
			if strings.HasPrefix(address, runtimePrefix) && address != skill.Path {
				skill.Aliases = append([]string{skill.Path}, removeString(skill.Aliases, address)...)
				skill.Path = address
				skill.Home = homeOf(address, home)
				break
			}
		}
		sort.Strings(skill.Aliases)
		skills = append(skills, *skill)
	}
	sort.Slice(skills, func(i int, j int) bool {
		if skills[i].Name != skills[j].Name {
			return skills[i].Name < skills[j].Name
		}
		return skills[i].Path < skills[j].Path
	})
	return skills, warnings, nil
}

func probeSymlinkFarms(byReal map[string]*Skill, home string) {
	for _, farm := range []string{filepath.Join(home, ".claude", "skills"), filepath.Join(home, ".codex", "skills"), filepath.Join(home, ".agents", "skills")} {
		entries, err := os.ReadDir(farm)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			path := filepath.Join(farm, entry.Name())
			real, err := filepath.EvalSymlinks(path)
			if err != nil || real == path {
				continue
			}
			if skill := byReal[real]; skill != nil && path != skill.Path && !contains(skill.Aliases, path) {
				skill.Aliases = append(skill.Aliases, path)
			}
		}
	}
}

func visibleSkills(skills []Skill) []Skill {
	shadowed := make(map[string]bool)
	groups := make(map[string][]Skill)
	for _, skill := range skills {
		if skill.Hash == "" {
			continue
		}
		key := skill.Name + "\x00" + skill.Ecosystem + "\x00" + skill.Hash
		groups[key] = append(groups[key], skill)
	}
	for _, group := range groups {
		if len(group) < 2 {
			continue
		}
		sort.Slice(group, func(i int, j int) bool {
			if len(group[i].Path) != len(group[j].Path) {
				return len(group[i].Path) < len(group[j].Path)
			}
			return group[i].Path < group[j].Path
		})
		for _, duplicate := range group[1:] {
			shadowed[duplicate.Path] = true
		}
	}
	visible := make([]Skill, 0, len(skills))
	for _, skill := range skills {
		if shadowed[skill.Path] || skill.Ecosystem == "marketplace" || isLinkedWorktree(skill.RealPath) {
			continue
		}
		visible = append(visible, skill)
	}
	return visible
}

func isLinkedWorktree(path string) bool {
	directory := path
	for depth := 0; depth < 12; depth++ {
		info, err := os.Stat(filepath.Join(directory, ".git"))
		if err == nil {
			return !info.IsDir()
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return false
}

func markDrift(skills []Skill) {
	hashes := make(map[string]map[string]bool)
	for _, skill := range skills {
		if skill.Hash == "" {
			continue
		}
		if hashes[skill.Name] == nil {
			hashes[skill.Name] = make(map[string]bool)
		}
		hashes[skill.Name][skill.Hash] = true
	}
	for index := range skills {
		skills[index].Drift = len(hashes[skills[index].Name]) > 1
	}
}

func parseFrontmatter(text string) map[string]string {
	out := make(map[string]string)
	allLines := strings.Split(text, "\n")
	if len(allLines) < 3 || strings.TrimSpace(allLines[0]) != "---" {
		return out
	}
	end := -1
	for index := 1; index < len(allLines); index++ {
		if strings.TrimSpace(allLines[index]) == "---" {
			end = index
			break
		}
	}
	if end < 0 {
		return out
	}
	lines := allLines[1:end]
	for index := 0; index < len(lines); index++ {
		key, value, found := strings.Cut(lines[index], ":")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if value == "" || value == ">-" || value == ">" || value == "|" || value == "|-" {
			var parts []string
			for index+1 < len(lines) && len(lines[index+1]) > 0 && (lines[index+1][0] == ' ' || lines[index+1][0] == '\t') {
				index++
				parts = append(parts, strings.TrimSpace(lines[index]))
			}
			value = strings.Join(parts, " ")
		}
		out[key] = strings.Trim(strings.TrimSpace(value), "'\"")
	}
	return out
}

func classifyPath(path string, home string) string {
	short := strings.Replace(path, home, "~", 1)
	switch {
	case strings.Contains(short, "/_archive/"), strings.Contains(short, "/deprecated/"):
		return "archive"
	case strings.HasPrefix(short, "~/Downloads/"):
		return "download"
	case strings.HasPrefix(short, "~/.claude/plugins/marketplaces/"):
		return "marketplace"
	case strings.HasPrefix(short, "~/.claude/plugins/"):
		return "plugin"
	case strings.HasPrefix(short, "~/.claude/skills/"), strings.Contains(short, "/ClaudeConfig/skills/"):
		return "claude-user"
	case strings.HasPrefix(short, "~/.agents/"), strings.Contains(short, "/.agents/skills/"):
		return "agents"
	case strings.HasPrefix(short, "~/.codex/.tmp/"), strings.HasPrefix(short, "~/.codex/vendor_imports/"):
		return "marketplace"
	case strings.HasPrefix(short, "~/.codex/"):
		return "codex"
	case strings.HasPrefix(short, "~/.cursor/"):
		return "cursor"
	case strings.HasPrefix(short, "~/.grok/marketplace-cache/"), strings.HasPrefix(short, "~/.grok/bundled/"):
		return "marketplace"
	case strings.HasPrefix(short, "~/.grok/"):
		return "grok"
	case strings.HasPrefix(short, "~/.hermes/hermes-agent/optional-skills/"):
		return "marketplace"
	case strings.HasPrefix(short, "~/.hermes/"):
		return "hermes"
	case strings.HasPrefix(short, "~/.vscode"), strings.Contains(short, "/extensions/github.copilot"):
		return "ide"
	case strings.HasPrefix(short, "~/.gemini/"):
		return "other"
	case strings.Contains(short, "/.claude/skills/"), strings.Contains(short, "/.claude/commands/"), strings.Contains(short, "/skills/"):
		return "claude-project"
	default:
		return "other"
	}
}

func homeOf(path string, home string) string {
	short := strings.Replace(path, home, "~", 1)
	switch {
	case strings.Contains(short, "/_archive/"), strings.Contains(short, "/deprecated/"):
		return "archive"
	case strings.HasPrefix(short, "~/Downloads/"):
		return "downloads"
	case strings.HasPrefix(short, "~/.claude/skills/"), strings.Contains(short, "/ClaudeConfig/skills/"):
		return "global"
	case strings.HasPrefix(short, "~/.agents/"):
		return "agents"
	case strings.HasPrefix(short, "~/.codex/"):
		return "codex"
	case strings.HasPrefix(short, "~/.grok/"):
		return "grok"
	case strings.HasPrefix(short, "~/.cursor/"):
		return "cursor"
	case strings.HasPrefix(short, "~/.hermes/"):
		return "hermes"
	case strings.HasPrefix(short, "~/.vscode"):
		return "ide"
	case strings.HasPrefix(short, "~/.claude/plugins/"):
		return "plugin"
	}
	if parts := strings.Split(short, "/.claude/skills/"); len(parts) > 1 {
		return filepath.Base(parts[0])
	}
	if parts := strings.Split(short, "/.agents/skills/"); len(parts) > 1 {
		return filepath.Base(parts[0])
	}
	return "other"
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func removeString(values []string, removed string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != removed {
			out = append(out, value)
		}
	}
	return out
}
