package data

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// FormatAge mirrors ccs's compact age labels.
func FormatAge(at time.Time, now time.Time) string {
	if at.IsZero() {
		return "?"
	}
	seconds := int64(now.Sub(at).Seconds())
	if seconds < 0 {
		seconds = 0
	}
	if seconds < 60 {
		return "now"
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm", minutes)
	}
	hours := minutes / 60
	if hours < 24 {
		return fmt.Sprintf("%dh", hours)
	}
	days := hours / 24
	if days < 7 {
		return fmt.Sprintf("%dd", days)
	}
	weeks := days / 7
	if weeks < 5 {
		return fmt.Sprintf("%dw", weeks)
	}
	months := days / 30
	if months < 12 {
		return fmt.Sprintf("%dmo", months)
	}
	return fmt.Sprintf("%dy", days/365)
}

// IsRecentAge applies the same minute/hour recency rule as the Ink TUI.
func IsRecentAge(age string) bool {
	return age == "now" || strings.HasSuffix(age, "m") || strings.HasSuffix(age, "h")
}

// FormatCost renders precise costs for previews and tree rollups.
func FormatCost(usd float64) string {
	if !(usd > 0) || math.IsNaN(usd) || math.IsInf(usd, 0) {
		return ""
	}
	if usd < 0.995 {
		return fmt.Sprintf("%d¢", maxInt(1, int(math.Round(usd*100))))
	}
	if usd < 100 {
		return fmt.Sprintf("$%.2f", usd)
	}
	return fmt.Sprintf("$%.0f", usd)
}

// FormatCostList renders the calmer, whole-dollar list column.
func FormatCostList(usd float64) string {
	if !(usd > 0) || math.IsNaN(usd) || math.IsInf(usd, 0) {
		return ""
	}
	if usd < 1 {
		return fmt.Sprintf("%d¢", maxInt(1, int(math.Round(usd*100))))
	}
	return fmt.Sprintf("$%.0f", usd)
}

// FormatCompactUSD renders dashboard aggregates.
func FormatCompactUSD(usd float64) string {
	if math.IsNaN(usd) || math.IsInf(usd, 0) || usd < 0 {
		usd = 0
	}
	if usd < 1000 {
		return fmt.Sprintf("$%.0f", usd)
	}
	if usd < 1_000_000 {
		if usd < 10_000 {
			return fmt.Sprintf("$%.1fk", usd/1000)
		}
		return fmt.Sprintf("$%.0fk", usd/1000)
	}
	return fmt.Sprintf("$%.1fm", usd/1_000_000)
}

// FormatSpan renders a wall-clock span compactly.
func FormatSpan(first time.Time, last time.Time) string {
	if first.IsZero() || last.IsZero() || last.Before(first) {
		return "?"
	}
	seconds := last.Sub(first).Seconds()
	if seconds < 90 {
		return fmt.Sprintf("%.0fs", seconds)
	}
	minutes := seconds / 60
	if minutes < 90 {
		return fmt.Sprintf("%.0fm", minutes)
	}
	hours := minutes / 60
	if hours < 48 {
		if hours < 10 {
			return fmt.Sprintf("%.1fh", hours)
		}
		return fmt.Sprintf("%.0fh", hours)
	}
	return fmt.Sprintf("%.1fd", hours/24)
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
