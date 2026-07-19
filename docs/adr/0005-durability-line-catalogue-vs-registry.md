# The durability line: ccs catalogue owns identity/lifecycle, sessions.json owns live routing

The bootstrap packet (BOOTSTRAP_DESIGN_PACKET_v2) showed the reboot-misrouting
incident was a drift bug: identity was keyed on a volatile cmux `workspace:N` and
state lived on the cmux tab, anchored to nothing durable. Its target architecture
makes the ccs catalogue the source of truth (`tab = render(session)`). That
collides with ADR-0004, which put the plane hand-off contract in sessions.json.

Decision: split the two stores on DURABILITY.
- **ccs catalogue** owns what must SURVIVE A REBOOT: identity + lifecycle —
  `parent` (which loop), `skill` (pr-agent/review-agent), `event` (PR#/W-),
  `phase`, `lifecycle`. Read by the reboot bootstrap and the tab renderer, so those
  two can never disagree about "which PR is this pane."
- **sessions.json** owns the LIVE-ONLY routing/dispatch state: how to reach a
  session right now (cwd -> re-anchored cmux ref), in-flight task, dispatch status,
  and the concierge lane from ADR-0004. Ephemeral; rebuilt on boot.

Rule for a tired agent: survives-reboot -> catalogue; live-session-only -> registry.

Sequencing: adopt (C) now, sequence toward full catalogue-as-source-of-truth (A)
later. Full A would hard-depend on pulling mimen/claude-sessions origin/master (the
catalogue commits) and building `ccs sync-tabs` first — that would stall the plane
split, which fixes today's dormancy/hygiene bleeding. So key identity/lifecycle on
the catalogue now (kills reboot misrouting), keep live routing in sessions.json,
collapse the registry into the catalogue once sync-tabs exists.

Rejected: (B) keep sessions.json as sole contract with only tactical bootstrap
fixes — leaves two stores that can still drift, defers the packet's structural
point. (A) full catalogue-as-truth now — correct end state but stalls the urgent
split on an unbuilt dependency.
