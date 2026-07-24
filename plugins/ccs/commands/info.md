---
description: Show the current session's CCS catalogue state — title, lifecycle, cost, identity, and tags
allowed-tools: Bash(ccs:*)
---

# What is this session to CCS?

1. Run both — they answer different questions:
   ```
   ccs meta .        # resolved metadata, lifecycle, cost, token totals, descendants
   ccs session .     # catalogue state, parent, parked task, linked identity
   ```

2. Report what they print. Call out explicitly:
   - **lifecycle** — `idle` / `parked` / `completed` / `archived`.
   - **cost** — `self` is this session; `total` includes descendants such as delegated
     children and subagent runs.
   - **identity_key** — `(loose)` means the session is not attached to a durable identity.
     That is normal for ad-hoc work; standing cluster roles are expected to be attached.

3. If there is no catalogue row yet, say so. `/ccs:title`, `/ccs:suggest-title`,
   `/ccs:complete`, and `/ccs:archive` can establish one because their flows set a title
   before lifecycle changes. `/ccs:tag` alone does not create the catalogue row.
