package data

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const sessionClassRollout = "2026-07-20T00:00:00.000Z"

type sessionRollup struct {
	Self       float64
	Total      float64
	Providers  ProviderCost
	Descendant int
}

// Load reads one consistent-enough, read-only snapshot from the CCS caches.
// SQLite WAL readers do not block the existing ccs process.
func Load(options LoadOptions) (Snapshot, error) {
	now := time.Now()
	home, err := os.UserHomeDir()
	if err != nil {
		return Snapshot{}, fmt.Errorf("resolve home directory: %w", err)
	}
	runtimeRoot := strings.TrimSpace(os.Getenv("CCS_ROOT"))
	if runtimeRoot == "" {
		runtimeRoot = filepath.Join(home, ".ccs")
	}
	indexPath := envOr("CCS_INDEX_PATH", filepath.Join(runtimeRoot, "cache", "index.db"))
	cataloguePath := envOr("CCS_CATALOGUE_PATH", filepath.Join(runtimeRoot, "cache", "catalogue.db"))
	indexed, err := loadIndex(indexPath)
	if err != nil {
		return Snapshot{}, err
	}

	warnings := make([]string, 0, 2)
	catalogue, err := loadCatalogue(cataloguePath)
	if err != nil {
		warnings = append(warnings, err.Error())
		catalogue = map[string]catalogueMeta{}
	}
	live, err := loadLiveSessions(home)
	if err != nil {
		warnings = append(warnings, err.Error())
		live = map[string]liveSession{}
	}
	roleKinds := loadRoleKinds(home)
	tasks := loadTaskSummaries(home)
	rollups, subagentCounts := buildRollups(indexed, catalogue)
	categories, categoryErr := loadCategoryRegistry(categoryRegistryPath(runtimeRoot))
	if categoryErr != nil {
		warnings = append(warnings, categoryErr.Error())
		categories = categoryRegistry{Categories: map[string]CategoryDefinition{}}
	}

	visible := make([]Session, 0, len(indexed))
	byID := make(map[string]int)
	categoryFindings := make(map[string]int)
	knownSessions := make(map[string]bool, len(indexed)+len(catalogue))
	for _, row := range indexed {
		knownSessions[row.ID] = true
	}
	for id := range catalogue {
		knownSessions[id] = true
	}
	for _, row := range indexed {
		meta := catalogue[row.ID]
		if !includeSession(row, meta, options) {
			continue
		}
		isOpen, liveInfo := liveState(row, live)
		title, titleSource := resolveDisplayTitle(row, meta, liveInfo.Title)
		state := disposition(meta, isOpen)
		isLoop := roleKinds[roleKey(meta.Cluster, meta.Role)] == "loop"
		class := displayClass(row, meta, isLoop)
		rollup := rollups[row.ID]
		model := dominantModel(row.CostByModel, row.Models)
		task := tasks[row.ID]
		if task.Total == 0 && row.ResumeID != row.ID {
			task = tasks[row.ResumeID]
		}
		resolvedCategory := resolveEffectiveCategory(row.ID, catalogue, knownSessions, 32)
		categoryName := "Uncategorized"
		categoryCompact := "Uncategorized"
		categoryColor := ""
		if full, compact, repair := categoryRepairDisplay(resolvedCategory.Finding); repair {
			categoryName = full
			categoryCompact = compact
		}
		if categoryErr != nil {
			resolvedCategory.Finding = "registry-unavailable"
			categoryName = "Category registry unavailable"
			categoryCompact = "No registry"
		} else if category, exists := categories.Categories[resolvedCategory.Slug]; exists {
			categoryName = category.Name
			categoryCompact = category.CompactName
			categoryColor = category.Color
		} else if resolvedCategory.Slug != "" {
			resolvedCategory.Finding = "category-invalid"
			categoryName = "Invalid category: " + resolvedCategory.Slug
			categoryCompact = "Bad category"
		}
		if shouldAggregateCategoryFinding(resolvedCategory.Finding) {
			categoryFindings[resolvedCategory.Finding]++
		}
		session := Session{
			ID:                row.ID,
			ResumeID:          row.ResumeID,
			Path:              row.Path,
			Title:             title,
			TitleSource:       titleSource,
			State:             state,
			Class:             class,
			SessionClass:      meta.SessionClass,
			IdentityKey:       meta.IdentityKey,
			IdentityKind:      meta.IdentityKind,
			Role:              meta.Role,
			Cluster:           meta.Cluster,
			Stage:             meta.Stage,
			StoredCategory:    resolvedCategory.StoredSlug,
			EffectiveCategory: resolvedCategory.Slug,
			CategoryName:      categoryName,
			CategoryCompact:   categoryCompact,
			CategoryColor:     categoryColor,
			CategoryFinding:   resolvedCategory.Finding,
			CategorySource:    resolvedCategory.Source,
			CategoryFrom:      resolvedCategory.InheritedFrom,
			PRNumber:          meta.PRNumber,
			PRState:           meta.PRState,
			Enrichment:        meta.Enrichment,
			Project:           row.ProjectName,
			ProjectRoot:       row.ProjectRoot,
			CWD:               row.CWD,
			Branch:            row.Branch,
			Skeleton:          row.Skeleton,
			FirstAt:           row.FirstAt,
			LastAt:            row.LastAt,
			Messages:          row.Messages,
			Models:            append([]string(nil), row.Models...),
			LastModel:         row.LastModel,
			Model:             model,
			SelfCost:          rollup.Self,
			TotalCost:         rollup.Total,
			ProviderCost:      rollup.Providers,
			Duration:          FormatSpan(row.FirstAt, row.LastAt),
			Subagents:         subagentCounts[row.ID],
			ParentID:          meta.ParentSessionID,
			TaskSubjects:      append([]string(nil), task.Subjects...),
			TasksDone:         task.Done,
			TasksInProgress:   task.InProgress,
			TasksTotal:        task.Total,
			LiveWindowRef:     liveInfo.WindowRef,
			LiveWorkspaceRef:  liveInfo.WorkspaceRef,
			IsLoop:            isLoop,
			IsSubagent:        row.IsSubagent,
		}
		byID[session.ID] = len(visible)
		visible = append(visible, session)
	}

	if len(categoryFindings) > 0 {
		parts := make([]string, 0, len(categoryFindings))
		for finding, count := range categoryFindings {
			parts = append(parts, fmt.Sprintf("%s=%d", finding, count))
		}
		sort.Strings(parts)
		warnings = append(warnings, "category resolution failures: "+strings.Join(parts, ", "))
	}

	snapshot := Snapshot{
		Sessions:      visible,
		ByID:          byID,
		LoadedAt:      now,
		IndexPath:     indexPath,
		CataloguePath: cataloguePath,
		Warnings:      warnings,
	}
	snapshot.Tree = buildTree(snapshot, indexed, catalogue, rollups)
	snapshot.Stats = buildStats(home, runtimeRoot, snapshot.Sessions, indexed, catalogue, rollups)
	return snapshot, nil
}

func shouldAggregateCategoryFinding(finding string) bool {
	return finding != "stored" && finding != "inherited" && finding != "uncategorized" && finding != "registry-unavailable"
}

func categoryRepairDisplay(finding string) (string, string, bool) {
	switch finding {
	case "cycle":
		return "Category ancestry cycle", "Cycle", true
	case "missing-parent":
		return "Missing category parent", "No parent", true
	case "depth-exceeded":
		return "Category ancestry exceeds the resolution limit", "Too deep", true
	case "parentless-auxiliary":
		return "Auxiliary session has no category parent", "Aux no parent", true
	default:
		return "", "", false
	}
}

func includeSession(row indexedSession, meta catalogueMeta, options LoadOptions) bool {
	// Deliberately not driven by a LoadOptions field, unlike every other exclusion here. The rest
	// are defaults with a reveal flag; this one is a guarantee, and adding an option would create
	// the listing the design says must not exist.
	if meta.Incognito {
		return false
	}
	if row.IsSubagent && !options.IncludeSubagents {
		return false
	}
	if meta.Saved && !options.IncludeSaved {
		return false
	}
	if meta.SessionClass == "auxiliary" && !options.IncludeAuxiliary {
		return false
	}
	return true
}

func envOr(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func liveState(row indexedSession, live map[string]liveSession) (bool, liveSession) {
	if entry, ok := live[row.ID]; ok {
		entry.Title = strings.TrimSpace(entry.Title)
		return true, entry
	}
	if row.ResumeID != "" {
		if entry, ok := live[row.ResumeID]; ok {
			entry.Title = strings.TrimSpace(entry.Title)
			return true, entry
		}
	}
	return false, liveSession{}
}

func resolveDisplayTitle(row indexedSession, meta catalogueMeta, liveTitle string) (string, string) {
	if liveTitle != "" {
		return liveTitle, "live"
	}
	if meta.CustomTitle != "" {
		return meta.CustomTitle, "custom"
	}
	// Enrichment outranks everything below it because it is the only title written with knowledge
	// of how the session ended; the index's own titles are guesses made from the opening turns.
	// It never outranks a name a human chose.
	if title := strings.TrimSpace(meta.Enrichment.Title); title != "" {
		return title, "enriched"
	}
	if role := strings.TrimSpace(meta.Role); role != "" {
		return role, "role"
	}
	return row.Title, row.TitleSource
}

func disposition(meta catalogueMeta, open bool) string {
	switch {
	case meta.Saved:
		return "saved"
	case meta.Completed || meta.Archived:
		return "completed"
	case meta.ParkedTaskID != "":
		return "parked"
	case open:
		return "active"
	default:
		return "idle"
	}
}

func displayClass(row indexedSession, meta catalogueMeta, loop bool) string {
	if loop {
		return "LOOP"
	}
	if meta.SessionClass == "auxiliary" {
		return "AUX"
	}
	rollout := parseTime(sessionClassRollout)
	if meta.SessionClass == "" && !row.FirstAt.IsZero() && !row.FirstAt.Before(rollout) {
		return "UNCLASSIFIED"
	}
	return ""
}

func dominantModel(costs map[string]float64, models []string) string {
	keys := make([]string, 0, len(costs))
	for model := range costs {
		keys = append(keys, model)
	}
	sort.Strings(keys)
	best := ""
	bestCost := -1.0
	for _, model := range keys {
		if costs[model] > bestCost {
			best = model
			bestCost = costs[model]
		}
	}
	if best != "" {
		return best
	}
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

func providerFor(row indexedSession) ProviderCost {
	var providers ProviderCost
	for model, cost := range row.CostByModel {
		switch providerFamily(model) {
		case "claude":
			providers.Claude += cost
		case "gpt":
			providers.GPT += cost
		default:
			providers.Other += cost
		}
	}
	if classified := providers.Total(); row.CostUSD > classified {
		providers.Other += row.CostUSD - classified
	}
	return providers
}

func providerFamily(model string) string {
	normalized := strings.ToLower(model)
	if strings.HasPrefix(normalized, "claude-") {
		return "claude"
	}
	if strings.Contains(normalized, "gpt") || strings.HasPrefix(normalized, "o1") || strings.HasPrefix(normalized, "o3") || strings.HasPrefix(normalized, "o4") {
		return "gpt"
	}
	return "other"
}

func buildRollups(indexed []indexedSession, catalogue map[string]catalogueMeta) (map[string]sessionRollup, map[string]int) {
	rows := make(map[string]indexedSession, len(indexed))
	aliases := make(map[string]string, len(indexed)*2)
	selfProviders := make(map[string]ProviderCost, len(indexed))
	for _, row := range indexed {
		rows[row.ID] = row
		aliases[row.ID] = row.ID
		if row.ResumeID != "" {
			aliases[row.ResumeID] = row.ID
		}
		selfProviders[row.ID] = providerFor(row)
	}
	childrenSet := make(map[string]map[string]bool)
	addEdge := func(parentAlias string, childAlias string) {
		parent := aliases[parentAlias]
		child := aliases[childAlias]
		if parent == "" || child == "" || parent == child {
			return
		}
		if childrenSet[parent] == nil {
			childrenSet[parent] = make(map[string]bool)
		}
		childrenSet[parent][child] = true
	}
	subagentCounts := make(map[string]int)
	for _, row := range indexed {
		if row.IsSubagent && row.ParentSessionID != "" {
			addEdge(row.ParentSessionID, row.ID)
			if parent := aliases[row.ParentSessionID]; parent != "" {
				subagentCounts[parent]++
			}
		}
	}
	for childID, meta := range catalogue {
		if meta.ParentSessionID != "" {
			addEdge(meta.ParentSessionID, childID)
		}
	}
	children := make(map[string][]string, len(childrenSet))
	for parent, set := range childrenSet {
		for child := range set {
			children[parent] = append(children[parent], child)
		}
		sort.Strings(children[parent])
	}

	rollups := make(map[string]sessionRollup, len(indexed))
	for _, row := range indexed {
		seen := make(map[string]bool)
		var visit func(string) ProviderCost
		visit = func(id string) ProviderCost {
			if seen[id] {
				return ProviderCost{}
			}
			seen[id] = true
			total := selfProviders[id]
			for _, child := range children[id] {
				total = total.Add(visit(child))
			}
			return total
		}
		providers := visit(row.ID)
		total := providers.Total()
		if math.IsNaN(total) || math.IsInf(total, 0) || total < 0 {
			total = 0
		}
		rollups[row.ID] = sessionRollup{
			Self:       row.CostUSD,
			Total:      total,
			Providers:  providers,
			Descendant: maxInt(0, len(seen)-1),
		}
	}
	return rollups, subagentCounts
}

func buildTree(snapshot Snapshot, indexed []indexedSession, catalogue map[string]catalogueMeta, rollups map[string]sessionRollup) []TreeNode {
	aliases := make(map[string]string, len(indexed)*2)
	for _, row := range indexed {
		aliases[row.ID] = row.ID
		if row.ResumeID != "" {
			aliases[row.ResumeID] = row.ID
		}
	}
	visible := make(map[string]bool, len(snapshot.Sessions))
	for _, session := range snapshot.Sessions {
		visible[session.ID] = true
	}
	childrenSet := make(map[string]map[string]bool)
	members := make(map[string]bool)
	isChild := make(map[string]bool)
	for childAlias, meta := range catalogue {
		if meta.ParentSessionID == "" {
			continue
		}
		parent := aliases[meta.ParentSessionID]
		child := aliases[childAlias]
		if parent != "" && visible[parent] {
			members[parent] = true
		}
		if parent == "" || child == "" || parent == child || !visible[parent] || !visible[child] {
			continue
		}
		if childrenSet[parent] == nil {
			childrenSet[parent] = make(map[string]bool)
		}
		childrenSet[parent][child] = true
		members[child] = true
		isChild[child] = true
	}
	lessCost := func(left string, right string) bool {
		leftCost := rollups[left].Total
		rightCost := rollups[right].Total
		if leftCost != rightCost {
			return leftCost > rightCost
		}
		return left < right
	}
	children := make(map[string][]string, len(childrenSet))
	for parent, set := range childrenSet {
		for child := range set {
			children[parent] = append(children[parent], child)
		}
		sort.Slice(children[parent], func(i int, j int) bool {
			return lessCost(children[parent][i], children[parent][j])
		})
	}
	roots := make([]string, 0, len(members))
	for id := range members {
		if !isChild[id] {
			roots = append(roots, id)
		}
	}
	if len(roots) == 0 {
		for id := range members {
			roots = append(roots, id)
		}
	}
	sort.Slice(roots, func(i int, j int) bool { return lessCost(roots[i], roots[j]) })

	out := make([]TreeNode, 0, len(members))
	visited := make(map[string]bool)
	var walk func(string, int)
	walk = func(id string, depth int) {
		if visited[id] {
			return
		}
		visited[id] = true
		session, ok := snapshot.SessionByID(id)
		if !ok {
			return
		}
		rollup := rollups[id]
		out = append(out, TreeNode{
			SessionID: id,
			ID:        shortID(id),
			Title:     session.Title,
			Role:      session.Role,
			Depth:     depth,
			SelfCost:  rollup.Self,
			TotalCost: rollup.Total,
			Providers: rollup.Providers,
		})
		for _, child := range children[id] {
			walk(child, depth+1)
		}
	}
	for _, root := range roots {
		walk(root, 0)
	}
	return out
}

func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

func buildStats(home string, runtimeRoot string, sessions []Session, indexed []indexedSession, catalogue map[string]catalogueMeta, rollups map[string]sessionRollup) Dash {
	stats := Dash{Host: loadHostLabel(home, runtimeRoot), Sessions: len(sessions)}
	for _, row := range indexed {
		// This loop reads `indexed` directly rather than the already-filtered `sessions`, so the
		// includeSession gate above does not cover it. An incognito session left in here would not
		// be named anywhere, but its cost would still move the dashboard total — enough of a tell
		// to defeat the point.
		if catalogue[row.ID].Incognito {
			continue
		}
		stats.Spend += row.CostUSD
		if row.IsSubagent || catalogue[row.ID].SessionClass == "auxiliary" {
			stats.AgentSpend += row.CostUSD
		}
	}
	for _, session := range sessions {
		if session.IsLoop {
			stats.Loops++
			stats.LoopSpend += rollups[session.ID].Total
		} else {
			switch session.State {
			case "active":
				stats.Active++
			case "parked":
				stats.Parked++
			}
		}
		if session.TotalCost > stats.TopCost || (session.TotalCost == stats.TopCost && session.Title < stats.TopTitle) {
			stats.TopCost = session.TotalCost
			stats.TopTitle = session.Title
		}
	}
	return stats
}

func loadHostLabel(home string, runtimeRoot string) string {
	fallback, err := os.Hostname()
	if err != nil || fallback == "" {
		fallback = filepath.Base(home)
	}
	fallback = normalizeInline(fallback)
	file, err := os.Open(filepath.Join(runtimeRoot, "config.toml"))
	if err != nil {
		return fallback
	}
	defer file.Close()
	section := ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			continue
		}
		if section != "host" {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(key) != "label" {
			continue
		}
		if parsed := normalizeInline(parseTOMLString(value)); parsed != "" {
			return parsed
		}
	}
	return fallback
}

func loadRoleKinds(home string) map[string]string {
	root := strings.TrimSpace(os.Getenv("CCS_CONFIG_ROOT"))
	if root == "" {
		root = filepath.Join(home, ".ccs-config")
	}
	pattern := filepath.Join(root, "clusters", "*", "roles", "*", "role.toml")
	paths, err := filepath.Glob(pattern)
	if err != nil {
		return map[string]string{}
	}
	sort.Strings(paths)
	out := make(map[string]string)
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		kind := ""
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
			key, value, found := strings.Cut(line, "=")
			if found && strings.TrimSpace(key) == "kind" {
				kind = parseTOMLString(value)
				break
			}
		}
		file.Close()
		if kind == "" {
			continue
		}
		role := normalizeInline(filepath.Base(filepath.Dir(path)))
		cluster := normalizeInline(filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path)))))
		out[roleKey(cluster, role)] = normalizeInline(kind)
	}
	return out
}

func roleKey(cluster string, role string) string {
	return cluster + "\x00" + role
}

func parseTOMLString(value string) string {
	value = strings.TrimSpace(value)
	if parsed, err := strconv.Unquote(value); err == nil {
		return strings.TrimSpace(parsed)
	}
	return strings.Trim(strings.TrimSpace(value), "'\"")
}
