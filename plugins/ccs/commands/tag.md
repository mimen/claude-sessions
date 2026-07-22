---
description: Tag the current session with entity names so related work is easy to find later
argument-hint: "[entity name]"
allowed-tools: Bash(ccs:*)
---

# Tag this session

Tags let you find every session about an entity later. They live only in the CCS catalogue
and reference entities by name — nothing outside `ccs` is written.

1. Determine the entity name(s):
   - If **$ARGUMENTS** is non-empty, use it after stripping surrounding `[[ ]]`.
   - Otherwise infer the 1–3 most relevant entities this session is about and confirm with
     the user before writing.

2. For each entity:
   ```
   ccs tag . "<Entity Name>"
   ```
   Add `--remove` to untag.

3. Run `ccs meta .` and report the resulting tag list. Do not infer the final list from
   the mutation command alone; the remove path prints only the entity it removed.
