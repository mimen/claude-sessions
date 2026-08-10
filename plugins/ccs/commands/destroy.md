---
description: Irreversibly erase a session and its descendants from this machine — transcript, sidecars, catalogue, index, and search
argument-hint: "[<session-id>|.]"
allowed-tools: Bash(ccs:*)
---

# Destroy a session

This deletes. Every other lifecycle verb in ccs sets a bit and leaves the transcript alone;
`archive` hides a session, `/ccs:incognito` hides it harder, and both are reversible. This
unlinks the transcript, the subagent sidechains, the task state, the edit history, the session
env, and the ccs logs, then removes the catalogue rows, the index rows, and the full-text search
entry. It takes the session's descendants with it. **There is no undo and no backup.**

## Run the preflight and stop

Resolve the target from **$ARGUMENTS**, defaulting to `.` (this session):

```
ccs session destroy <id>
```

This deletes nothing. It prints the manifest: every session in the subtree, every path that
would be removed, which sessions are live and would be closed first, which identities survive,
and which surfaces still mention the session afterward.

**Show the user that manifest and stop your turn there.** Do not run the `--confirm` form in the
same turn, even though the preflight prints the exact command to do it. The two steps exist so a
human reads the manifest between them; running both back to back collapses the gate this command
is built around and destroys data on a single instruction.

## After the user confirms

Only once the user has read the manifest and told you to proceed:

```
ccs session destroy <id> --confirm <id>
```

The id must be typed out in full and match. Report the counts the command prints.

## Refuse and explain when

- The manifest names sessions the user did not expect. Ask before proceeding, and never widen
  the target to make an unexpected descendant fit.
- The target is `.` and the user meant a different session. Destroying the current session
  closes its own workspace first; confirm that is what they want.
- The command reports it could not close a live workspace. It aborts having deleted nothing,
  which is the correct outcome — a running `claude` re-flushes its transcript, so unlinking
  underneath one produces a resurrected file and a destroy that quietly did not happen. Say what
  is still open rather than retrying.

## What survives, and say so

Identities are not destroyed: an identity outlives its sessions and may be shared with others.
cmux's own logs, the ccs backups, and system logs are also untouched, because rewriting an
append-only file another process holds open risks corrupting it. The preflight lists these
paths — pass them on, so "destroyed" is never read as a stronger guarantee than it is.
