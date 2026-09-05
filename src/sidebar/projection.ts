/**
 * The productivity sidebar's pure projection.
 *
 * One question drives the shape: what deserves attention next? Rows carry only what a person
 * needs to choose one — working directory, session name, worktree, model, cmux's own Claude
 * status, lifecycle, and recency. Cost, lineage, roles, and other catalogue metadata are absent.
 *
 * Every input is supplied by the caller so this module stays free of cmux, SQLite, and git I/O.
 */
import type { Lifecycle } from "../catalogue/db-schema.ts";
import {
  messagesSince,
  recommendationDisagreement,
  type StoredEnrichment,
} from "../catalogue/enrichment.ts";
import type { Recommendation } from "../catalogue/enrichment-schema.ts";
import { familyOf } from "../display/format.ts";
import { displayModelRegistry, modelBase, modelById, shortOf } from "../models/registry.ts";
import { enrichmentDriftLabel } from "../enrich/staleness.ts";
import type { SidebarCategoryProjection } from "./category-projection.ts";

export type { Recommendation };

/** cmux's own `claude_code` status entry, exactly as cmux renders it. */
export interface CmuxClaudeStatus {
  readonly label: string;
  readonly icon: string | null;
  readonly color: string | null;
}

export type CmuxStatusAvailability =
  | "published"
  /** Inferred from the hook store while the authoritative pill is being re-read. */
  | "derived"
  | "absent"
  | "unreadable"
  | "not-live";

/** One live Claude session, joined from the cmux tree and hook store by surface UUID. */
export interface LiveSessionInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly windowId: string;
  readonly windowRef: string;
  readonly workspaceTitle: string | null;
  /** cmux's own pin on the workspace; pinned work leads its group. */
  readonly pinned: boolean;
  /** The ⌘N that jumps here, or null when nothing reaches it. */
  readonly shortcut: number | null;
  /** True for the workspace cmux currently has focused. */
  readonly focused: boolean;
  readonly cwd: string | null;
  /** cmux's rendered status pill for the workspace, when it publishes one. */
  readonly status: CmuxClaudeStatus | null;
  /** Whether cmux published no pill or the list-status command itself could not be read. */
  readonly statusAvailability: CmuxStatusAvailability;
  /** Unix seconds cmux last recorded for the session. */
  readonly updatedAt: number | null;
}

/**
 * One live cmux workspace that no Claude session owns.
 *
 * A plain shell, a browser split, a rendered markdown panel: cmux's own rail lists these, so a
 * sidebar that replaces it must reach them too, or those tabs become unnavigable. They carry no
 * session identity, no model, and no lifecycle — the union below keeps that absence in the type
 * rather than filling it with nulls a consumer might mistake for missing data.
 */
export interface LiveWorkspaceInput {
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly workspaceTitle: string | null;
  readonly windowId: string;
  readonly windowRef: string;
  readonly pinned: boolean;
  readonly focused: boolean;
  readonly shortcut: number | null;
  readonly cwd: string | null;
  /** cmux's surface types in tree order, e.g. `terminal`, `browser`, `filepreview`. */
  readonly surfaceKinds: readonly string[];
}

/** One indexed session, used for names, models, recency, and the resume shelf. */
export interface IndexedSessionInput {
  readonly sessionId: string;
  readonly resumeId: string;
  readonly title: string;
  readonly cwd: string | null;
  /** ISO timestamp of the session's last recorded activity. */
  readonly lastTs: string | null;
  readonly models: readonly string[];
  /** Last model that billed a turn, when the index recorded it. */
  readonly lastModel?: string | null;
  readonly costByModel: Readonly<Record<string, number>>;
  /**
   * Transcript message count, used to age the enrichment summary.
   *
   * The index refreshes on a timer, so its own count trails a session that is still typing. The
   * snapshot trues this up from the transcript before projecting (see `tail-count.ts`), so what
   * arrives here is exact whenever it could be established.
   */
  readonly messageCount?: number | null;
  /** Where the transcript lives, so a caller can stat it. */
  readonly transcriptPath?: string | null;
  /** Bytes the index had parsed when it recorded `messageCount`. */
  readonly indexedBytes?: number | null;
  /**
   * When the transcript was last written, in ms.
   *
   * The fallback, for the sessions whose exact count could not be established -- a truncated file,
   * or an index predating `file_size`. It cannot say how far a session has moved, only that it
   * has, which is still better than the silence that would otherwise read as currency.
   */
  readonly transcriptMtimeMs?: number | null;
}

/** The checkout a directory belongs to, when the directory is inside a git repository. */
export interface CheckoutInput {
  /** The repository's own name, identical across all of its worktrees. */
  readonly project: string;
  /** The linked worktree's name, or null when this is the repository's main checkout. */
  readonly worktree: string | null;
  readonly branch: string | null;
}

/** The established enrichment wire shape exposed by sidebar snapshots. */
export interface SidebarSummary {
  readonly state: string | null;
  readonly history: string | null;
  readonly next: string | null;
  readonly remaining: string | null;
  readonly recommendation: Recommendation | null;
  readonly reason: string | null;
  readonly junk: boolean;
  readonly atMessages: number | null;
  readonly at: string | null;
  readonly declined: Recommendation | null;
  /**
   * How out of date this enrichment is, or null when it is genuinely current.
   *
   * Not derivable from `messagesSince` alone: that counts index rows, and a live session's index
   * row does not move, so zero means "the index has not caught up" rather than "nothing has
   * happened". A transcript newer than the enrichment says so even when the count cannot.
   */
  readonly driftLabel: string | null;
  /** Messages appended since generation, or null when either count is unknown. */
  readonly messagesSince: number | null;
}

/**
 * How much vertical space a row is worth.
 *
 * Attention is the whole ordering principle of this sidebar, and height is the honest way to spend
 * it: a muted three-line row is quieter but still costs three lines of scroll, so a hundred settled
 * sessions drown the nine that need you. Density is carried on the row rather than derived in the
 * view so the rule stays one decision in one place.
 */
export type SidebarDensity =
  /** Live session: the full card, because this is what you might act on now. */
  | "full"
  /** Closed but still active work: one line, reopenable, not a judgment about the work. */
  | "line"
  /** Done or saved: one line inside a section that is collapsed by default. */
  | "settled";

/**
 * What enrichment thinks should happen to a session, when that disagrees with where it actually is.
 *
 * Only surfaced while un-acted: a session already archived has nothing to suggest. `handoff` is
 * carried but never actionable from here -- performing a handoff is work that happens inside the
 * session, not a lifecycle flag flipped from a list.
 */
export interface SidebarSuggestion {
  readonly verb: Recommendation;
  /** True when the verb maps to a lifecycle action the sidebar can actually apply. */
  readonly actionable: boolean;
  /** Why, in enrichment's words. Present for archive and handoff; empty by design otherwise. */
  readonly reason: string | null;
  /** Enrichment judged the session never worth starting. Implies an archive verb. */
  readonly junk: boolean;
}

/**
 * A session's place in a cluster.
 *
 * The identity is the durable thing and the session points at it, so this travels with the row
 * rather than being looked up per render. `core` is the way into a cluster -- a coordinator, a
 * scout -- and `fleet` is one unit of its work.
 */
export interface SidebarMembership {
  readonly identityKey: string;
  readonly cluster: string;
  readonly role: string;
  readonly kind: "core" | "fleet";
  /**
   * The work item this fleet member is on, read off the identity key's third segment -- the event
   * for an event-watch worker, the epic for a pr-watch agent. Null for a core identity, which IS
   * its role rather than one unit of work. The slug is the stable grouping key; the label is what
   * a person reads, humanized here so both sidebars say the same words.
   */
  readonly workRef: string | null;
  readonly workLabel: string | null;
  /** When the work happens, epoch ms, when the cluster recorded a date for it. */
  readonly workStartsAt: number | null;
}

export type SidebarLifecycle = "active" | "completed" | "saved";
export type SidebarScope = SidebarLifecycle;
export type SidebarInclude = SidebarLifecycle | "t3";

/**
 * What the list is showing.
 *
 * `triage` is not a lifecycle -- a session is never "in triage" -- it is the active list filtered
 * to rows whose enrichment verdict still contradicts where they sit. Keeping it out of
 * `SidebarLifecycle` means no lifecycle-typed value can ever be handed one, and the catalogue
 * never has to answer a question it has no column for.
 */
export type SidebarView = SidebarScope | "triage" | "incognito" | "t3";

export const SIDEBAR_VIEWS: readonly SidebarView[] =
  ["active", "saved", "t3", "completed", "triage", "incognito"];

/**
 * The lifecycle a view browses. Triage reads the active list, then filters it.
 *
 * Incognito reads the active list for the same reason and one more: a marked session is excluded
 * from the catalogue's per-lifecycle id lists entirely, so there is no id set to address it by.
 * The rows it wants are live ones, and live rows come from cmux rather than from those lists.
 */
export function lifecycleForView(view: SidebarView): SidebarScope {
  return view === "triage" || view === "incognito" || view === "t3" ? "active" : view;
}

export interface ProjectionInput {
  readonly live: readonly LiveSessionInput[];
  /** Live cmux workspaces no session owns; omitted entirely when the caller does not collect them. */
  readonly workspaces?: readonly LiveWorkspaceInput[];
  /** Every live cmux session id, including non-primary surfaces that do not get their own row. */
  readonly liveSessionIds?: ReadonlySet<string>;
  readonly indexed: readonly IndexedSessionInput[];
  /** Three-state browser lifecycle keyed by canonical session id and any known resume alias. */
  readonly lifecycles?: ReadonlyMap<string, SidebarLifecycle>;
  /** Full catalogue lifecycle used for decisions that must distinguish idle from parked. */
  readonly catalogueLifecycles?: ReadonlyMap<string, Lifecycle>;
  /** Canonical catalogue id keyed by itself and any known resume alias. */
  readonly canonicalSessionIds?: ReadonlyMap<string, string>;
  /** Which lifecycle the caller is browsing. */
  readonly scope?: SidebarScope;
  /** Absolute directory -> its checkout, for whichever directories the caller resolved. */
  readonly checkouts: ReadonlyMap<string, CheckoutInput>;
  /** Absolute directories that publish a favicon; the row then links to the server's endpoint. */
  readonly faviconDirectories?: ReadonlySet<string>;
  /** Unread notification counts keyed by stable workspace UUID, as cmux reports them. */
  readonly unreadByWorkspaceId?: ReadonlyMap<string, number>;
  /** Cluster membership keyed by canonical session id and resume alias. */
  readonly memberships?: ReadonlyMap<string, SidebarMembership>;
  /**
   * Sessions marked incognito, keyed by canonical session id and resume alias.
   *
   * Only routes them to their own section. Dropping the ones that are not open is the caller's
   * job, because the caller is where liveness is read.
   */
  readonly incognitoSessionIds?: ReadonlySet<string>;
  /** Durable T3 provenance keyed by canonical session id and resume alias. */
  readonly t3AssociatedSessionIds?: ReadonlySet<string>;
  /** Keep only T3-associated rows, across all lifecycles. */
  readonly t3Only?: boolean;
  /** Include T3 rows in an otherwise ordinary view, used by global search. */
  readonly includeT3?: boolean;
  /** Enrichment records keyed by canonical session id and resume alias. */
  readonly summaries?: ReadonlyMap<string, StoredEnrichment>;
  /** Versioned category projection keyed by canonical session id and resume alias. */
  readonly categories?: ReadonlyMap<string, SidebarCategoryProjection>;
  /** Null when projection succeeded, otherwise the fail-closed registry/read diagnostic. */
  readonly categoryProjectionError?: string | null;
  /**
   * Titles the catalogue owns, already resolved by `displayTitle`: a human's title first, then
   * enrichment's. Absent means nothing outranks the index title. Without this an enriched
   * session keeps whatever cmux happened to call the tab, while `ccs ls` and the TUI show the
   * accurate name -- the same session under two names in two places.
   */
  readonly preferredTitles?: ReadonlyMap<string, string>;
  /** False when cmux state could not be read; the UI must not claim sessions are closed. */
  readonly livenessReadable: boolean;
  /** False when the session index could not be read; models and the resume shelf go missing. */
  readonly indexReadable?: boolean;
  /** False when lifecycle state could not be read; every visible row then degrades to active. */
  readonly catalogueReadable?: boolean;
  /** Epoch milliseconds used for relative times. */
  readonly now: number;
  /** How many resumable sessions the active shelf may show. */
  /**
   * Additional lifecycles for non-browser consumers that intentionally combine scopes. The web
   * sidebar uses dedicated Active, Saved, and Done views and leaves this absent.
   */
  readonly includeLifecycles?: readonly SidebarLifecycle[];
  /** Keep only rows carrying an un-acted enrichment verdict. */
  readonly triageOnly?: boolean;
  /** Keep only open incognito rows. The incognito view is the active list narrowed to them. */
  readonly incognitoOnly?: boolean;
  /** Totals per lifecycle, from the catalogue rather than from the rows in view. */
  readonly lifecycleCounts?: Readonly<Record<SidebarLifecycle, number>>;
  /** Canonical non-incognito, non-auxiliary rows in the overlapping T3 view. */
  readonly t3Count?: number;
  /**
   * Whether the index scan hit its limit, and so may have more rows behind it.
   *
   * The client cannot work this out from the rows it receives. Most of what the scan reads is
   * filtered out before projection -- 2107 of 2623 sessions on the live store are delegated seats
   * -- so a response carrying 58 rows can sit on a scan of 160, and "few rows came back" says
   * nothing about whether asking again would help.
   */
  readonly hasMoreRows?: boolean;
  readonly recentLimit?: number;
  /** How many rows a Saved or Done history view may show. */
  readonly historyLimit?: number;
}

export type SidebarSection =
  | "needs-you"
  | "working"
  | "ready"
  | "recent"
  | "other"
  /** Lifecycle headings used when Saved or Done is the selected scope. */
  | "completed"
  | "saved"
  /**
   * Open incognito sessions, and only those.
   *
   * Not a lifecycle: a marked session keeps whatever lifecycle it had. It is here because the
   * guarantee incognito makes is about history, not about the machine you are sitting at — a
   * session running in front of you is not a secret from you. The moment it closes it leaves this
   * section and appears nowhere else, which is the whole of what "for as long as it is open" buys.
   */
  | "incognito";

export interface SidebarModel {
  readonly id: string;
  /** Short display name, e.g. `Sol`, `Opus`, `Fable`. */
  readonly label: string;
  /** Which provider icon the UI should draw. */
  readonly provider: "anthropic" | "openai" | "unknown";
  readonly color: string;
}

/** What every row carries, whatever is behind it. */
interface SidebarRowShared {
  /** Stable identity for keys and actions: a canonical session id, or a workspace UUID. */
  readonly id: string;
  /** How much height this row is worth. See `SidebarDensity`. */
  readonly density: SidebarDensity;
  /** True when cmux has the workspace pinned, so the UI can lead with it. */
  readonly pinned: boolean;
  /** True when this is the workspace cmux currently has focused. */
  readonly focused: boolean;
  /** Middle line: what this row is. */
  readonly name: string;
  /** Top left: the project this row belongs to, stable across its worktrees. */
  readonly directory: string | null;
  readonly directoryPath: string | null;
  /** Where the UI can fetch the project's own icon, when it publishes one. */
  readonly faviconUrl: string | null;
  /** Bottom left: the git worktree, when the directory is inside one. */
  readonly worktree: string | null;
  /** Top right: cmux's own status pill, never synthesized by this module. */
  readonly status: CmuxClaudeStatus | null;
  /** Why the pill is absent, so a failed read is never represented as a published Ready state. */
  readonly statusAvailability: CmuxStatusAvailability;
  /** Bottom right: epoch milliseconds of the last recorded activity. */
  readonly lastActivityAt: number | null;
  readonly section: SidebarSection;
  /** Present only while the row occupies a cmux workspace. */
  readonly workspaceRef: string | null;
  readonly workspaceId: string | null;
  /**
   * The ⌘N that jumps to this row, or null when none does. Only ⌘1…9 exist and they count within
   * the focused window, so a row in a background window or past the ninth position has none.
   */
  readonly shortcut: number | null;
  /** Which cmux window holds the workspace, so the UI can group by it. */
  readonly windowRef: string | null;
  readonly windowId: string | null;
  /**
   * Unread cmux notifications for this row's workspace — cmux's own count, never derived from
   * status. Zero both when there are none and when the list could not be read; an invented
   * badge is worse than a missing one.
   */
  readonly unread: number;
}

/** A row backed by a Claude session, live or resumable. */
export interface SidebarSessionRow extends SidebarRowShared {
  readonly kind: "session";
  readonly sessionId: string;
  readonly lifecycle: SidebarLifecycle;
  /** Durable provenance: this session has been positively associated with a T3 Code thread. */
  readonly t3Associated?: boolean;
  /** Bottom right: the model behind the session. */
  readonly model: SidebarModel | null;
  /**
   * What this session was about, from catalogue enrichment. Null for sessions that have never
   * been enriched — the UI shows nothing rather than inventing a description.
   */
  readonly summary: SidebarSummary | null;
  /**
   * Enrichment's verdict, when it contradicts where the session actually sits. Null when there is
   * no enrichment, when it says `continue`, or when its verdict has already been applied.
   */
  readonly suggestion: SidebarSuggestion | null;
  /** Which cluster and role this session belongs to, when it belongs to one. */
  readonly membership: SidebarMembership | null;
  /** Public category seam; null only when registry/storage projection was unavailable. */
  readonly category: SidebarCategoryProjection | null;
}

/**
 * A row backed only by a cmux workspace — no session, so no model and no lifecycle.
 *
 * These exist so every tab cmux can show is reachable from here. Lifecycle actions do not apply:
 * there is nothing to complete or archive, and the type says so rather than leaving a consumer to
 * discover it by calling `ccs finish` on a browser pane.
 */
export interface SidebarWorkspaceRow extends SidebarRowShared {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly windowId: string;
  readonly windowRef: string;
  readonly surfaceKinds: readonly string[];
}

export type SidebarRow = SidebarSessionRow | SidebarWorkspaceRow;

export interface SidebarSnapshot {
  readonly rows: readonly SidebarRow[];
  readonly livenessReadable: boolean;
  /** False when the index was unreadable, so the UI can say what is missing rather than imply it. */
  readonly indexReadable: boolean;
  /** False when lifecycle state was unreadable and visible rows were conservatively left active. */
  readonly catalogueReadable: boolean;
  /** Wire version for each row's category projection. */
  readonly categoryProjectionVersion: 1;
  /** Fail-closed registry/storage diagnostic; null when category projection succeeded. */
  readonly categoryProjectionError: string | null;
  /**
   * How many sessions sit in each lifecycle, whatever the current scope shows.
   *
   * Counted across the whole catalogue rather than the rendered rows, because the point of the
   * figure is to say what is NOT on screen. Zero when the catalogue is unreadable, which the
   * flag above already qualifies.
   */
  readonly lifecycleCounts: Readonly<Record<SidebarLifecycle, number>>;
  /** T3 is provenance, not a lifecycle, so its overlapping view count travels separately. */
  readonly t3Count?: number;
  /** True while the index scan is still limit-bound: a larger request may return more rows. */
  readonly hasMoreRows: boolean;
  /** Compatibility field retained for older clients; stable because no shipped client consumes it. */
  readonly generatedAt: 0;
}

const DEFAULT_RECENT_LIMIT = 8;
const DEFAULT_HISTORY_LIMIT = 50;

/** Collapse catalogue's non-terminal states into the sidebar's active lifecycle. */
export function sidebarLifecycleOf(lifecycle: Lifecycle): SidebarLifecycle {
  if (lifecycle === "saved") return "saved";
  if (lifecycle === "completed" || lifecycle === "archived") return "completed";
  return "active";
}

/** Which provider's logo the UI draws for a registry `provider` value. */
function providerIcon(provider: string | null, modelId: string): SidebarModel["provider"] {
  if (provider === "claude") return "anthropic";
  if (provider === "codex") return "openai";
  if (provider !== null) return "unknown";
  // Historical rows carry no provider; their id still says who drew them.
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-")) return "openai";
  return "unknown";
}

/**
 * Resolve one model id to its short display identity.
 *
 * The colour comes through `familyOf` rather than a second table here: CCS already decides what
 * colour each model is, and a second copy would drift the moment either side changed.
 */
export function modelOf(modelId: string): SidebarModel {
  const color = familyOf(modelId).color;
  const registry = displayModelRegistry();
  const short = registry ? shortOf(registry, modelId) : null;
  const provider = registry ? modelById(registry, modelBase(modelId))?.provider ?? null : null;
  return {
    id: modelId,
    label: short ?? modelId,
    provider: short ? providerIcon(provider, modelId) : "unknown",
    color,
  };
}

/**
 * The model a row should show: the one that accounts for the most spend, else the first
 * observed model so an unpriced gateway session still identifies itself.
 */
function dominantModel(session: IndexedSessionInput): SidebarModel | null {
  let best: string | null = null;
  let bestCost = -1;
  for (const [modelId, cost] of Object.entries(session.costByModel)) {
    if (cost > bestCost) {
      bestCost = cost;
      best = modelId;
    }
  }
  const chosen = bestCost > 0 ? best : (session.models[0] ?? best);
  return chosen ? modelOf(chosen) : null;
}

/**
 * cmux prefixes a workspace title with its own activity glyph (a braille spinner while a turn
 * runs, an asterisk when one ends, and quarter-moon/clock glyphs on newer builds). The sidebar
 * already shows that state as a status pill, so the glyph would be the same fact twice — and it
 * makes titles jitter as the spinner animates.
 */
const TITLE_ACTIVITY_GLYPHS = /^[⠀-⣿✱-❋◐-◓◴-◷·•\s]+/;

export function cleanSessionName(title: string): string {
  const cleaned = title.replace(TITLE_ACTIVITY_GLYPHS, "").trim();
  return cleaned.length > 0 ? cleaned : title.trim();
}

/**
 * Whether a workspace title is really a session id cmux fell back to, not a name.
 *
 * A resume that never re-registered its binding leaves the workspace titled with the raw session
 * UUID (or its first segment). Showing that as the row's name tells the reader nothing; the
 * indexed title, when one exists, is the session's actual subject.
 */
export function titleIsSessionIdish(title: string): boolean {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,3}(?:-[0-9a-f]{12})?$/i.test(title.trim());
}

/** The final path segment, which is what identifies a directory at a glance. */
export function directoryLabel(path: string | null): string | null {
  if (!path) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Which section a live session belongs in, read from cmux's own status label.
 *
 * cmux owns this vocabulary; we classify its words rather than inventing a parallel state
 * machine. A successful read with no published label lands in Ready. An unreadable command is
 * elevated to Needs you: that is an attention classification, not a fabricated cmux status, and
 * avoids silently demoting a session whose real pill may be Running or Needs input.
 */
export function sectionForStatus(
  status: CmuxClaudeStatus | null,
  availability: CmuxStatusAvailability = status ? "published" : "absent",
): SidebarSection {
  if (availability === "unreadable") return "needs-you";
  const label = status?.label?.toLowerCase() ?? "";
  if (!label) return "ready";
  if (label.includes("input") || label.includes("waiting") || label.includes("permission")) {
    return "needs-you";
  }
  if (label.includes("running") || label.includes("working") || label.includes("thinking")) {
    return "working";
  }
  return "ready";
}

/** Lookup functions and joined identity state shared by every projection stage. */
interface ProjectionLookups {
  readonly indexedById: ReadonlyMap<string, IndexedSessionInput>;
  readonly liveIds: ReadonlySet<string>;
  /** Canonical identities of every live session, for alias-proof "is this already running". */
  readonly liveCanonicalIds: ReadonlySet<string>;
  /** First indexed row per canonical id, for live sessions whose own id has no index row yet. */
  readonly indexedByCanonicalId: ReadonlyMap<string, IndexedSessionInput>;
  readonly liveById: ReadonlyMap<string, LiveSessionInput>;
  readonly lifecycleFor: (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ) => SidebarLifecycle;
  readonly catalogueLifecycleFor: (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ) => Lifecycle;
  readonly isIncognito: (sessionId: string, resumeId?: string) => boolean;
  readonly isT3Associated: (sessionId: string, resumeId?: string) => boolean;
  readonly canonicalSessionIdFor: (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ) => string;
  readonly unreadFor: (workspaceId: string | null) => number;
  readonly preferredTitleFor: (sessionId: string, resumeId?: string) => string | null;
  readonly membershipFor: (sessionId: string, resumeId?: string) => SidebarMembership | null;
  readonly categoryFor: (sessionId: string, resumeId?: string) => SidebarCategoryProjection | null;
  readonly summaryFor: (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ) => SidebarSummary | null;
  readonly faviconUrlFor: (cwd: string | null) => string | null;
  readonly projectFor: (cwd: string | null) => string | null;
  readonly worktreeFor: (cwd: string | null) => string | null;
}

/** Immutable facts passed between the private projection stages. */
interface ProjectionContext {
  readonly input: ProjectionInput;
  readonly scope: SidebarScope;
  readonly lookups: ProjectionLookups;
}

interface HistoryCandidate {
  readonly row: SidebarRow;
  readonly timestamp: number | null;
  readonly order: number;
}

/** Finished work belongs to its disposition, whatever its liveness would otherwise say. */
function sectionForLifecycle(
  lifecycle: SidebarLifecycle,
  whenActive: SidebarSection,
): SidebarSection {
  return lifecycle === "active" ? whenActive : lifecycle;
}

/** Liveness decides active density; terminal lifecycle always wins. */
function densityFor(live: boolean, lifecycle: SidebarLifecycle): SidebarDensity {
  return lifecycle !== "active" ? "settled" : live ? "full" : "line";
}

/** Enrichment's verdict, but only while it still contradicts the catalogue lifecycle. */
function suggestionFor(
  summary: SidebarSummary | null,
  lifecycle: Lifecycle,
): SidebarSuggestion | null {
  const verb = summary?.recommendation ?? null;
  if (recommendationDisagreement(verb, summary?.declined ?? null, lifecycle) === null || !verb) {
    return null;
  }
  return {
    verb,
    // Handoff is deliberately inert here: passing a thread on is work done inside the session,
    // not a flag flipped from a list. Archive recommendations are terminal and map to Done.
    actionable: verb === "complete" || verb === "archive",
    reason: summary?.reason ?? null,
    junk: summary?.junk ?? false,
  };
}

/** Construct every alias-sensitive lookup once, before any row stage runs. */
function buildProjectionContext(input: ProjectionInput): ProjectionContext {
  const indexedById = new Map<string, IndexedSessionInput>();
  for (const session of input.indexed) {
    indexedById.set(session.sessionId, session);
    // A resumed session is addressed by its resume id, so index both without losing the
    // canonical row when the two ids collide across sessions.
    if (!indexedById.has(session.resumeId)) indexedById.set(session.resumeId, session);
  }

  const lifecycles = input.lifecycles ?? new Map<string, SidebarLifecycle>();
  const lifecycleFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): SidebarLifecycle =>
    lifecycles.get(sessionId)
      ?? (indexed ? lifecycles.get(indexed.sessionId) ?? lifecycles.get(indexed.resumeId) : undefined)
      ?? "active";

  const catalogueLifecycles = input.catalogueLifecycles ?? new Map<string, Lifecycle>();
  const catalogueLifecycleFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): Lifecycle =>
    catalogueLifecycles.get(sessionId)
      ?? (indexed
        ? catalogueLifecycles.get(indexed.sessionId)
          ?? catalogueLifecycles.get(indexed.resumeId)
        : undefined)
      ?? (lifecycleFor(sessionId, indexed) === "completed"
        ? "completed"
        : lifecycleFor(sessionId, indexed) === "saved"
        ? "saved"
        : "idle");

  const incognitoSessionIds = input.incognitoSessionIds ?? new Set<string>();
  const t3AssociatedSessionIds = input.t3AssociatedSessionIds ?? new Set<string>();
  const canonicalSessionIds = input.canonicalSessionIds ?? new Map<string, string>();
  const canonicalSessionIdFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): string =>
    canonicalSessionIds.get(sessionId)
      ?? (indexed
        ? canonicalSessionIds.get(indexed.sessionId) ?? canonicalSessionIds.get(indexed.resumeId)
        : undefined)
      ?? sessionId;

  const liveIds = new Set(input.liveSessionIds ?? []);
  const liveById = new Map<string, LiveSessionInput>();
  for (const live of input.live) {
    liveIds.add(live.sessionId);
    liveById.set(live.sessionId, live);
    const indexed = indexedById.get(live.sessionId);
    if (!indexed) continue;
    liveIds.add(indexed.sessionId);
    liveIds.add(indexed.resumeId);
    if (!liveById.has(indexed.sessionId)) liveById.set(indexed.sessionId, live);
    if (!liveById.has(indexed.resumeId)) liveById.set(indexed.resumeId, live);
  }

  // The catalogue learns a resume's identity before the index re-scans, so canonical ids are the
  // join that works in the window where a freshly resumed session and its predecessor are still
  // two different index rows.
  const liveCanonicalIds = new Set<string>();
  for (const liveId of liveIds) {
    liveCanonicalIds.add(canonicalSessionIdFor(liveId, indexedById.get(liveId)));
  }

  // A freshly resumed session's live id has no index row yet, but its predecessor's row carries
  // the title and model that describe the same underlying session. Canonical identity is the join.
  const indexedByCanonicalId = new Map<string, IndexedSessionInput>();
  for (const session of input.indexed) {
    const canonical = canonicalSessionIdFor(session.sessionId, session);
    if (!indexedByCanonicalId.has(canonical)) indexedByCanonicalId.set(canonical, session);
  }

  const faviconDirectories = input.faviconDirectories ?? new Set<string>();
  const unreadByWorkspaceId = input.unreadByWorkspaceId ?? new Map<string, number>();
  const preferredTitles = input.preferredTitles ?? new Map<string, string>();
  const memberships = input.memberships ?? new Map<string, SidebarMembership>();
  const categories = input.categories ?? new Map<string, SidebarCategoryProjection>();
  const summaries = input.summaries ?? new Map<string, StoredEnrichment>();

  const summaryFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): SidebarSummary | null => {
    const found = summaries.get(sessionId)
      ?? (indexed ? summaries.get(indexed.sessionId) ?? summaries.get(indexed.resumeId) : undefined);
    if (!found) return null;
    const since = messagesSince(found, indexed?.messageCount ?? null);
    return {
      state: found.state,
      history: found.history,
      next: found.next,
      remaining: found.remaining,
      recommendation: found.recommendation,
      reason: found.reason,
      junk: found.junk,
      atMessages: found.atMessages,
      at: found.at,
      declined: found.declined,
      messagesSince: since,
      driftLabel: found.at === null
        ? null
        : enrichmentDriftLabel({
            messagesSince: since ?? 0,
            enrichmentAt: found.at,
            transcriptMtimeMs: indexed?.transcriptMtimeMs ?? null,
          }),
    };
  };

  return {
    input,
    scope: input.scope ?? "active",
    lookups: {
      indexedById,
      liveIds,
      liveCanonicalIds,
      indexedByCanonicalId,
      liveById,
      lifecycleFor,
      catalogueLifecycleFor,
      canonicalSessionIdFor,
      isIncognito: (sessionId: string, resumeId?: string): boolean =>
        incognitoSessionIds.has(sessionId) || (resumeId !== undefined && incognitoSessionIds.has(resumeId)),
      isT3Associated: (sessionId: string, resumeId?: string): boolean =>
        t3AssociatedSessionIds.has(sessionId)
          || (resumeId !== undefined && t3AssociatedSessionIds.has(resumeId)),
      unreadFor: (workspaceId: string | null): number =>
        (workspaceId ? unreadByWorkspaceId.get(workspaceId) : 0) ?? 0,
      preferredTitleFor: (sessionId: string, resumeId?: string): string | null =>
        preferredTitles.get(sessionId) ?? (resumeId ? preferredTitles.get(resumeId) ?? null : null),
      membershipFor: (sessionId: string, resumeId?: string): SidebarMembership | null =>
        memberships.get(sessionId) ?? (resumeId ? memberships.get(resumeId) ?? null : null),
      categoryFor: (sessionId: string, resumeId?: string): SidebarCategoryProjection | null =>
        categories.get(sessionId) ?? (resumeId ? categories.get(resumeId) ?? null : null),
      summaryFor,
      faviconUrlFor: (cwd: string | null): string | null =>
        cwd && faviconDirectories.has(cwd) ? `/api/favicon?dir=${encodeURIComponent(cwd)}` : null,
      // The top line names the project, not the linked worktree's folder.
      projectFor: (cwd: string | null): string | null =>
        (cwd ? input.checkouts.get(cwd)?.project : null) ?? directoryLabel(cwd),
      worktreeFor: (cwd: string | null): string | null =>
        (cwd ? input.checkouts.get(cwd)?.worktree : null) ?? null,
    },
  };
}

/** Construct one visible live-session row without selecting whether it belongs in the result. */
function buildLiveSessionRow(
  context: ProjectionContext,
  live: LiveSessionInput,
  indexed: IndexedSessionInput | undefined,
): SidebarSessionRow {
  const { lookups } = context;
  const canonicalId = lookups.canonicalSessionIdFor(live.sessionId, indexed);
  // A resumed session may predate its own index row; the predecessor's row is the same session.
  const canonicalIndexed = indexed ?? lookups.indexedByCanonicalId.get(canonicalId);
  const cwd = live.cwd ?? canonicalIndexed?.cwd ?? null;
  const cmuxActivity = live.updatedAt === null ? null : live.updatedAt * 1000;
  const liveSummary = lookups.summaryFor(live.sessionId, indexed);
  const liveLifecycle = lookups.lifecycleFor(live.sessionId, indexed);
  return {
    kind: "session",
    id: canonicalId,
    workspaceId: live.workspaceId,
    windowId: live.windowId,
    windowRef: live.windowRef,
    unread: lookups.unreadFor(live.workspaceId),
    shortcut: live.shortcut,
    summary: liveSummary,
    suggestion: suggestionFor(
      liveSummary,
      lookups.catalogueLifecycleFor(live.sessionId, indexed),
    ),
    membership: lookups.membershipFor(live.sessionId, indexed?.resumeId),
    category: lookups.categoryFor(live.sessionId, indexed?.resumeId),
    density: densityFor(true, liveLifecycle),
    sessionId: canonicalId,
    lifecycle: liveLifecycle,
    t3Associated: lookups.isT3Associated(live.sessionId, indexed?.resumeId),
    name: cleanSessionName(
      lookups.preferredTitleFor(live.sessionId, indexed?.resumeId)
        ?? lookups.preferredTitleFor(canonicalId, canonicalIndexed?.resumeId)
        // The idish test runs on the cleaned title: cmux prefixes an activity glyph, and
        // "◐ <uuid>" is still a placeholder, not a name.
        ?? (live.workspaceTitle !== null
            && !titleIsSessionIdish(cleanSessionName(live.workspaceTitle))
          ? live.workspaceTitle
          : null)
        ?? canonicalIndexed?.title ?? live.workspaceTitle ?? "Untitled session",
    ),
    directory: lookups.projectFor(cwd),
    directoryPath: cwd,
    faviconUrl: lookups.faviconUrlFor(cwd),
    worktree: lookups.worktreeFor(cwd),
    model: canonicalIndexed ? dominantModel(canonicalIndexed) : null,
    status: live.status,
    statusAvailability: live.statusAvailability,
    lastActivityAt: cmuxActivity ?? parseTimestamp(canonicalIndexed?.lastTs ?? null),
    // Incognito overrides the lifecycle section rather than sitting beside it: a marked session
    // must appear in exactly one place, and "Working" plus "Incognito" would be two.
    section: lookups.isIncognito(live.sessionId, indexed?.resumeId)
      ? "incognito"
      : sectionForLifecycle(
        liveLifecycle,
        sectionForStatus(live.status, live.statusAvailability),
      ),
    workspaceRef: live.workspaceRef,
    pinned: live.pinned,
    focused: live.focused,
  };
}

/** Construct one indexed-session row without selecting shelf or history capacity. */
function buildIndexedSessionRow(
  context: ProjectionContext,
  session: IndexedSessionInput,
  knownLive: boolean,
): SidebarSessionRow {
  const { lookups } = context;
  const summary = lookups.summaryFor(session.sessionId, session);
  const lifecycle = lookups.lifecycleFor(session.sessionId, session);
  return {
    kind: "session",
    id: lookups.canonicalSessionIdFor(session.sessionId, session),
    workspaceId: null,
    windowId: null,
    windowRef: null,
    unread: 0,
    shortcut: null,
    summary,
    suggestion: suggestionFor(
      summary,
      lookups.catalogueLifecycleFor(session.sessionId, session),
    ),
    membership: lookups.membershipFor(session.sessionId, session.resumeId),
    category: lookups.categoryFor(session.sessionId, session.resumeId),
    density: densityFor(knownLive, lifecycle),
    sessionId: lookups.canonicalSessionIdFor(session.sessionId, session),
    lifecycle,
    t3Associated: lookups.isT3Associated(session.sessionId, session.resumeId),
    name: cleanSessionName(
      lookups.preferredTitleFor(session.sessionId, session.resumeId) ?? session.title,
    ),
    directory: lookups.projectFor(session.cwd),
    directoryPath: session.cwd,
    faviconUrl: lookups.faviconUrlFor(session.cwd),
    worktree: lookups.worktreeFor(session.cwd),
    model: dominantModel(session),
    status: null,
    statusAvailability: knownLive ? "absent" : "not-live",
    lastActivityAt: parseTimestamp(session.lastTs),
    section: lookups.isIncognito(session.sessionId, session.resumeId)
      ? "incognito"
      : sectionForLifecycle(lifecycle, knownLive ? "ready" : "recent"),
    workspaceRef: null,
    pinned: false,
    focused: false,
  };
}

/** Construct one sessionless cmux workspace row. */
function buildSessionlessWorkspaceRow(
  context: ProjectionContext,
  workspace: LiveWorkspaceInput,
): SidebarWorkspaceRow {
  const { lookups } = context;
  return {
    kind: "workspace",
    id: workspace.workspaceId,
    // A workspace only appears here while it is open, so it is always live and never settled.
    density: "full",
    name: cleanSessionName(
      workspace.workspaceTitle ?? directoryLabel(workspace.cwd) ?? "Untitled tab",
    ),
    directory: lookups.projectFor(workspace.cwd),
    directoryPath: workspace.cwd,
    faviconUrl: lookups.faviconUrlFor(workspace.cwd),
    worktree: lookups.worktreeFor(workspace.cwd),
    status: null,
    statusAvailability: "absent",
    lastActivityAt: null,
    section: "other",
    workspaceId: workspace.workspaceId,
    workspaceRef: workspace.workspaceRef,
    windowId: workspace.windowId,
    windowRef: workspace.windowRef,
    unread: lookups.unreadFor(workspace.workspaceId),
    shortcut: workspace.shortcut,
    surfaceKinds: workspace.surfaceKinds,
    pinned: workspace.pinned,
    focused: workspace.focused,
  };
}

/** Select active live rows, sessionless workspaces, and the separately capped resume shelf. */
function selectActiveRows(context: ProjectionContext): SidebarRow[] {
  const { input, lookups } = context;
  const rows: SidebarRow[] = [];
  const shelfLifecycles = new Set<SidebarLifecycle>([
    "active",
    ...(input.includeLifecycles ?? []),
  ]);
  // Two live aliases of one session would publish the same canonical row id — duplicate SwiftUI
  // identities, and any per-id client state (hover, selection) painting both at once.
  const liveRowIndexById = new Map<string, number>();
  for (const live of input.live) {
    const indexed = lookups.indexedById.get(live.sessionId);
    const lifecycle = lookups.lifecycleFor(live.sessionId, indexed);
    if (!shelfLifecycles.has(lifecycle)) continue;
    if (
      lookups.isT3Associated(live.sessionId, indexed?.resumeId)
      && !lookups.isIncognito(live.sessionId, indexed?.resumeId)
      && !input.includeT3
    ) continue;
    const row = buildLiveSessionRow(context, live, indexed);
    const existingAt = liveRowIndexById.get(row.id);
    if (existingAt === undefined) {
      liveRowIndexById.set(row.id, rows.length);
      rows.push(row);
    } else if (row.focused && rows[existingAt]?.focused === false) {
      // Of two aliases, the one cmux says is focused is the one the person is looking at.
      rows[existingAt] = row;
    }
  }

  for (const workspace of input.workspaces ?? []) {
    rows.push(buildSessionlessWorkspaceRow(context, workspace));
  }

  // The shelf only makes sense when liveness is readable; otherwise resuming could duplicate work.
  if (!input.livenessReadable) return rows;

  const limit = input.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const seen = new Set<string>();
  let added = 0;
  for (const session of input.indexed) {
    if (added >= limit) break;
    if (!shelfLifecycles.has(lookups.lifecycleFor(session.sessionId, session))) continue;
    if (
      lookups.isT3Associated(session.sessionId, session.resumeId)
      && !lookups.isIncognito(session.sessionId, session.resumeId)
      && !input.includeT3
    ) continue;
    if (lookups.liveIds.has(session.sessionId) || lookups.liveIds.has(session.resumeId)) continue;
    // A predecessor whose resumed incarnation is running shares its canonical id with a live row;
    // shelving it would offer a second "resume" for work that is already on screen.
    if (lookups.liveCanonicalIds.has(lookups.canonicalSessionIdFor(session.sessionId, session))) {
      continue;
    }
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    rows.push(buildIndexedSessionRow(context, session, false));
    added += 1;
  }
  return rows;
}

function compareHistory(left: HistoryCandidate, right: HistoryCandidate): number {
  if (left.timestamp !== right.timestamp) {
    return (right.timestamp ?? Number.NEGATIVE_INFINITY)
      - (left.timestamp ?? Number.NEGATIVE_INFINITY);
  }
  return left.order - right.order;
}

/** Select terminal live rows before spending the remaining history capacity on closed rows. */
function selectHistoryRows(context: ProjectionContext): SidebarRow[] {
  const { input, lookups, scope } = context;
  const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const liveCandidates: HistoryCandidate[] = [];
  const closedCandidates: HistoryCandidate[] = [];
  const seen = new Set<string>();

  // Terminal live sessions remain actionable even without an index join or within the index cap.
  for (const [order, live] of input.live.entries()) {
    const indexed = lookups.indexedById.get(live.sessionId);
    if (lookups.lifecycleFor(live.sessionId, indexed) !== scope) continue;
    const row = buildLiveSessionRow(context, live, indexed);
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    liveCandidates.push({ row, timestamp: row.lastActivityAt, order });
  }

  for (const [index, session] of input.indexed.entries()) {
    if (lookups.lifecycleFor(session.sessionId, session) !== scope) continue;
    const live = lookups.liveById.get(session.sessionId) ?? lookups.liveById.get(session.resumeId);
    const knownLive = live !== undefined
      || lookups.liveIds.has(session.sessionId)
      || lookups.liveIds.has(session.resumeId);
    const row = live
      ? buildLiveSessionRow(context, live, session)
      : buildIndexedSessionRow(context, session, knownLive);
    if (seen.has(row.sessionId)) continue;
    // Without a readable liveness snapshot, every unobserved indexed row might still be running.
    if (!input.livenessReadable && !knownLive) continue;
    seen.add(row.sessionId);
    const candidate = {
      row,
      timestamp: row.lastActivityAt,
      order: input.live.length + index,
    };
    if (knownLive) liveCandidates.push(candidate);
    else closedCandidates.push(candidate);
  }

  liveCandidates.sort(compareHistory);
  closedCandidates.sort(compareHistory);
  const selected = liveCandidates.slice(0, limit);
  selected.push(...closedCandidates.slice(0, Math.max(0, limit - selected.length)));
  selected.sort(compareHistory);
  return selected.map((candidate) => candidate.row);
}

/** Select every T3-associated lifecycle into one provenance view, newest first. */
function selectT3Rows(context: ProjectionContext): SidebarRow[] {
  const { input, lookups } = context;
  const candidates: HistoryCandidate[] = [];
  const seen = new Set<string>();

  for (const [order, live] of input.live.entries()) {
    const indexed = lookups.indexedById.get(live.sessionId);
    if (lookups.isIncognito(live.sessionId, indexed?.resumeId)) continue;
    if (!lookups.isT3Associated(live.sessionId, indexed?.resumeId)) continue;
    const row = buildLiveSessionRow(context, live, indexed);
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    candidates.push({ row, timestamp: row.lastActivityAt, order });
  }

  for (const [index, session] of input.indexed.entries()) {
    if (lookups.isIncognito(session.sessionId, session.resumeId)) continue;
    if (!lookups.isT3Associated(session.sessionId, session.resumeId)) continue;
    const live = lookups.liveById.get(session.sessionId) ?? lookups.liveById.get(session.resumeId);
    const knownLive = live !== undefined
      || lookups.liveIds.has(session.sessionId)
      || lookups.liveIds.has(session.resumeId);
    const row = live
      ? buildLiveSessionRow(context, live, session)
      : buildIndexedSessionRow(context, session, knownLive);
    if (seen.has(row.sessionId)) continue;
    if (!input.livenessReadable && !knownLive) continue;
    seen.add(row.sessionId);
    candidates.push({
      row,
      timestamp: row.lastActivityAt,
      order: input.live.length + index,
    });
  }

  candidates.sort(compareHistory);
  return candidates
    .slice(0, input.historyLimit ?? DEFAULT_HISTORY_LIMIT)
    .map((candidate) => candidate.row);
}

/** Apply the final view filter only after selection and capacity decisions are complete. */
function selectVisibleRows(context: ProjectionContext, rows: readonly SidebarRow[]): SidebarRow[] {
  if (context.input.incognitoOnly) {
    // Filtering on the assigned section rather than re-testing the id set: the section is where
    // "incognito and open" was already decided, so the view cannot disagree with the list it
    // narrows. A sessionless workspace has no session to be marked and is never one of these.
    return rows.filter((row) => row.section === "incognito");
  }
  return context.input.triageOnly
    ? rows.filter((row) => row.kind === "session" && row.suggestion !== null)
    : [...rows];
}

/** Assemble stable snapshot metadata without allowing the clock to perturb the wire body. */
function assembleSidebarSnapshot(
  input: ProjectionInput,
  rows: readonly SidebarRow[],
): SidebarSnapshot {
  return {
    rows,
    livenessReadable: input.livenessReadable,
    indexReadable: input.indexReadable ?? true,
    catalogueReadable: input.catalogueReadable ?? true,
    categoryProjectionVersion: 1,
    categoryProjectionError: input.categoryProjectionError ?? null,
    lifecycleCounts: input.lifecycleCounts ?? { active: 0, completed: 0, saved: 0 },
    t3Count: input.t3Count ?? 0,
    hasMoreRows: input.hasMoreRows ?? false,
    // The browser does not consume this field. Keep it byte-stable so an unchanged representation
    // can share one strong ETag instead of changing merely because another poll happened later.
    generatedAt: 0,
  };
}

/**
 * Build the sidebar's rows.
 *
 * Active live sessions keep cmux's ordering, while lifecycle history follows indexed recency.
 * Closed rows are emitted only after a readable liveness check, because otherwise a running
 * session could be represented as resumable.
 */
export function projectSidebar(input: ProjectionInput): SidebarSnapshot {
  const context = buildProjectionContext(input);
  const selected = input.t3Only
    ? selectT3Rows(context)
    : context.scope === "active"
    ? selectActiveRows(context)
    : selectHistoryRows(context);
  const visible = selectVisibleRows(context, selected);
  return assembleSidebarSnapshot(input, visible);
}

/** Directories the caller should resolve worktrees for, deduplicated. */
export function directoriesToResolve(
  live: readonly LiveSessionInput[],
  indexed: readonly IndexedSessionInput[],
  recentLimit = DEFAULT_RECENT_LIMIT,
): string[] {
  const directories = new Set<string>();
  for (const session of live) {
    if (session.cwd) directories.add(session.cwd);
  }
  let considered = 0;
  for (const session of indexed) {
    if (considered >= recentLimit * 4) break;
    considered += 1;
    if (session.cwd) directories.add(session.cwd);
  }
  return [...directories];
}
