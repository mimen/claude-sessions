# Role materialization is a symlink reconcile over a ccs-owned manifest — prune only what ccs made

> **Amended by ADR-0048/0051 (2026-07-10).** The reconcile still stands, but it is now
> re-sourced from the config package FILES (not the dropped sqlite tables); skills/commands are
> real files in the package, so materialized symlinks resolve inside `~/.ccs-config`.


ADR-0022 said ccs materializes each role's skills/commands/hooks into `~/.claude` via a
`sync-roles` step, and the vision doc calls it "a projection with pruning." Milad's
original concern (and both design reviews) is the danger there: a script that writes into
`~/.claude` can leave stale artifacts when a role changes, or clobber the user's
hand-made files. This ADR pins the mechanism so materialization is safe and drift-free.
Decided with Milad 2026-07-09.

## Decision — reconcile a desired symlink set against an owned manifest

`ccs sync-roles` is a **declarative reconcile**, not an imperative writer:

1. **Compute the desired set** from the roles registry: for each role, the symlinks its
   skills/commands should have in `~/.claude` (e.g. `~/.claude/skills/<skill> ->
   <role-dir>/skills/<skill>`).
2. **Read the ccs-owned manifest** — `~/.ccs/materialization-manifest.json` — the record
   of every symlink ccs created on prior runs.
3. **Reconcile:**
   - create desired links that are missing;
   - **prune** any link IN THE MANIFEST that is no longer desired (a removed/renamed role's
     leftovers) — and ONLY those;
   - update the manifest to the new desired set.
4. **Never touch anything not in the manifest.** A file or symlink in `~/.claude` that ccs
   didn't create is invisible to prune — the user's hand-made skills/commands are never
   removed or overwritten. If a desired link's target path already exists as a
   non-ccs file, ccs refuses that one link and logs a collision rather than clobbering.

Symlinks (not copies): the link always points at the role's source-of-truth file, so
editing the role definition takes effect with no re-sync-to-propagate step and no
copy-drift. `sync-roles` only manages the *set* of links, never their contents.

## Hooks materialize into settings files (managed block), at two levels

Hooks are written into `settings.json` files, not symlinked. Per ADR-0018 (corrected),
hooks load from the cwd's `.claude/` and MERGE across scopes, so ccs materializes them at
two levels — both generated from the registry:

- **Global hooks** → `~/.claude/settings.json` — cluster-wide hooks that fire for every
  session (ccs registration/arming, worker Stop). Written once.
- **Role hooks** → each role dir's `.claude/settings.json` — hooks that fire only for that
  role's sessions. Written per role.

Because hooks merge, the two layers stack (a role session fires both) with no override and
no need to re-declare global hooks per role. In every settings file ccs writes ONLY inside a
marked managed block, so it never disturbs the user's own entries:

```
// >>> ccs managed (do not edit) >>>
...ccs-owned hook/settings entries...
// <<< ccs managed <<<
```

ccs edits only between the markers; everything outside is the user's and is preserved.
This is the settings-file analogue of the symlink manifest: a bounded region ccs owns.
(Skills/commands are still symlinked per the reconcile above; hooks/settings use the
managed block because they're JSON entries in a shared file, not standalone files.)

## Failure / partial sync

- **Atomic per link.** Each symlink create/remove is individually atomic; a `sync-roles`
  interrupted halfway leaves a consistent subset (some links done, some not) and is safe
  to re-run — reconcile is idempotent and converges.
- **Manifest is the source of truth for cleanup**, written last (after links are made) via
  atomic rename (ADR-0031). If ccs crashes before the manifest is updated, the next run
  reconciles from the still-old manifest plus the now-current desired set and self-heals
  (it may re-examine a link it already made — harmless, it's declarative).
- **Rollback** = re-run `sync-roles` from the registry; there is no imperative state to
  unwind, only a set to converge to.

## Why not copy-files, why not plain script-writes

- **Copies** drift from the role source and need a re-sync to propagate every edit; a
  symlink is always current. (Copy + manifest was considered for edge filesystems; rejected
  as the default — the drift cost outweighs the portability.)
- **A plain script that writes** can't know what it left behind last run, so it can't prune
  safely; that's exactly the stale-artifact failure this ADR kills. The manifest is what
  makes prune correct.

## Consequences

- Materialization is safe against both failure modes the reviews raised: no stale
  artifacts (manifest-driven prune) and no clobbering user files (only manifest entries +
  managed blocks are ever touched).
- Adds one owned file (`materialization-manifest.json`) and one convention (managed-block
  markers in settings). Small, and the safety comes entirely from them.
- Reinforces ADR-0022 (ccs materializes from the registry) and ADR-0018 (global hooks in
  user settings + role hooks in the role dir, both in managed blocks, all merge). Retires
  `install.sh`'s hand-maintained symlink
  list — the class of "a role added but never wired / a role removed but never unwired" bug
  is gone.
- Build: `ccs sync-roles` = compute-desired + reconcile-against-manifest + rewrite-manifest;
  a settings writer that edits only within managed-block markers.
