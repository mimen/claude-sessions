package theme

import "github.com/charmbracelet/lipgloss"

// CCS-specific semantic mappings, layered on the charmtone tokens. These mirror
// the real ccs theme.ts / format.ts so the port reads as the same tool.

// CostColor grades a USD amount into a restrained tier — most rows read calm,
// warmth is reserved for genuine outliers (crush/gh-dash cost discipline).
func CostColor(usd float64) lipgloss.Color {
	switch {
	case usd < 1:
		return lipgloss.Color("#5B6472") // barely-there
	case usd < 100:
		return lipgloss.Color("#9AA3B2") // neutral secondary
	case usd < 500:
		return lipgloss.Color("#C99A6B") // soft gold
	default:
		return lipgloss.Color("#E0876A") // soft coral (never pure red)
	}
}

// ModelBadge is a short family label + stable color, keyed off a model id.
type ModelBadge struct {
	Label string
	Color lipgloss.Color
}

var modelFamilies = []struct {
	prefix, label, color string
}{
	{"gpt-5.6-sol", "sol", "#4FB3A9"},
	{"gpt-5.6-terra", "terra", "#3D8F87"},
	{"gpt-5.6-luna", "luna", "#6FCFC4"},
	{"gpt-", "gpt", "#4FB3A9"},
	{"claude-fable", "fable", "#A689C9"},
	{"claude-mythos", "mythos", "#A689C9"},
	{"claude-opus", "opus", "#C99A6B"},
	{"claude-sonnet", "sonnet", "#6F9BC2"},
	{"claude-haiku", "haiku", "#7BA85F"},
	{"claude-3-opus", "opus", "#C99A6B"},
	{"claude-3-5-sonnet", "sonnet", "#6F9BC2"},
	{"claude-3-7-sonnet", "sonnet", "#6F9BC2"},
	{"claude-3-5-haiku", "haiku", "#7BA85F"},
	{"claude-3-haiku", "haiku", "#7BA85F"},
}

func Model(id string) ModelBadge {
	for _, f := range modelFamilies {
		if len(id) >= len(f.prefix) && id[:len(f.prefix)] == f.prefix {
			return ModelBadge{f.label, lipgloss.Color(f.color)}
		}
	}
	return ModelBadge{"·", FgMostSubtle}
}

// StateColor maps a session lifecycle/open-state to a dot color.
func StateColor(state string) lipgloss.Color {
	switch state {
	case "active":
		return Success
	case "idle":
		return FgMoreSubtle
	case "parked":
		return Warning
	case "completed", "done":
		return Info
	case "archived":
		return FgMostSubtle
	case "loop":
		return Accent
	default:
		return FgMostSubtle
	}
}

// StageColor maps the monotonic worker pipeline onto restrained progress colors.
func StageColor(stage string) lipgloss.Color {
	switch stage {
	case "building":
		return Info
	case "milad-review":
		return Warning
	case "in-review":
		return Accent
	case "approved":
		return Success
	case "merged":
		return SuccessDim
	default:
		return FgMostSubtle
	}
}

// RecommendationColor maps an enrichment's recommended next action onto the same restrained
// palette the rest of the dossier uses.
//
// The colors encode how much the row wants from you, not how the session "did": `handoff` is the
// loudest because it is the only value that needs a person to move it, `continue` is neutral
// because live work is the normal case, and both closing verbs are dim — they are chores, and a
// wall of alarm-colored finished sessions would train the eye to ignore the panel.
func RecommendationColor(recommendation string) lipgloss.Color {
	switch recommendation {
	case "continue":
		return Info
	case "complete":
		return Success
	case "archive":
		return FgMostSubtle
	case "handoff":
		return Warning
	default:
		return FgMostSubtle
	}
}

// ClassColor maps a classification badge to a color.
func ClassColor(class string) lipgloss.Color {
	switch class {
	case "AUX":
		return Accent
	case "LOOP":
		return lipgloss.Color("#A689C9")
	case "UNCLASSIFIED":
		return FgMostSubtle
	default:
		return Warning
	}
}

// AgeColor: recent activity reads brighter than stale.
func AgeColor(recent bool) lipgloss.Color {
	if recent {
		return lipgloss.Color("#12C78F")
	}
	return lipgloss.Color("#9AA3B2")
}
