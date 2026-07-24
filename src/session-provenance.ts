import type { CreatorKind } from "./catalogue/db.ts";
import { err, ok, type Result } from "./result.ts";

export interface CreatorProvenance {
  readonly kind: CreatorKind;
  readonly ref: string | null;
}

/** Resolve creator provenance for `ccs session new` before any UUID or row is minted. */
export function resolveNewSessionCreator(
  environment: Readonly<Record<string, string | undefined>>,
  parentSessionId?: string,
): Result<CreatorProvenance> {
  const declared = declaredCreatorKind(environment.CCS_CREATOR_KIND);
  if (!declared.ok) return declared;
  const kind = declared.value ?? (environment.CLAUDE_CODE_SESSION_ID ? "agent" : "human");
  return provenanceFor(kind, environment, parentSessionId);
}

/** Resolve creator provenance for a delegated child. Delegation defaults to agent-created. */
export function resolveDelegateCreator(
  environment: Readonly<Record<string, string | undefined>>,
  parentSessionId: string,
): Result<CreatorProvenance> {
  const declared = declaredCreatorKind(environment.CCS_CREATOR_KIND);
  if (!declared.ok) return declared;
  const kind = declared.value ?? "agent";
  if (kind === "human") {
    return err(new Error("ccs delegate does not accept CCS_CREATOR_KIND=human; omit it for agent delegation or use automation"));
  }
  return provenanceFor(kind, environment, parentSessionId);
}

function provenanceFor(
  kind: CreatorKind,
  environment: Readonly<Record<string, string | undefined>>,
  fallbackRef?: string,
): Result<CreatorProvenance> {
  if (kind === "human") return ok({ kind, ref: null });
  const explicitRef = environment.CCS_CREATOR_REF?.trim();
  if (kind === "automation") {
    if (!explicitRef) {
      return err(new Error("CCS_CREATOR_KIND=automation requires a stable non-empty CCS_CREATOR_REF"));
    }
    return ok({ kind, ref: explicitRef });
  }
  const ref = explicitRef || environment.CLAUDE_CODE_SESSION_ID || fallbackRef;
  if (!ref) return err(new Error("agent-created sessions require CCS_CREATOR_REF, CLAUDE_CODE_SESSION_ID, or a causal parent"));
  return ok({ kind, ref });
}

function declaredCreatorKind(value: string | undefined): Result<CreatorKind | null> {
  if (value === undefined || value.trim() === "") return ok(null);
  if (value === "human" || value === "agent" || value === "automation") return ok(value);
  return err(new Error(`invalid CCS_CREATOR_KIND: ${value}`));
}
