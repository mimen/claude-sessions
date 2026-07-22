# ccs-tui-go-spike

A **throwaway visual spike** — what the `ccs` session browser could look like
ported off Ink onto the Charm stack (Bubble Tea + Lipgloss), the toolchain
behind crush / gh-dash. Mocked data drawn from real `ccs ls` / `ccs tree`
output; no store read, no network.

## Run it

```bash
cd /Users/mimen/Programming/Repos/ccs-tui-go-spike
go run .        # ↑↓ move · g toggle groups/tree · r resume-via · p preview · ? help · q quit
```

## What it mirrors (real ccs functionality)

- **Two-pane browser**: grouped session list + preview dossier — the current
  `ccs` (no-arg) TUI, re-skinned.
- **Header dashboard**: `ccs · host · N sessions · $spend · active · parked`
  and `loops · in-subagents · top` — same stats as `Header.tsx`.
- **Dense session rows**: state dot · title · classification/role badges ·
  model-family badge (sol/terra/fable/opus/sonnet in their real hues from
  `format.ts`) · cost (tiered) · age (recency) · subagent count.
- **Preview dossier**: per-vendor cost split (Claude/GPT bars), model, cwd,
  duration, cluster/role, last activity.
- **Tree view** (`g`): causal tree with `$self · $total · Claude · GPT · other`
  rollup — the `ccs tree` output.
- **Route picker** (`r`): "resume via…" launcher list (claude / claude-gpt /
  cmux / codex) with eligibility + reasons — the cross-backend resume.

## Why this stack

The current ccs TUI is **Ink** (React). The research from earlier: Ink is the
mainstream choice but has redaw/flicker ceilings; OpenCode/crush moved to a
Zig+cell-buffer stack for exactly the dense, live-updating case a session
browser is. This spike is Go/Bubble Tea (v1 for reliability); the equivalent
in-lane TS upgrade would be **OpenTUI**, keeping you on Bun.

The single highest-value port, framework-independent: the **charmtone token
layer** in `theme/` + the cost/model/state color functions in `theme/ccs.go`,
which mirror `ccs`'s own `theme.ts` / `format.ts` semantics.

## Files

- `theme/tokens.go`, `theme/render.go` — charmtone palette, gradients, helpers
- `theme/ccs.go` — cost tiers, model-family badges, state/class/age colors
- `data/mock.go` — real sessions/tree/launchers, mocked
- `ui/model.go` — single Bubble Tea model + view/overlay state
- `ui/view.go` — header, list, preview, tree, overlays, keybar
- `ui/shot.go` + `SHOT=<view>` — static render mode for `freeze`
- `demo.tape` — VHS walkthrough script · `shots/` — PNGs + demo.gif
