/**
 * Live Anthropic usage straight from the OAuth endpoint, per cswap-managed account.
 *
 * cswap's own usage cache goes stale whenever a stored token is revoked (its
 * usageStatus flips to no_credentials and it serves lastGoodUsage silently).
 * cswap keeps each account's real OAuth payload in the login keychain under
 * service "claude-swap", account "account-<n>-<email>"; we read the token there
 * and call api.anthropic.com/api/oauth/usage (oauth-2025-04-20 beta) — the same
 * endpoint claude.ai's settings page uses.
 */

export interface KeychainOauth {
  accessToken: string;
  rateLimitTier: string | null;
}

interface OauthWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface OauthUsage {
  five_hour?: OauthWindow | null;
  seven_day?: OauthWindow | null;
  seven_day_opus?: OauthWindow | null;
  seven_day_sonnet?: OauthWindow | null;
  /** Codename for the scoped Fable weekly window. */
  nimbus_quill?: OauthWindow | null;
}

export function readKeychainOauth(accountNumber: number, email: string): KeychainOauth | null {
  const proc = Bun.spawnSync({
    cmd: [
      "/usr/bin/security", "find-generic-password",
      "-s", "claude-swap",
      "-a", `account-${accountNumber}-${email}`,
      "-w",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      claudeAiOauth?: { accessToken?: string; rateLimitTier?: string };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    if (!token) return null;
    return { accessToken: token, rateLimitTier: parsed.claudeAiOauth?.rateLimitTier ?? null };
  } catch {
    return null;
  }
}

export async function fetchOauthUsage(accessToken: string): Promise<OauthUsage> {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`oauth usage HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as OauthUsage;
}

/** Plan display info decoded from the keychain rateLimitTier. */
export function planFromTier(tier: string | null | undefined): { name: string; dollars: number } | null {
  const t = (tier ?? "").toLowerCase();
  if (t.includes("max_20")) return { name: "Max 20x", dollars: 200 };
  if (t.includes("max_5")) return { name: "Max 5x", dollars: 100 };
  if (t.includes("pro")) return { name: "Pro", dollars: 20 };
  if (t.includes("max")) return { name: "Max", dollars: 100 };
  return null;
}

/** Scoped weekly windows by API codename, in render order. */
export const SCOPED_WINDOWS: readonly { key: keyof OauthUsage; suffix: string }[] = [
  { key: "nimbus_quill", suffix: "#Fable" },
  { key: "seven_day_opus", suffix: "#Opus" },
  { key: "seven_day_sonnet", suffix: "#Sonnet" },
];
