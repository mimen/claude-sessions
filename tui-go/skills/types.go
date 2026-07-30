// Package skills provides a read-only machine-wide skill registry for the TUI.
package skills

// Usage is the cached transcript-observed activity for one logical skill name.
type Usage struct {
	Invocations int
	Commands    int
	Reads       int
	LastUsed    string
}

// Skill is one physical/canonical skill directory.
type Skill struct {
	Name        string
	Path        string
	RealPath    string
	Ecosystem   string
	Home        string
	Description string
	Category    string
	// Source is the provenance slug (<owner>/<repo>) from SKILL.md frontmatter; "" is first-party.
	Source  string
	Aliases []string
	Tags    []string
	Hash    string
	Usage   Usage
	Drift   bool
}

// Snapshot is one immutable registry load.
type Snapshot struct {
	Skills   []Skill
	Warnings []string
	Source   string
}

// File is one readable file inside a skill directory.
type File struct {
	Relative string
	Size     int64
}
