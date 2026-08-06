# CCS cmux sidebar

[`sidebars/ccs.swift`](sidebars/ccs.swift) is the reviewed source for a T3 Sidebar V2-inspired live cmux workspace inbox. Its projection, lane, row, filtering, and action shapes deliberately reuse cmux's shipped `status-board.swift` and `finder.swift` examples. The installed copy belongs at `~/.config/cmux/sidebars/ccs.swift`; this repository never treats the user config as source.

Run these commands from the repository root.

## Install

```sh
bun run cmux:sidebar:install
```

The installer creates the target directory when needed and is idempotent when the installed file is unchanged. It refuses to overwrite a differing target. To replace one deliberately:

```sh
bun run cmux:sidebar:install:force
```

A forced replacement first copies the existing regular file to the backup path printed by the command. The target must be a regular file or absent; the installer refuses symlinks, directories, and other filesystem entry types. Backup and rollback preserve file contents, not original timestamps, extended attributes, or hard-link identity.

## Validate and use

```sh
bun run cmux:sidebar:validate  # cmux sidebar validate ccs
bun run cmux:sidebar:select    # use ccs in the left sidebar picker
bun run cmux:sidebar:open      # open ccs as a normal Bonsplit pane
```

The wrappers require the installed target to match the versioned source before invoking cmux.

Rows select workspaces with the documented `workspace.select` action. Workspaces with explicit cmux agent-message signals render as rich three-line cards under Agent activity; every other workspace renders as a compact row under Other workspaces. No CCS lifecycle or mutation action is exposed.

## cmux 0.64.20 compatibility

cmux [issue #7943](https://github.com/manaflow-ai/cmux/issues/7943) documents an interpreter bug where `field == nil` and `field != nil` evaluate as unsupported rather than Boolean. Validation still succeeds while filters or conditional rows silently disappear. The proposed fix in [PR #7971](https://github.com/manaflow-ai/cmux/pull/7971) is not merged.

This sidebar follows the working 0.64.20 path: optional values are inspected with `if let`, row caps are literals inside the view helpers that use them, and predicates return concrete Booleans before entering `filter`. Do not replace those forms with ordinary Swift nil comparisons until the upstream fix ships in the installed cmux version.

## Rollback

For a fresh install, remove only a target that still matches the versioned source:

```sh
cmp -s integrations/cmux/sidebars/ccs.swift ~/.config/cmux/sidebars/ccs.swift \
  && rm ~/.config/cmux/sidebars/ccs.swift
```

After a forced install, restore only while the installed target still matches the versioned source. This preserves both post-install edits and the backup itself:

```sh
source=integrations/cmux/sidebars/ccs.swift
target="$HOME/.config/cmux/sidebars/ccs.swift"
backup=<printed-backup-path>
tmp="$HOME/.config/cmux/sidebars/.ccs.swift.restore"

if cmp -s "$source" "$target"; then
  cp -p "$backup" "$tmp" && mv "$tmp" "$target"
else
  printf 'Target changed after installation; inspect it before restoring.\n' >&2
fi
```

## V1 limits

V1 reads only cmux's current workspace snapshot. It preserves relative cmux order inside two presentation sections. Agent activity means cmux exposes a latest prompt or latest agent message; it is not an authoritative claim that every workspace in Other workspaces is non-agent. Rich activity rows show truthful selection, unread, progress, recency, directory, branch, PR, dirty, remote, pinned, port, and tab metadata. Compact other rows keep tools such as the CCS TUI out of the activity inbox while still showing generic progress and unread state. Rendering is bounded to the first 50 source workspaces, then 20 rich activity rows and 30 compact other rows, with truncation notices when a cap is exceeded.

The section split is an explicit exception to preserving one global cmux order: relative order is stable inside each section, but a workspace can move into Agent activity when cmux first exposes an agent message signal. It intentionally has no search, project scope state, snooze, settle, approval/input/failure/done inference, authoritative workspace kind, detached CCS sessions, history, lineage, cost, arbitrary CCS actions, or decorative controls. `sidebar open` is a normal pane, not a right-sidebar or Dock extension.
