# The fleet is defined by a tag; `parent` records only real spawn edges

"Resume the constellation" (Milad, 2026-07-07) needs a durable graph of the fleet
in the ccs catalogue. A constellation there is a connected component of the
parent->child graph. Making the WHOLE fleet one component by parenting everything
to the orchestrator would record a false authority edge — the eval loop grades the
orchestrator and the designer builds the loop; neither is spawned by it.

Decision: separate two meanings.
- `parent` = who-actually-spawned-me. Set ONLY where a real spawn happened
  (orchestrator/control -> its workers). Eval and designer get no parent edge to
  the orchestrator.
- Fleet MEMBERSHIP = a shared tag/event (e.g. `pr-watch-fleet`). "Resume the
  constellation" resolves the fleet by that tag, not by the parent component.
  `sessionsForEntity` / `sessionsForEvent` already exist in ccs to resolve a
  tag-set; `ccs resume` grows a "resume every session with tag/event X" mode.

Edge maintenance (belt-and-suspenders, per ADR-0005): the control plane sets
`parent`/`event`/`skill` when it spawns a worker (folded into spawn-agent.sh
ensure); the worker self-marks its own `phase`/`lifecycle`. A one-time
agent-driven BACKFILL creates the edges for the 16 currently-live sessions + 3
infra sessions from the packet's resurrection table (all 16 cwd->resume_id
mappings verified) before the first constellation-resume.

Rejected: (A) orchestrator as the single root with everything parented under it —
records false authority, breaks the moment eval/designer must act on the
orchestrator.

## Build-time findings (verified in mimen/claude-sessions @ master, 2026-07-07)
Two ccs features this plan needs DO NOT EXIST yet and must be built:
1. `ccs resume` is session-only (src/resume/ builds a command for one SessionRow).
   No resume-a-constellation / resume-by-tag verb. NEW FEATURE.
2. `sync-tabs` does not exist — the only cmux push is pushCmuxRename (title only).
   description/color/status-pills (what cmux_label.py does) are not in ccs.
   The packet's §8 renderer is unbuilt. NEW FEATURE.
Everything else the packet promised IS on master: catalogue schema (resume_id,
cwd/project, event, parent_session_id, skill), write verbs (parent/event/skill/
tag/mark/rename), reverse lookups (childrenOf/parentEdges/sessionsForEvent), and
constellation = connected component (groupsView.ts, `ccs tree`).
