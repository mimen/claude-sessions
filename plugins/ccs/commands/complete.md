---
description: Mark the current session completed, enrich it immediately, then safely close its cmux workspace
allowed-tools: Bash(ccs:*)
---

# Complete this session and close its workspace

`completed` records that this session's work is done while keeping it visible in CCS history.
This is per-session state; it does not retire the durable identity attached to the session.

State one concise line that completion is being recorded and the workspace is closing. Then,
as your only tool call and final action, run this foreground command:

```sh
ccs finish-current complete --do
```

Do not invoke another tool or produce a follow-up message. The command records lifecycle before
launching detached enrichment, then delegates the destructive step to CCS's fresh stable-UUID
workspace checks. A structured refusal is authoritative; never close through cmux directly.
