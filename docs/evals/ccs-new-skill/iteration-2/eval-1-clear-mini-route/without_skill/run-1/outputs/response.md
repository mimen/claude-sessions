Route: the `ccs` launch location on `Milads-Mac-mini`, using the registered remote-host path. This is a routing decision only; no session was launched.

Read-only inspection found that the current remote birth flow:

- preflights the remote `ccs` and location over SSH;
- creates exactly one `cmux ssh` workspace; and
- emits a receipt with `session_id: "pending"` because reservation and prompt delivery are not yet confirmed.

The implementation seam is in `/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/ccs-new-router/src/resume/remote-session.ts`, with orchestration in `/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/ccs-new-router/src/resume/new-session.ts`.

The required change should add a machine-readable remote birth receipt carrying the confirmed session ID and prompt-delivery result, parse that receipt from the single remote workspace launch, preserve the workspace reference, and classify malformed, partial, or timed-out output as uncertain. It must not automatically retry after a workspace may already exist. Tests should cover confirmed receipts, malformed receipts, timeout/partial output, and preservation of the existing no-retry behavior.

Per the offline-baseline constraints, I did not edit implementation files, spawn a session, call SSH, or call cmux.