---
description: Mark the current session completed in CCS, then safely close its cmux workspace
argument-hint: "[optional title hint]"
allowed-tools: Bash(ccs:*)
---

# Mark this session completed

`completed` and `archived` are different claims:

- **completed** — the work this session set out to do is done. The session stays visible in CCS history, but completed cluster members are not resumed.
- **archived** — get it out of active views. Hidden from browse, search, and cluster resumes.

Reach for `/ccs:archive` when you want it gone; use this when you want the outcome
recorded. Both are reversible with `/ccs:unarchive`. When both flags are set, `ccs`
reports the lifecycle as `archived` (precedence is archived > completed > parked > idle).

1. **Confirm there's a session.** Run `ccs whoami`; if it errors, say so and stop.

2. **Read its current catalogue state.** Run `ccs session .`. If it is not catalogued
   yet, you must establish a row in the next step before completing it. If a custom title
   is present, judge that title; otherwise use the conversation itself rather than
   guessing which row in `ccs ls` belongs to this session.

3. **Keep or improve the title.** A useful CCS title is imperative, sentence case, no
   trailing period, and at most 60 characters. It describes the session's dominant
   purpose rather than only its opening request. Bias toward **$ARGUMENTS** when present.

   - If the session is uncatalogued, run `ccs rename . "<resolved or improved title>"`
     even when the resolved title is already good; `rename` creates the required row.
   - If it is catalogued, retitle only when the current title is generic, stale, or no
     longer describes the work:
     ```
     ccs rename . "<improved title>"
     ```

4. **Mark it completed.**
   ```
   ccs session complete .
   ```
   Per-session verb only — `ccs identity complete` would retire the whole durable
   responsibility, which is a policy decision belonging to the owning cluster, not to a
   session that happens to have finished a task.

5. **Preflight the final workspace close.** Run:
   ```
   ccs close-current-workspace
   ```
   If it refuses, report the completed title, lifecycle, and structured refusal reason,
   then stop. Completion remains recorded; never guess or close through cmux directly.

6. **Announce, then close as the final action.** If preflight reports `authorized`, state
   one concise line with the completed title and lifecycle and say the workspace is closing.
   Then run:
   ```
   ccs close-current-workspace --do
   ```
   This command takes two fresh live-state snapshots and only closes the stable workspace
   UUID when the current session is its sole live surface. Do not invoke another tool or
   produce a follow-up message after this command. The workspace disappearing before the
   command returns is the expected success behavior.
