---
description: Archive the current session, enrich it immediately, then safely close its cmux workspace
allowed-tools: Bash(ccs:*)
---

# Archive this session and close its workspace

`archived` hides this session from active CCS views and cluster resumes without touching its
transcript. This is per-session state; it does not retire the durable identity attached to it.

State one concise line that archival is being recorded and the workspace is closing. Then, as
your only tool call and final action, run this foreground command:

```sh
ccs finish-current archive --do
```

Do not invoke another tool or produce a follow-up message. The command records lifecycle before
launching detached enrichment, then delegates the destructive step to CCS's fresh stable-UUID
workspace checks. A structured refusal is authoritative; never close through cmux directly.
