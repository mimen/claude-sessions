---
name: new
description: Start a fresh CCS-managed session in the right registered location, machine, harness, and model. Use only when Milad explicitly invokes /ccs:new; this is the sole conversational session-start router.
argument-hint: <initial prompt>
disable-model-invocation: true
allowed-tools:
  - Bash(${CLAUDE_SKILL_DIR}/scripts/ccs-new *)
  - Edit(//tmp/ccs-new-prompts/**)
  - AskUserQuestion
---

# Start a new routed session

Treat **$ARGUMENTS** as the initial prompt for another session. Do not perform that work here.

This skill owns the conversation. The bundled wrapper owns prompt isolation, deterministic registry reads, and managed CCS births. Do not call a raw model, `ccs start`, `claude`, `claude-native`, `claude-gpt`, direct `ssh`, or low-level cmux spawning.

## Isolate the prompt

1. If **$ARGUMENTS** is empty, print `Usage: /ccs:new <initial prompt>` and stop.
2. Run:
   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/ccs-new prepare --session-id "${CLAUDE_SESSION_ID}"
   ```
3. Use the structured file-writing tool to write **$ARGUMENTS exactly as user data**, without interpretation or shell quoting, to:
   ```text
   /tmp/ccs-new-prompts/${CLAUDE_SESSION_ID}/prompt.txt
   ```
4. Never interpolate the prompt into a Bash command. Every later wrapper call passes only the trusted session ID.

## Route

1. Run:
   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/ccs-new route --session-id "${CLAUDE_SESSION_ID}"
   ```
2. Read the JSON candidates, registry-wide exact route defaults, active host capabilities, and caller context. Existing-session warnings are informational only. This command always creates a fresh top-level work body. A candidate's `host` and `host_capabilities` describe the host used to validate that match call, normally the current host; they are not the placement recommendation. Use `preferred_host` for placement and look up that host's capabilities in `registered_hosts`.
3. If the request explicitly refers to **this/current worktree, branch, checkout, or uncommitted changes**, prefer the caller context's exact absolute CWD on the current host when its Git state confirms that context. Do not substitute the registered ordinary checkout or a remote copy.
4. Otherwise select directly when one registered location clearly fits and at least one active host satisfies the task's requirements.
5. Infer required capabilities only from the exact capability names returned by CCS. Examples of when the distinction matters:
   - interactive desktop or local authenticated-browser work requires the returned interactive/local capability;
   - current-machine files, uncommitted changes, or hardware-local state require the current host;
   - unattended ordinary repo or document work may use the always-on host.
6. If two or more locations are materially plausible, use `AskUserQuestion` with the strongest 2 to 4 registered locations. Put the recommendation first. Define every unfamiliar location in one sentence and explain when the choices imply different hosts.
7. If no registered location fits:
   - If the user supplied an explicit existing absolute path, launch that exact validated CWD locally first. Derive a short kebab-case key for possible post-success registration.
   - Otherwise list the registry and ask which location to use. Never invent a CWD from prose.

## Machine and model route

- Honor an explicit active registered host when it is eligible and satisfies every required capability.
- Otherwise prefer the location's `preferred_host` only after capability and task-local-state checks. Mini preference never overrides current-worktree state, interactive GUI/browser state, credentials, hardware, or other local-only requirements.
- Pass every inferred capability back to CCS with a repeated `--require-capability <registered-name>` flag. CCS owns final host capability validation.
- Pass an explicit supported model request with `--model <canonical-model-id>`. Do not combine it with `--via`; CCS derives the harness from the model and rejects invalid routes before reservation or workspace creation.
- Without an explicit model request, let the location override or registry-wide exact model default compile the route. Direct unregistered-CWD births use the registry-wide exact default.
- The current host follows the established local launch path. A remote host goes only through `ccs session new --host <canonical-host>` and one local `cmux ssh` workspace created inside CCS.
- Never retry automatically and never silently fall back after a remote preflight failure.
- A local fallback after a failed preferred-host launch is allowed only when all of these are true:
  1. CCS returned no `workspace_ref` and explicitly failed before workspace creation because the host was unknown/inactive, lacked a required capability, SSH preflight timed out or failed, remote `ccs` was missing, the remote registry was unreadable, or remote location validation failed.
  2. The selected location is eligible on the current host and the current host satisfies every required capability.
  3. The user explicitly chooses the current host through `AskUserQuestion` after seeing the concrete blocker.
- Never fall back locally after CCS returns a workspace reference, `workspace_created`, `workspace_uncertain`, or `session_id: pending`. The remote body may already exist.

## Launch

Run exactly one initial managed launch.

For a registered location:

```bash
${CLAUDE_SKILL_DIR}/scripts/ccs-new launch \
  --session-id "${CLAUDE_SESSION_ID}" \
  --host "<selected-canonical-host>" \
  --location "<selected-key>" \
  [--model "<explicit-canonical-model>"] \
  [--require-capability "<registered-capability>"]
```

For an explicit unregistered path, use the current canonical host and exact absolute CWD:

```bash
${CLAUDE_SKILL_DIR}/scripts/ccs-new launch \
  --session-id "${CLAUDE_SESSION_ID}" \
  --host "<current-canonical-host>" \
  --cwd "<validated-absolute-path>" \
  --title "<short-title>" \
  --model "<registry-wide-canonical-default>" \
  [--require-capability "<registered-capability>"]
```

If a pre-workspace failure qualifies for local fallback and the user explicitly chooses it, run one new launch with the current canonical host. Do not reuse a remote workspace reference and do not otherwise retry.

Register an unregistered explicit path only after a structured local receipt confirms `status: launched`. Registration must use the exact launched CWD, current host eligibility, selected route, and derived kebab-case key. Do not register after any failed or uncertain receipt. Never register a linked worktree, branch-local checkout, temporary directory, or other task-local path; those are launchable local state, not durable registry locations.

## Receipt

For a local structured receipt, report only:

- full session ID and title;
- current machine and registered location key, or the new registry entry after post-success registration;
- absolute CWD;
- exact harness/model route;
- workspace reference;
- any existing-session warning;
- recoverable session ID and blocker when reservation succeeded but workspace creation failed.

For a remote receipt, report only:

- report `session_id: pending` exactly when returned;
- report the selected canonical host, location key, remote absolute CWD, and `workspace_ref`;
- repeat the receipt's uncertainty verbatim;
- do not claim that reservation, model launch, or prompt delivery succeeded;
- do not launch or retry anything else.

After the final receipt, terminal failure, or explicit cancellation, run:

```bash
${CLAUDE_SKILL_DIR}/scripts/ccs-new cleanup --session-id "${CLAUDE_SESSION_ID}"
```
