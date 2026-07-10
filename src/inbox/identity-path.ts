/**
 * Resolve a RESPONSIBILITY (the durable agent-identity key, ADR-0026/0030) to its runtime
 * directory under ~/.ccs (ADR-0041). This is where the identity's inbox + state live —
 * NEVER in the git-tracked config tree, so routed Slack/PR content can't leak.
 *
 * Layout (ADR-0041):
 *   cluster role: <root>/clusters/<cluster>/identities/<role>/[<epic>/]<work-unit>
 *   standalone:   <root>/roles/<role>/identities/<role>|<work-unit>
 * The key degrades cleanly: cluster optional, epic optional (fleet only), work-unit only for
 * fleet — a core singleton's identity dir is just its role.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE = /[^a-zA-Z0-9_.-]+/g;
/** Sanitize ONE path component: no separators, no traversal, no unsafe chars. */
function seg(s: string): string {
  const cleaned = s.replace(/[/\\]/g, "-").replace(/\.\.+/g, "-").replace(SAFE, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

export interface Responsibility {
  cluster?: string | null;
  role: string;
  epic?: string | null;
  workUnit?: string | null;
}

/** Default runtime root (ADR-0041): ~/.ccs (state, never git). */
export function ccsRuntimeRoot(): string {
  return join(homedir(), ".ccs");
}

/** The runtime directory for a responsibility's identity (inbox + state live here). */
export function identityDir(root: string, r: Responsibility): string {
  const role = seg(r.role);
  const base = r.cluster
    ? join(root, "clusters", seg(r.cluster), "identities", role)
    : join(root, "roles", role, "identities", role);
  // NB standalone core: <root>/roles/<role>/identities/<role> — role appears twice by design
  // (the roles/<role> tree groups the role; identities/<role> is the singleton's own dir).
  let dir = base;
  if (r.epic) dir = join(dir, seg(r.epic));
  if (r.workUnit) dir = join(dir, seg(r.workUnit));
  return dir;
}

/** The runtime directory for a cluster's SHARED state (board, gate, dispositions — ADR-0031).
 * Distinct from identity state: one per cluster, not per responsibility. */
export function clusterStateDir(root: string, cluster: string): string {
  return join(root, "clusters", seg(cluster), "cluster");
}
