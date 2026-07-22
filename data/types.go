// Package data reads the existing CCS index and catalogue without reimplementing
// Claude Code transcript parsing. The SQLite files remain owned by ccs; this
// package opens them read-only and normalizes their rows for the TUI.
package data

import "time"

// ProviderCost is a cost rollup grouped by model vendor.
type ProviderCost struct {
	Claude float64
	GPT    float64
	Other  float64
}

// Add returns the component-wise sum of two provider rollups.
func (c ProviderCost) Add(other ProviderCost) ProviderCost {
	return ProviderCost{
		Claude: c.Claude + other.Claude,
		GPT:    c.GPT + other.GPT,
		Other:  c.Other + other.Other,
	}
}

// Total returns the complete provider spend.
func (c ProviderCost) Total() float64 {
	return c.Claude + c.GPT + c.Other
}

// Session is one normalized browser row backed by the CCS index and catalogue.
type Session struct {
	ID           string
	ResumeID     string
	Path         string
	Title        string
	TitleSource  string
	State        string
	Class        string
	SessionClass string
	IdentityKey  string
	IdentityKind string
	Role         string
	Cluster      string
	Project      string
	ProjectRoot  string
	CWD          string
	Branch       string
	Skeleton     string
	FirstAt      time.Time
	LastAt       time.Time
	Messages     int
	Models       []string
	Model        string
	SelfCost     float64
	TotalCost    float64
	ProviderCost ProviderCost
	Duration     string
	Subagents    int
	ParentID     string
	TaskSubjects []string
	TasksDone    int
	TasksTotal   int
	IsLoop       bool
}

// Dash contains the aggregate values rendered in the dashboard header.
type Dash struct {
	Host       string
	Sessions   int
	Spend      float64
	Active     int
	Parked     int
	Loops      int
	LoopSpend  float64
	AgentSpend float64
	TopCost    float64
	TopTitle   string
}

// TreeNode is a causal-tree row with the same rollup semantics as ccs tree.
type TreeNode struct {
	SessionID string
	ID        string
	Title     string
	Role      string
	Depth     int
	SelfCost  float64
	TotalCost float64
	Providers ProviderCost
}

// Launcher is one real CCS launcher with its eligibility verdict.
type Launcher struct {
	Name     string
	Backend  string
	Env      map[string]string
	Target   string
	Eligible bool
	Default  bool
	Reason   string
}

// Snapshot is the immutable real-data view used by one TUI run.
type Snapshot struct {
	Sessions      []Session
	Tree          []TreeNode
	Stats         Dash
	ByID          map[string]int
	LoadedAt      time.Time
	IndexPath     string
	CataloguePath string
	Warnings      []string
}

// SessionByID returns a session from the snapshot.
func (s Snapshot) SessionByID(id string) (Session, bool) {
	idx, ok := s.ByID[id]
	if !ok || idx < 0 || idx >= len(s.Sessions) {
		return Session{}, false
	}
	return s.Sessions[idx], true
}
