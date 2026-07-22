// Package data holds mocked CCS records drawn from real `ccs ls` / `ccs tree`
// output, so the spike renders a realistic session browser with no store read.
package data

// Session mirrors a row in the ccs session list.
type Session struct {
	Glyph     string // ✎ native · ★ idle-with-title · ~ scratchpad
	Title     string
	State     string // active | idle | completed | parked
	Class     string // UNCLASSIFIED | LOOP | AUX | ""
	Role      string // coordinator | scout | ""
	Cluster   string // event-watch:coordinator | ""
	Project   string
	Age       string
	Recent    bool
	Model     string // dominant model id
	Cost      float64
	CostLabel string // pre-formatted ($237, 18¢)
	Duration  string
	Subagents int
}

// Grouped by project (the default "groups" view).
var Sessions = []Session{
	{"✎", "cd /Users/mimen/…/auf-tui-go-spike", "active", "UNCLASSIFIED", "", "", "Repos", "now", true, "claude-fable-5", 20.42, "$20", "340m", 3},
	{"✎", "Filter subagent session runs", "active", "", "", "", "Repos", "now", true, "gpt-5.6-sol", 237, "$237", "7845m", 12},
	{"✎", "T3 Code Fork Work", "active", "", "", "", "Repos", "14m", true, "gpt-5.6-terra", 198, "$198", "8161m", 8},
	{"✎", "Port CCS from Work Laptop", "active", "", "", "", "Repos", "15m", true, "claude-opus-4-8", 192, "$192", "2207m", 5},
	{"✎", "Replace Plan Mode With HTML Plans", "completed", "UNCLASSIFIED", "", "", "Repos", "2h", false, "claude-opus-4-8", 99.79, "$100", "1748m", 4},

	{"✎", "Design Claude Code default statusline", "active", "UNCLASSIFIED", "", "", "mimen", "now", true, "claude-fable-5", 3.40, "$3", "29m", 1},
	{"✎", "Add Manual And Auto Refresh To CCS TUI", "completed", "UNCLASSIFIED", "", "", "mimen", "2m", true, "claude-opus-4-8", 7.87, "$8", "174m", 2},
	{"★", "Set up Crush with Codex subscription", "idle", "UNCLASSIFIED", "", "", "mimen", "43m", true, "claude-sonnet-5", 1.47, "$1", "69m", 0},
	{"✎", "Ship Native Claude Swap Menu Bar", "completed", "", "", "", "mimen", "2h", false, "claude-opus-4-8", 137, "$137", "1590m", 6},

	{"✎", "coordinator", "idle", "LOOP", "coordinator", "event-watch:coordinator", "milad-vault", "53m", true, "claude-opus-4-8", 127, "$127", "867m", 0},
	{"✎", "scout", "idle", "LOOP", "scout", "event-watch:scout", "milad-vault", "53m", true, "claude-haiku-4-5", 4.42, "$4", "21m", 0},
	{"✎", "Messages Design", "active", "", "", "", "milad-vault", "9h", true, "claude-fable-5", 563, "$563", "3584m", 9},

	{"✎", "T3 Code Sessions Import", "active", "UNCLASSIFIED", "", "", "t3code", "16m", true, "gpt-5.6-sol", 196, "$196", "4965m", 7},
	{"✎", "Agentic Engine Project", "active", "UNCLASSIFIED", "", "", "t3code", "5h", false, "claude-opus-4-8", 28.99, "$29", "440m", 3},

	{"✎", "Ship ccs Plugin and Unify Session Titling", "completed", "UNCLASSIFIED", "", "", "claude-sessions", "35m", true, "claude-fable-5", 38.14, "$38", "658m", 4},
	{"★", "Debug cmux hook-store binding error", "idle", "UNCLASSIFIED", "", "", "convex-db", "1d", false, "claude-opus-4-8", 54.84, "$55", "313m", 3},
	{"~", "Confirm Exact Reply Handling", "idle", "", "", "", "scratchpad", "2h", false, "gpt-5.6-luna", 0.18, "18¢", "6m", 0},
}

// Dashboard aggregate stats (header).
type Dash struct {
	Host       string
	Sessions   int
	Spend      string
	Active     int
	Parked     int
	Loops      int
	LoopSpend  string
	AgentSpend string
	TopCost    string
	TopTitle   string
}

var Stats = Dash{
	Host: "sol-mini", Sessions: 47, Spend: "$2.9k", Active: 18, Parked: 2,
	Loops: 2, LoopSpend: "$131", AgentSpend: "$237",
	TopCost: "$761", TopTitle: "Find updated flyer in Slack channel",
}

// TreeNode is a causal-tree row with per-vendor cost rollup (ccs tree).
type TreeNode struct {
	ID      string
	Title   string
	Role    string
	Depth   int
	Self    string
	Total   string
	Claude  string
	GPT     string
	Other   string
}

var Tree = []TreeNode{
	{"c71407a7", "Find updated flyer in Slack channel", "event-worker", 0, "$758", "$761", "$761", "", ""},
	{"62b9efe5", "Dive club portal implementation", "", 0, "$476", "$482", "$480", "$2.10", ""},
	{"754b9a1a", "priority-shelf-redesign", "", 0, "$54.67", "$380", "$236", "$144", ""},
	{"3b292f6d", "cross-backend-provenance", "", 1, "$181", "$237", "$39.19", "$198", "1¢"},
	{"1f1ecde9", "Assess t3code resource usage", "", 1, "$83.64", "$196", "$75.59", "$121", ""},
	{"0d547643", "Set up T3 fork with Expo (desktop+mobile)", "", 1, "$122", "$198", "$85.92", "$112", "1¢"},
	{"6d3421ff", "fix-claude-sessions-regressions", "", 2, "$52.42", "$192", "$125", "$67.02", "1¢"},
	{"ff3da4a6", "Debug cmux hook-store binding error", "", 2, "$4.78", "$54.84", "$45.34", "$9.50", "1¢"},
	{"8a286799", "Research Claude Code account switchers", "", 1, "$35.36", "$137", "$74.22", "$62.67", "1¢"},
	{"22e5b3a4", "Explain GPT's Plan Mode Preference", "", 2, "$53.50", "$99.79", "$34.62", "$65.18", "1¢"},
}

// Launcher is a resume target for the route picker (r).
type Launcher struct {
	Name     string
	Backend  string
	Eligible bool
	Reason   string
}

var Launchers = []Launcher{
	{"claude", "native · Opus 4.8", true, "resumes inline in this terminal"},
	{"claude-gpt", "gateway · GPT-5.6 Sol", true, "cross-backend resume — billed to ChatGPT sub"},
	{"cmux", "native · new tab", true, "opens the session in a fresh cmux window"},
	{"codex", "openai · GPT-5.5", false, "transcript has Claude-only tool calls"},
}
