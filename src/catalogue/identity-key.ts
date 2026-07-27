/** Return the work reference from a structured `<cluster>:<role>:<work_ref>` identity key. */
export function workRefOfIdentityKey(identityKey: string | null | undefined): string | null {
  if (!identityKey) return null;
  const parts = identityKey.split(":");
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const workRef = parts.slice(2).join(":").trim();
  return workRef || null;
}

/** Humanize a stable slug without interpreting cluster-specific vocabulary. */
export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}
