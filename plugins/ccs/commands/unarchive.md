---
description: Clear archive or completion flags on the current session and return it to active CCS views
allowed-tools: Bash(ccs:*)
---

# Bring this session back

Clears lifecycle flags so the session shows up in `ccs` browse, search, and cluster
resumes again.

1. **Confirm there's a session.** Run `ccs whoami`; if it errors, say so and stop.

2. **Read the current state.** Run `ccs session .` and `ccs meta .`.
   - If there is no catalogue row, say there is no archived/completed state to clear and stop.
   - If the lifecycle is already `idle`, say so and stop.

3. **Clear the flags that are actually set.** Archived and completed are independent, and
   archived wins the display, so a session can be both:
   ```
   ccs session unarchive .     # clears archived
   ccs session uncomplete .    # clears completed
   ```
   Run only the commands needed for the state you just read.

4. **Report** the resulting lifecycle from a fresh `ccs meta .`.
