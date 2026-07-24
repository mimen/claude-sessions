---
description: Mark the current session completed in the CCS catalogue while keeping it visible in history
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

5. **Report** the title (kept or changed) and the new lifecycle. Do not offer to close the
   tab — completing says the work landed, not that you're leaving. Mention `/ccs:archive`
   if it should also leave active views.
