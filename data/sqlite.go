package data

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type indexedSession struct {
	ID              string
	Host            string
	Path            string
	CWD             string
	ProjectRoot     string
	ProjectName     string
	Branch          string
	FirstAt         time.Time
	LastAt          time.Time
	Messages        int
	NativeTitle     string
	CodexTitle      string
	FallbackTitle   string
	Title           string
	TitleSource     string
	IsSubagent      bool
	ParentSessionID string
	ResumeID        string
	CostUSD         float64
	CostByModel     map[string]float64
	Models          []string
	Skeleton        string
}

type catalogueMeta struct {
	SessionID       string
	CustomTitle     string
	Completed       bool
	Archived        bool
	ParkedTaskID    string
	ParentSessionID string
	SessionClass    string
	IdentityKey     string
	Cluster         string
	Role            string
	IdentityKind    string
	Stage           string
	PRNumber        int
	PRState         string
}

func openReadOnlySQLite(path string) (*sql.DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	u := &url.URL{Scheme: "file", Path: path}
	query := u.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return db, nil
}

func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

func hasTable(db *sql.DB, table string) (bool, error) {
	var name string
	err := db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func selectColumn(columns map[string]bool, name string, fallback string) string {
	if columns[name] {
		return name
	}
	return fallback + " AS " + name
}

func loadIndex(path string) ([]indexedSession, error) {
	db, err := openReadOnlySQLite(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	columns, err := tableColumns(db, "sessions")
	if err != nil {
		return nil, fmt.Errorf("inspect index schema: %w", err)
	}
	for _, required := range []string{"session_id", "host", "project_name", "fallback_label"} {
		if !columns[required] {
			return nil, fmt.Errorf("index schema is missing required sessions.%s", required)
		}
	}
	selected := []string{
		"session_id",
		selectColumn(columns, "host", "''"),
		selectColumn(columns, "path", "''"),
		selectColumn(columns, "cwd", "NULL"),
		selectColumn(columns, "project_root", "''"),
		selectColumn(columns, "project_name", "'(unknown)'"),
		selectColumn(columns, "branch", "NULL"),
		selectColumn(columns, "first_ts", "NULL"),
		selectColumn(columns, "last_ts", "NULL"),
		selectColumn(columns, "msg_count", "0"),
		selectColumn(columns, "native_title", "NULL"),
		selectColumn(columns, "codex_title", "NULL"),
		selectColumn(columns, "fallback_label", "'(untitled)'"),
		selectColumn(columns, "is_subagent", "0"),
		selectColumn(columns, "parent_session_id", "NULL"),
		selectColumn(columns, "resume_id", "''"),
		selectColumn(columns, "cost_usd", "0"),
		selectColumn(columns, "cost_by_model", "'{}'"),
		selectColumn(columns, "models", "'[]'"),
		selectColumn(columns, "skeleton", "''"),
	}
	query := "SELECT " + strings.Join(selected, ", ") +
		" FROM sessions ORDER BY last_ts IS NULL, last_ts DESC, session_id"
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("query index: %w", err)
	}
	defer rows.Close()
	out := make([]indexedSession, 0, 256)
	for rows.Next() {
		var row indexedSession
		var cwd sql.NullString
		var branch sql.NullString
		var firstTS sql.NullString
		var lastTS sql.NullString
		var nativeTitle sql.NullString
		var codexTitle sql.NullString
		var parentID sql.NullString
		var subagent int
		var costJSON string
		var modelsJSON string
		if err := rows.Scan(
			&row.ID,
			&row.Host,
			&row.Path,
			&cwd,
			&row.ProjectRoot,
			&row.ProjectName,
			&branch,
			&firstTS,
			&lastTS,
			&row.Messages,
			&nativeTitle,
			&codexTitle,
			&row.FallbackTitle,
			&subagent,
			&parentID,
			&row.ResumeID,
			&row.CostUSD,
			&costJSON,
			&modelsJSON,
			&row.Skeleton,
		); err != nil {
			return nil, fmt.Errorf("scan index row: %w", err)
		}
		row.ID = normalizeInline(row.ID)
		if row.ID == "" {
			continue
		}
		row.Host = normalizeInline(row.Host)
		row.Path = normalizeInline(row.Path)
		row.CWD = normalizeInline(cwd.String)
		row.ProjectRoot = normalizeInline(row.ProjectRoot)
		row.ProjectName = normalizeInline(row.ProjectName)
		row.Branch = normalizeInline(branch.String)
		row.NativeTitle = normalizeInline(nativeTitle.String)
		row.CodexTitle = normalizeInline(codexTitle.String)
		row.FallbackTitle = normalizeInline(row.FallbackTitle)
		row.Skeleton = normalizeMultiline(row.Skeleton)
		row.ParentSessionID = normalizeInline(parentID.String)
		row.ResumeID = normalizeInline(row.ResumeID)
		row.IsSubagent = subagent != 0
		row.FirstAt = parseTime(firstTS.String)
		row.LastAt = parseTime(lastTS.String)
		row.Title, row.TitleSource = resolveIndexTitle(row.NativeTitle, row.CodexTitle, row.FallbackTitle)
		row.CostByModel = parseCostByModel(costJSON)
		row.Models = parseModels(modelsJSON)
		if row.ResumeID == "" {
			row.ResumeID = row.ID
		}
		if row.ProjectName == "" {
			row.ProjectName = "(unknown)"
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read index rows: %w", err)
	}
	return out, nil
}

func prefixedColumn(columns map[string]bool, prefix string, name string, fallback string) string {
	if columns[name] {
		return prefix + "." + name
	}
	return fallback
}

func loadCatalogue(path string) (map[string]catalogueMeta, error) {
	db, err := openReadOnlySQLite(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	catalogueExists, err := hasTable(db, "catalogue")
	if err != nil {
		return nil, fmt.Errorf("inspect catalogue: %w", err)
	}
	if !catalogueExists {
		return map[string]catalogueMeta{}, nil
	}
	catalogueColumns, err := tableColumns(db, "catalogue")
	if err != nil {
		return nil, fmt.Errorf("inspect catalogue schema: %w", err)
	}
	if !catalogueColumns["session_id"] {
		return nil, errors.New("catalogue schema is missing catalogue.session_id")
	}
	identityExists, err := hasTable(db, "identities")
	if err != nil {
		return nil, fmt.Errorf("inspect identities: %w", err)
	}
	identityColumns := map[string]bool{}
	identityJoin := ""
	if identityExists && catalogueColumns["identity_key"] {
		identityColumns, err = tableColumns(db, "identities")
		if err != nil {
			return nil, fmt.Errorf("inspect identities schema: %w", err)
		}
		if identityColumns["identity_key"] {
			identityJoin = " LEFT JOIN identities i ON i.identity_key = c.identity_key"
		}
	}
	identityExpr := func(name string, fallback string) string {
		if identityJoin != "" && identityColumns[name] {
			return "i." + name
		}
		return fallback
	}
	identityNumberExpr := func(name string) string {
		if identityJoin != "" && identityColumns[name] {
			return "COALESCE(i." + name + ", 0)"
		}
		return "0"
	}

	stageExpr := prefixedColumn(catalogueColumns, "c", "stage", "NULL")
	if identityJoin != "" && identityColumns["stage"] {
		stageExpr = "i.stage"
		if catalogueColumns["stage"] {
			stageExpr = "COALESCE(i.stage, c.stage)"
		}
	}

	prNumberExpr := prefixedColumn(catalogueColumns, "c", "pr_number", "NULL")
	prStateExpr := prefixedColumn(catalogueColumns, "c", "pr_state", "NULL")
	prJoin := ""
	prTableExists, prTableErr := hasTable(db, "identity_pr_agent")
	if prTableErr != nil {
		return nil, fmt.Errorf("inspect pr-agent identity attributes: %w", prTableErr)
	}
	if prTableExists && catalogueColumns["identity_key"] {
		prColumns, columnsErr := tableColumns(db, "identity_pr_agent")
		if columnsErr != nil {
			return nil, fmt.Errorf("inspect pr-agent identity schema: %w", columnsErr)
		}
		if prColumns["identity_key"] {
			prJoin = " LEFT JOIN identity_pr_agent p ON p.identity_key = c.identity_key"
			if prColumns["pr_number"] {
				prNumberExpr = "p.pr_number"
				if catalogueColumns["pr_number"] {
					prNumberExpr = "COALESCE(p.pr_number, c.pr_number)"
				}
			}
			if prColumns["pr_state"] {
				prStateExpr = "p.pr_state"
				if catalogueColumns["pr_state"] {
					prStateExpr = "COALESCE(p.pr_state, c.pr_state)"
				}
			}
		}
	}

	selected := []string{
		"c.session_id",
		prefixedColumn(catalogueColumns, "c", "custom_title", "NULL"),
		prefixedColumn(catalogueColumns, "c", "completed", "0"),
		prefixedColumn(catalogueColumns, "c", "archived", "0"),
		prefixedColumn(catalogueColumns, "c", "parked_task_id", "NULL"),
		prefixedColumn(catalogueColumns, "c", "parent_session_id", "NULL"),
		prefixedColumn(catalogueColumns, "c", "session_class", "NULL"),
		prefixedColumn(catalogueColumns, "c", "identity_key", "NULL"),
		identityExpr("cluster", "NULL"),
		identityExpr("role", "NULL"),
		identityExpr("kind", "NULL"),
		identityNumberExpr("completed"),
		identityNumberExpr("archived"),
		identityExpr("parked_task_id", "NULL"),
		stageExpr,
		prNumberExpr,
		prStateExpr,
	}
	rows, err := db.Query("SELECT " + strings.Join(selected, ", ") + " FROM catalogue c" + identityJoin + prJoin)
	if err != nil {
		return nil, fmt.Errorf("query catalogue: %w", err)
	}
	defer rows.Close()
	out := make(map[string]catalogueMeta)
	for rows.Next() {
		var row catalogueMeta
		var customTitle sql.NullString
		var parked sql.NullString
		var parent sql.NullString
		var sessionClass sql.NullString
		var identityKey sql.NullString
		var cluster sql.NullString
		var role sql.NullString
		var identityKind sql.NullString
		var stage sql.NullString
		var prNumber sql.NullInt64
		var prState sql.NullString
		var completed int
		var archived int
		var identityCompleted int
		var identityArchived int
		var identityParked sql.NullString
		if err := rows.Scan(
			&row.SessionID,
			&customTitle,
			&completed,
			&archived,
			&parked,
			&parent,
			&sessionClass,
			&identityKey,
			&cluster,
			&role,
			&identityKind,
			&identityCompleted,
			&identityArchived,
			&identityParked,
			&stage,
			&prNumber,
			&prState,
		); err != nil {
			return nil, fmt.Errorf("scan catalogue row: %w", err)
		}
		row.SessionID = normalizeInline(row.SessionID)
		if row.SessionID == "" {
			continue
		}
		row.CustomTitle = normalizeInline(customTitle.String)
		row.Completed = completed != 0 || identityCompleted != 0
		row.Archived = archived != 0 || identityArchived != 0
		row.ParkedTaskID = normalizeInline(parked.String)
		if row.ParkedTaskID == "" {
			row.ParkedTaskID = normalizeInline(identityParked.String)
		}
		row.ParentSessionID = normalizeInline(parent.String)
		row.SessionClass = normalizeInline(sessionClass.String)
		row.IdentityKey = normalizeInline(identityKey.String)
		row.Cluster = normalizeInline(cluster.String)
		row.Role = normalizeInline(role.String)
		row.IdentityKind = normalizeInline(identityKind.String)
		row.Stage = normalizeInline(stage.String)
		if prNumber.Valid && prNumber.Int64 > 0 && prNumber.Int64 <= int64(^uint(0)>>1) {
			row.PRNumber = int(prNumber.Int64)
		}
		row.PRState = normalizeInline(prState.String)
		out[row.SessionID] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read catalogue rows: %w", err)
	}
	return out, nil
}

func parseTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func resolveIndexTitle(nativeTitle string, codexTitle string, fallback string) (string, string) {
	if title := strings.TrimSpace(nativeTitle); title != "" {
		return title, "native"
	}
	if title := strings.TrimSpace(codexTitle); title != "" {
		return title, "codex"
	}
	if title := strings.TrimSpace(fallback); title != "" {
		return title, "fallback"
	}
	return "(untitled)", "fallback"
}

func parseCostByModel(value string) map[string]float64 {
	decoded := make(map[string]float64)
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return map[string]float64{}
	}
	normalized := make(map[string]float64, len(decoded))
	for model, cost := range decoded {
		model = normalizeInline(model)
		if model == "" || cost < 0 {
			continue
		}
		normalized[model] += cost
	}
	return normalized
}

func parseModels(value string) []string {
	var decoded []string
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return nil
	}
	seen := make(map[string]bool)
	models := make([]string, 0, len(decoded))
	for _, model := range decoded {
		model = normalizeInline(model)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}
