package data

import (
	"testing"
	"time"
)

func TestFormatAge(t *testing.T) {
	now := time.Date(2026, time.July, 22, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		at   time.Time
		want string
	}{
		{name: "missing", want: "?"},
		{name: "now", at: now.Add(-30 * time.Second), want: "now"},
		{name: "minutes", at: now.Add(-17 * time.Minute), want: "17m"},
		{name: "hours", at: now.Add(-9 * time.Hour), want: "9h"},
		{name: "days", at: now.Add(-3 * 24 * time.Hour), want: "3d"},
		{name: "weeks", at: now.Add(-21 * 24 * time.Hour), want: "3w"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := FormatAge(test.at, now); got != test.want {
				t.Fatalf("FormatAge() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeInlineStripsTerminalControls(t *testing.T) {
	got := normalizeInline(" first\nsecond\x1b[2J\tthird ")
	if got != "first second third" {
		t.Fatalf("normalizeInline() = %q", got)
	}
}

func TestCostFormats(t *testing.T) {
	if got := FormatCost(0.18); got != "18¢" {
		t.Fatalf("FormatCost() = %q", got)
	}
	if got := FormatCost(54.671); got != "$54.67" {
		t.Fatalf("FormatCost() = %q", got)
	}
	if got := FormatCostList(54.671); got != "$55" {
		t.Fatalf("FormatCostList() = %q", got)
	}
	if got := FormatCompactUSD(2900); got != "$2.9k" {
		t.Fatalf("FormatCompactUSD() = %q", got)
	}
}
