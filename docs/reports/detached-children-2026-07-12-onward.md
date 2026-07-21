# Detached child classification audit — 2026-07-12 onward

**Mode:** report only. No catalogue metadata was written and no session was archived.

The deterministic manifest is [`detached-children-2026-07-12-onward.json`](./detached-children-2026-07-12-onward.json). The parent-first [interactive review dossier](./detached-children-2026-07-12-onward.html) is a local, read-only presentation of that same manifest.

Regenerate it after regenerating the manifest:

```bash
bun run report:detached-children:dossier
```

The dossier only writes its HTML artifact. It does not apply a proposal, alter catalogue metadata, or archive a session.

## Result

| Classification | Count |
|---|---:|
| Exact proposed matches | 621 |
| Provider mismatch | 657 |
| No exact prompt candidate | 135 |
| Model mismatch | 56 |
| Duplicate claim | 7 |
| Ambiguous | 2 |
| Timestamp/CWD mismatch | 2 |
| **Total** | **1,480** |

- The **621 exact proposals** satisfy the classifier's one-to-one prompt, cwd, entrypoint, provider/model, and narrow timestamp requirements. Corpus review found no documentation/fixture/script-writing false positives among this set.
- The **7 duplicate claims** and **2 ambiguous matches** remain withheld.
- The manifest records **9 stale index paths** whose transcript files no longer exist.
- Two project clusters account for 1,225 findings (82.8%): `imsg` and the `imsg-priority-shelf` worktree.

## Agentic audit

Representative transcript inspection confirms that the dominant patterns are intentional delegated review, implementation, and visual-verification fan-out through `claude-native` and `claude-gpt`. Retry chains after model/session-limit failures are also common.

The 657 provider mismatches are mostly false negatives, not evidence that the roots are unrelated:

- 685 candidate roots have empty `cost_by_model` metadata even when transcript-level model evidence exists.
- Known aliases (`fable`, `opus`, `sonnet`, `haiku`) and provider-specific remapping are not canonicalized.
- A failed delegated task may retry under another model, producing a chain of valid launch attempts.

The 135 prompt mismatches remain the primary unexplained group and require targeted review before any backfill expansion.

## Before applying any cleanup

1. Review and approve the 621 exact proposals separately.
2. Keep duplicate, ambiguous, and unmatched findings unchanged.
3. Improve the classifier before a second pass:
   - infer provider/model from transcript metadata when catalogue model data is absent;
   - canonicalize only known model aliases;
   - bound the accepted launcher grammar and reject `--resume`;
   - fail closed on script/example-writing and nested quoted-shell constructs;
   - add processed/skipped command accounting to the manifest.
4. Regenerate and compare the manifest. The current generator is deterministic: repeated runs produced the same SHA-256.

The report itself grants no mutation. After separate dossier review, the **621 exact proposals only** may be applied with the manifest-pinned historical backfill command:

```bash
# Inspect exactly what would change (read-only dry run).
ccs historical-backfill detached-children \
  --expect-sha256 "$(shasum -a 256 docs/reports/detached-children-2026-07-12-onward.json | cut -d ' ' -f 1)"

# Apply the same reviewed bytes. This writes session_class=auxiliary, the causal parent,
# the three historical tags, provenance metadata, and a transactional rollback snapshot.
ccs historical-backfill detached-children \
  --expect-sha256 "$(shasum -a 256 docs/reports/detached-children-2026-07-12-onward.json | cut -d ' ' -f 1)" \
  --apply
```

The command rejects a changed manifest, malformed or non-exact proposal, unresolved/ambiguous alias, existing conflicting class/parent/provenance, and catalogue state that changes between planning and transaction. It never archives or deletes a session, and leaves all 859 withheld findings untouched. Each applied operation gets an audit snapshot; `ccs historical-backfill rollback --operation <uuid>` is dry-run first and restores only the recorded managed fields when they have not subsequently changed.
