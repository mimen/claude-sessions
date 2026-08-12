---
description: Save the current session for later, enrich it immediately, then safely close its cmux workspace
allowed-tools: Bash(ccs:*)
---

# Save this session for later

Saved sessions leave the active working set but remain preserved and resumable. Resuming the
session automatically returns it to Active.

State one concise line that the session is being saved and the workspace is closing. Then, as
your only tool call and final action, run this foreground command:

```sh
ccs finish-current save --do
```

Do not invoke another tool or produce a follow-up message. The command records lifecycle before
launching detached enrichment, then delegates the destructive step to CCS's fresh stable-UUID
workspace checks. A structured refusal is authoritative; never close through cmux directly.
