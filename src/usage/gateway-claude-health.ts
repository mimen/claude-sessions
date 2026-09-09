/**
 * The gateway's view of each Claude account's credential.
 *
 * Two logins exist per Claude account: cswap's (used by claude-native) and CLIProxyAPI's own
 * (used by claudex). cswap can only report on the first. This reads the second from the
 * gateway's management API so a dead gateway grant is named in the menu bar instead of being
 * discovered by the first request that needs it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MANAGEMENT_BASE_URL = "http://127.0.0.1:8317/v0/management";
const MANAGEMENT_KEY_FILE = join(homedir(), ".cli-proxy-api-management-key");
const MANAGEMENT_TIMEOUT_MS = 3_000;
const GATEWAY_AUTH_DIR = join(homedir(), ".cli-proxy-api");
// A successful refresh normally lands before access-token expiry. Allow one menu-bar poll for a
// transient scheduler delay, then report it as unhealthy instead of trusting stale runtime state.
const TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1_000;

export interface GatewayClaudeCredential {
  email: string;
  status: string;
  statusMessage: string | null;
  unavailable: boolean;
  disabled: boolean;
  nextRetryAfter: string | null;
  /** Access-token expiry from the credential file; absent from the management API today. */
  expiresAt: string | null;
}

export interface GatewayIssue {
  email: string;
  reason: string;
}

function readManagementKey(path = MANAGEMENT_KEY_FILE): string | null {
  try {
    const key = readFileSync(path, "utf8").trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** Parse the management API's auth-files listing down to the Claude rows. */
export function parseGatewayClaudeCredentials(payload: unknown): GatewayClaudeCredential[] {
  const files = (payload as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  const out: GatewayClaudeCredential[] = [];
  for (const row of files) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const provider = typeof r.provider === "string" ? r.provider : typeof r.type === "string" ? r.type : "";
    if (provider.toLowerCase() !== "claude") continue;
    if (typeof r.email !== "string" || !r.email) continue;
    out.push({
      email: r.email,
      status: typeof r.status === "string" ? r.status : "unknown",
      statusMessage: typeof r.status_message === "string" && r.status_message ? r.status_message : null,
      unavailable: r.unavailable === true,
      disabled: r.disabled === true,
      nextRetryAfter: typeof r.next_retry_after === "string" ? r.next_retry_after : null,
      expiresAt: typeof r.expired === "string" ? r.expired : null,
    });
  }
  return out;
}

/**
 * Why a gateway credential cannot serve, or null when it can. A credential the switch parked
 * (disabled, otherwise healthy) is not an issue: it is re-enabled by the next switch to it.
 */
export function describeGatewayIssue(
  c: GatewayClaudeCredential,
  nowMs = Date.now(),
): string | null {
  if (c.nextRetryAfter) return `gateway: cooling down until ${c.nextRetryAfter}`;
  const expiresMs = c.expiresAt === null ? Number.NaN : Date.parse(c.expiresAt);
  if (Number.isFinite(expiresMs) && expiresMs + TOKEN_EXPIRY_GRACE_MS <= nowMs) {
    return `gateway: access token expired at ${c.expiresAt} without refresh (needs cliproxyapi -claude-login)`;
  }
  if (c.unavailable || c.status === "error") {
    const why = c.statusMessage ?? c.status;
    return `gateway: ${why} (needs cliproxyapi -claude-login)`;
  }
  return null;
}

function readCredentialExpiresAt(email: string, authDir: string): string | null {
  const filename = `claude-${email}.json`;
  if (basename(filename) !== filename) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(authDir, filename), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("expired" in parsed)) return null;
    return typeof parsed.expired === "string" && Number.isFinite(Date.parse(parsed.expired))
      ? parsed.expired
      : null;
  } catch {
    return null;
  }
}

/** Add the expiry that CLIProxyAPI currently omits from its management response. */
export function attachCredentialExpirations(
  credentials: GatewayClaudeCredential[],
  authDir = GATEWAY_AUTH_DIR,
): GatewayClaudeCredential[] {
  return credentials.map((credential) => ({
    ...credential,
    expiresAt: readCredentialExpiresAt(credential.email, authDir) ?? credential.expiresAt,
  }));
}

/** Live read; never throws. An unreachable gateway or missing key yields no rows. */
export async function fetchGatewayClaudeCredentials(
  baseUrl = MANAGEMENT_BASE_URL,
  authDir = GATEWAY_AUTH_DIR,
): Promise<GatewayClaudeCredential[]> {
  const key = readManagementKey();
  if (!key) return [];
  try {
    const res = await fetch(`${baseUrl}/auth-files`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return attachCredentialExpirations(parseGatewayClaudeCredentials(await res.json()), authDir);
  } catch {
    return [];
  }
}

export function gatewayIssues(credentials: GatewayClaudeCredential[]): GatewayIssue[] {
  const issues: GatewayIssue[] = [];
  for (const c of credentials) {
    const reason = describeGatewayIssue(c);
    if (reason) issues.push({ email: c.email, reason });
  }
  return issues;
}
