/**
 * The single place a session's DISPLAY title is decided.
 *
 * Every surface — `ccs ls`, the TUI list, the preview, `ccs meta`, `ccs session` — resolves a
 * title through {@link resolveSessionTitle} so they can never disagree. Precedence, highest first:
 *
 *   live  → the cmux tab title right now (TUI only; reflects a just-renamed tab)
 *   custom → the human's explicit title (catalogue `custom_title`)
 *   role   → the identity name, for a session that embodies a durable role/cluster identity
 *   native → the harness/last-emitted title (index `native_title`)
 *   codex  → ccs's generated title (index `codex_title`)
 *   fallback → the cleaned first message (index `fallback_label`; never null)
 *
 * The distinction that matters: `custom` (and `live`, which feeds it via the write-through) is an
 * INTENTIONAL human choice and always outranks any generated guess. `role` is the identity domain
 * — an authored name, kept separate from the generated `native/codex/fallback` tail, never mixed
 * into it. A plain one-off session never has a `role`, so for it the chain is simply
 * `custom → native → codex → fallback`.
 */

/** Which source won a title resolution. `native/codex/fallback` are the generated index sources;
 *  `custom/live` are the human's choice; `role` is the identity name. */
export type TitleSource = "live" | "custom" | "role" | "native" | "codex" | "fallback";

/** The generated-title source stored in the index (the tail of the precedence chain). */
export type IndexTitleSource = "native" | "codex" | "fallback";

export interface ResolvedTitle {
  readonly title: string;
  readonly source: TitleSource;
}

export interface TitleInputs {
  /** Live cmux tab title (TUI only). Wins when present; it's what the operator sees right now. */
  readonly liveTitle?: string | null;
  /** The human's explicit title (catalogue `custom_title`). */
  readonly customTitle?: string | null;
  /** Identity role name, when this session embodies a durable identity; absent for one-off work. */
  readonly role?: string | null;
  /** The index-resolved generated title: `COALESCE(native_title, codex_title, fallback_label)`. */
  readonly indexTitle: string;
  /** Which generated source won the index resolution. */
  readonly indexSource: IndexTitleSource;
}

/** Resolve a session's display title + the source that won. See the module doc for precedence. */
export function resolveSessionTitle(i: TitleInputs): ResolvedTitle {
  const live = i.liveTitle?.trim();
  if (live) return { title: live, source: "live" };
  const custom = i.customTitle?.trim();
  if (custom) return { title: custom, source: "custom" };
  // Identity sessions read as their authored identity name, never the generated title.
  const role = i.role?.trim();
  if (role) return { title: role, source: "role" };
  return { title: i.indexTitle, source: i.indexSource };
}
