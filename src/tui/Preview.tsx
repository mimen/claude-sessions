import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "../index/index.ts";
import type { CostBreakdown } from "../index/cost-rollup.ts";
import type { TranscriptLine } from "../transcript.ts";
import { formatBytes, formatAge } from "../store.ts";
import { formatCost } from "../cost.ts";
import { theme, costColor } from "./theme.ts";
import { formatTokens, modelBreakdown, formatDuration, burnPerDay } from "./format.ts";
import type { TaskSummary } from "../tasks/reader.ts";

interface PreviewProps {
  row: SessionRow;
  skeleton: string;
  parentTitle: string | null;
  descendantCount: number;
  selfCost: number;
  totalCost: number;
  providerCost: CostBreakdown;
  /** Catalogue classification for the selected session. */
  event?: string | null;
  skill?: string | null;
  project?: string | null;
  kind?: "session" | "loop";
  sessionClass?: "work_body" | "auxiliary" | null;
  /** Cluster membership + PR/work-item identity (catalogue). */
  system?: string | null;
  gusWork?: string | null;
  /** The work-item's Salesforce record id (`meta.gus_work_sf_id`), stamped by the cluster's
   * sensor. Enables a proper `/ADM_Work__c/<sfId>/view` deep link; absent → search fallback. */
  gusWorkSfId?: string | null;
  prNumber?: number | null;
  prRepo?: string | null;
  prState?: string | null;
  /** Epic (resolved from the epics entity) — name + deep link. */
  epicName?: string | null;
  epicUrl?: string | null;
  /** Review-app URL (fleet identity attr, per-role table). Clickable when present. */
  reviewAppUrl?: string | null;
  /** Claude Code task list for this session (~/.claude/tasks/<id>/), if any. */
  tasks?: TaskSummary | null;
  /** Total height available to the pane (border included). */
  height: number;
  /** Total width of the pane (border included). Fixed so the box always spans its column, even when
   *  the content is narrow (short peek / sparse metadata) — otherwise the bordered box shrinks to fit. */
  width: number;
  /** false → compact identity strip + big scrollable content peek (default); true → full metadata
   *  dossier (every field + cost breakdown), toggled with `d`. */
  detailsOpen: boolean;
  /** Real transcript for the peek, lazily loaded on first J/K scroll; null → show the baked skeleton. */
  peekLines: TranscriptLine[] | null;
  /** Peek scroll offset in rows (only meaningful once `peekLines` is loaded); clamped here. */
  peekScroll: number;
}

const SOURCE_COLOR = {
  native: theme.sourceNative,
  codex: theme.sourceCodex,
  fallback: theme.sourceFallback,
} as const;

// ---- Content peek (compact-mode default) --------------------------------------------------
// The peek renders role-tagged rows so top-to-bottom reads as a conversation, and it gets a
// deterministic line budget (not flexbox leftover), so it can window + scroll predictably.

type PeekKind = "user" | "assistant" | "tool" | "meta";
interface PeekRow {
  kind: PeekKind;
  text: string;
  /** An elision marker ("…" between the skeleton's head and tail turns), rendered as a rule. */
  sep?: boolean;
}

const PEEK_GUTTER: Record<PeekKind, string> = { user: "you", assistant: "ai", tool: "", meta: "" };
const PEEK_COLOR: Record<PeekKind, string> = {
  user: theme.accent,
  assistant: theme.title,
  tool: theme.faint,
  meta: theme.muted,
};

/** Drop the skeleton's tool stubs ("[tool: X]", "[tool result]") and collapse whitespace — the peek
 *  is for reading the conversation, not the plumbing. A turn left empty by this is dropped entirely. */
function stripTools(s: string): string {
  return s
    .replace(/\[tool: [^\]]*\]/g, " ")
    .replace(/\[tool result\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the baked skeleton ("role: text" lines + a bare "…" elision marker) into role-tagged rows.
 *  Tolerates the pre-collapse multi-line format: a continuation line that lacks a role prefix renders
 *  as a gutter-less muted row rather than being misattributed. Tool-only turns strip to nothing. */
function skeletonRows(skeleton: string): PeekRow[] {
  const rows: PeekRow[] = [];
  for (const raw of skeleton.split("\n")) {
    if (raw === "…") {
      rows.push({ kind: "meta", text: "earlier turns", sep: true });
      continue;
    }
    const m = /^(user|assistant): ?(.*)$/.exec(raw);
    const kind: PeekKind = m ? (m[1] as PeekKind) : "meta";
    const text = stripTools(m ? m[2]! : raw);
    if (text) rows.push({ kind, text });
  }
  return rows;
}

/** Flatten a loaded real transcript into single-row peek entries. Tool calls/results and the viewer's
 *  blank turn-separators are dropped — the you/ai gutter delimits turns, and every peek row is precious. */
function transcriptRows(lines: TranscriptLine[]): PeekRow[] {
  return lines
    .filter((l) => l.kind === "user" || l.kind === "assistant")
    .map((l) => ({ kind: l.kind, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((r) => r.text !== "");
}

/** Interleave a faint " · " between chip nodes so a compact line reads as one dotted run. */
function withSeps(nodes: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((n, i) => {
    if (i) out.push(<Text key={`sep-${i}`} color={theme.faint}> · </Text>);
    out.push(n);
  });
  return out;
}

/** One peek row: a fixed role gutter (you/ai) + truncated text, or a dim elision rule. */
function PeekLine({ row }: { row: PeekRow }): React.ReactElement {
  if (row.sep) {
    return (
      <Text color={theme.faint} wrap="truncate-end">
        {`  ┈┈┈  ${row.text} elided  ┈┈┈`}
      </Text>
    );
  }
  return (
    <Box>
      <Box width={4} flexShrink={0}>
        <Text color={theme.muted}>{PEEK_GUTTER[row.kind]}</Text>
      </Box>
      <Text color={PEEK_COLOR[row.kind]} wrap="truncate-end">
        {row.text || " "}
      </Text>
    </Box>
  );
}

function fmtTs(iso: string | null): string {
  if (!iso) return "?";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** OSC-8 terminal hyperlink: clickable `text` that opens `url` in supporting terminals. */
function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** GUS deep link for a W-number. With the 18-char sfId (stamped on the row's meta by the
 * cluster's sensor, e.g. pr-watch's catalogue_sync) we produce a proper record URL; without it,
 * fall back to the object search that resolves the W-number by name. */
function gusUrl(w: string, sfId: string | null | undefined): string {
  return sfId
    ? `https://gus.lightning.force.com/lightning/r/ADM_Work__c/${sfId}/view`
    : `https://gus.lightning.force.com/lightning/o/ADM_Work__c/list?filterName=Recent&search=${encodeURIComponent(w)}`;
}

function Field({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <Box width={9} flexShrink={0}>
        <Text color={theme.muted}>{label}</Text>
      </Box>
      <Text color={color ?? theme.title} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
}

/**
 * Detail pane for the selected Session — metadata, classification, a cost/token panel, and a
 * content peek. The fixed blocks never shrink; the peek flex-grows and clips (overflow hidden),
 * so content is never hand-counted against `height` (which used to overlap rows when it overran).
 */
export function Preview({
  row,
  skeleton,
  parentTitle,
  descendantCount,
  selfCost,
  totalCost,
  providerCost,
  event,
  skill,
  project,
  kind,
  sessionClass,
  system,
  gusWork,
  gusWorkSfId,
  prNumber,
  prRepo,
  prState,
  epicName,
  epicUrl,
  reviewAppUrl,
  tasks,
  height,
  width,
  detailsOpen,
  peekLines,
  peekScroll,
}: PreviewProps): React.ReactElement {
  const models = modelBreakdown(row.costByModel);
  const cacheTok = row.tokCacheRead + row.tokCacheWrite;
  const cadence = formatDuration(row.tickIntervalSec);
  const burn = burnPerDay(totalCost, row.firstTs, row.lastTs);
  const peek = skeleton ? skeleton.split("\n").slice(0, 60) : [];
  // The side pane's useful task signal is what remains, not a replay of the completed plan.
  // Keep it high in the pane and bounded so it stays visible at normal terminal heights.
  const openTasks = tasks?.tasks.filter((t) => t.status !== "completed") ?? [];
  const visibleOpenTasks = openTasks.slice(0, 5);

  if (!detailsOpen) {
    const inProgress = openTasks.find((t) => t.status === "in_progress") ?? null;
    const taskSummary = tasks
      ? openTasks.length > 0
        ? `${openTasks.length} open`
        : `✓ ${tasks.completed}/${tasks.total}`
      : null;

    // Dense classification / link chips — only those present, colors + OSC-8 links preserved.
    const chips: React.ReactNode[] = [];
    if (sessionClass) chips.push(<Text key="cls" color={sessionClass === "auxiliary" ? theme.accent : theme.muted}>{sessionClass}</Text>);
    if (system) chips.push(<Text key="sys" color={theme.accent}>◇ {system}</Text>);
    if (prNumber && prRepo) chips.push(<Text key="pr" color={prState === "merged" ? theme.sourceNative : prState === "closed" ? theme.faint : theme.accent}>{osc8(`https://github.com/${prRepo}/pull/${prNumber}`, `#${prNumber}`)}{prState ? ` ${prState}` : ""}</Text>);
    if (gusWork) chips.push(<Text key="gw" color={theme.header}>{osc8(gusUrl(gusWork, gusWorkSfId), gusWork)}</Text>);
    if (epicName) chips.push(<Text key="ep" color={theme.project}>{epicUrl ? osc8(epicUrl, epicName.replace(/^\[[^\]]+\]\s*/, "")) : epicName.replace(/^\[[^\]]+\]\s*/, "")}</Text>);
    if (project) chips.push(<Text key="pj" color={theme.header}>▢ {project}</Text>);
    if (event) chips.push(<Text key="ev" color={theme.project}>⊞ {event}</Text>);
    if (reviewAppUrl) chips.push(<Text key="rv" color={theme.accent}>{osc8(reviewAppUrl, "↗ review")}</Text>);
    if (parentTitle) chips.push(<Text key="pt" color="yellow">⤴ {parentTitle}</Text>);

    // Per-provider split only when the spend is genuinely mixed; a single-provider session folds its
    // one model into the spend line instead of earning a whole row. (burn/cwd/id live in `d`.)
    const provNodes: React.ReactNode[] = [];
    const provCount = [providerCost.claude, providerCost.gpt, providerCost.other].filter((x) => x > 0).length;
    if (provCount > 1) {
      if (providerCost.claude > 0) provNodes.push(<Text key="pc" color={theme.sourceNative}>Claude {formatCost(providerCost.claude)}</Text>);
      if (providerCost.gpt > 0) provNodes.push(<Text key="pgt" color={theme.sourceCodex}>GPT {formatCost(providerCost.gpt)}</Text>);
      if (providerCost.other > 0) provNodes.push(<Text key="pot" color={theme.muted}>other {formatCost(providerCost.other)}</Text>);
    }

    // Build the header row-by-row so the peek budget is exact regardless of which fields exist.
    const H: React.ReactNode[] = [];
    H.push(
      <Text key="title" bold color={SOURCE_COLOR[row.titleSource]} wrap="truncate-end">{row.title}</Text>,
    );
    H.push(
      <Text key="sub" color={theme.muted} wrap="truncate-end">
        {row.titleSource} title · {row.msgCount} msgs · {formatBytes(row.fileSize)}
        {skill ? <Text color={theme.accent}> · ⚙ {skill}</Text> : null}
        {kind === "loop" ? <Text color={theme.accent}> · loop ◆</Text> : null}
      </Text>,
    );
    H.push(
      <Text key="repo" wrap="truncate-end">
        <Text color={theme.accent}>{row.projectName}</Text>
        <Text color={theme.muted}>  ({row.branch ?? "-"})</Text>
      </Text>,
    );
    if (chips.length) H.push(<Text key="chips" wrap="truncate-end">{withSeps(chips)}</Text>);
    H.push(
      <Text key="spend" wrap="truncate-end">
        <Text bold color={costColor(totalCost)}>{formatCost(selfCost) || "$0"} self / {formatCost(totalCost) || "$0"} total</Text>
        <Text color={theme.muted}>  ·  {formatTokens(row.tokInput)}↓ {formatTokens(row.tokOutput)}↑</Text>
        {models.length ? <Text color={models[0]!.badge.color}>{"  ·  ● "}{models[0]!.badge.label}{models.length > 1 ? ` +${models.length - 1}` : ""}</Text> : null}
        {descendantCount > 0 ? <Text color={theme.accent}>{`  ·  +${descendantCount} desc`}</Text> : null}
      </Text>,
    );
    if (provNodes.length) H.push(<Text key="prov" wrap="truncate-end">{withSeps(provNodes)}</Text>);
    H.push(
      <Text key="active" color={theme.muted} wrap="truncate-end">
        active {formatAge(row.lastTs)}
        {cadence ? ` · ~${cadence} · ${row.userTurns} ticks` : ""}
        {taskSummary ? ` · ${taskSummary}` : ""}
      </Text>,
    );
    if (inProgress) {
      H.push(
        <Text key="task" color={theme.accent} wrap="truncate-end">
          ▸ {inProgress.subject}
          {openTasks.length > 1 ? <Text color={theme.muted}>{`  +${openTasks.length - 1} open`}</Text> : null}
        </Text>,
      );
    }

    // Peek owns the remainder: border(2) + header rows + peek margin(1) + peek header(1).
    const peekBody = Math.max(3, height - (H.length + 4));
    let peekRows: PeekRow[];
    let peekHeader: string;
    if (peekLines) {
      const all = transcriptRows(peekLines);
      const maxScroll = Math.max(0, all.length - peekBody);
      const clamped = Math.min(Math.max(0, peekScroll), maxScroll);
      peekRows = all.slice(clamped, clamped + peekBody);
      peekHeader = `TRANSCRIPT · ${clamped + peekRows.length}/${all.length}${clamped >= maxScroll ? " · END" : ""}`;
    } else {
      const all = skeletonRows(skeleton);
      peekRows = all.slice(0, peekBody);
      const sepIdx = all.findIndex((r) => r.sep);
      peekHeader =
        sepIdx >= 0
          ? `PEEK · first ${sepIdx} · last ${all.length - sepIdx - 1}`
          : `PEEK · ${all.length} turn${all.length === 1 ? "" : "s"}`;
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.faint} paddingX={1} width={width} height={height} overflow="hidden">
        {H}
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color={theme.muted} wrap="truncate-end">
            {peekHeader}
            <Text color={theme.faint}>{"   J/K scroll · d full"}</Text>
          </Text>
          {peekRows.length ? (
            peekRows.map((r, i) => <PeekLine key={i} row={r} />)
          ) : (
            <Text color={theme.faint}>(no readable content)</Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.faint}
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Text bold color={SOURCE_COLOR[row.titleSource]} wrap="truncate-end">
        {row.title}
      </Text>
      <Text color={theme.muted}>
        {row.titleSource} title · {row.msgCount} msgs · {formatBytes(row.fileSize)}
      </Text>

      {tasks ? (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Box>
            <Text color={openTasks.length > 0 ? theme.accent : theme.muted} bold>
              {openTasks.length > 0 ? "OPEN TASKS" : "TASKS"}
            </Text>
            <Text color={theme.muted}>
              {openTasks.length > 0
                ? `  ${openTasks.length} remaining · ${tasks.completed}/${tasks.total} done`
                : `  ✓ ${tasks.completed}/${tasks.total} done`}
            </Text>
          </Box>
          {visibleOpenTasks.map((t) => {
            const glyph = t.status === "in_progress" ? "▸" : "·";
            const color = t.status === "in_progress" ? theme.accent : theme.title;
            return (
              <Text key={t.id || t.subject} color={color} wrap="truncate-end">
                {" "}
                {glyph} {t.subject}
                {t.status === "in_progress" && t.activeForm ? (
                  <Text color={theme.muted}>{`  ← ${t.activeForm}`}</Text>
                ) : null}
                {t.blockedBy.length > 0 ? (
                  <Text color={theme.muted}>{`  ⛓ blocked by ${t.blockedBy.length}`}</Text>
                ) : null}
              </Text>
            );
          })}
          {openTasks.length > visibleOpenTasks.length ? (
            <Text color={theme.muted}> … +{openTasks.length - visibleOpenTasks.length} more open</Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Field label="repo" value={`${row.projectName}  (${row.branch ?? "-"})`} color={theme.accent} />
        <Field label="cwd" value={row.cwd ?? "(unknown)"} />
        <Field label="started" value={fmtTs(row.firstTs)} />
        <Field label="active" value={`${fmtTs(row.lastTs)}  (${formatAge(row.lastTs)})`} />
        <Field label="version" value={row.version ?? "?"} />
        <Field label="id" value={row.sessionId} />
        {row.models.length > 0 ? <Field label="models" value={row.models.join(", ")} /> : null}
        {kind === "loop" ? <Field label="kind" value="loop ◆" color={theme.accent} /> : null}
        {sessionClass ? <Field label="class" value={sessionClass} color={sessionClass === "auxiliary" ? theme.accent : theme.title} /> : null}
        {skill ? <Field label="skill" value={`⚙ ${skill}`} color={theme.accent} /> : null}
        {system ? <Field label="cluster" value={`◇ ${system}`} color={theme.accent} /> : null}
        {prNumber && prRepo ? (
          <Field
            label="PR"
            value={osc8(`https://github.com/${prRepo}/pull/${prNumber}`, `#${prNumber}`) + `  (${prState ?? "?"})`}
            color={prState === "merged" ? theme.sourceNative : prState === "closed" ? theme.faint : theme.accent}
          />
        ) : null}
        {gusWork ? (
          <Field
            label="work"
            value={osc8(gusUrl(gusWork, gusWorkSfId), gusWork)}
            color={theme.header}
          />
        ) : null}
        {epicName ? (
          <Field
            label="epic"
            value={epicUrl ? osc8(epicUrl, epicName.replace(/^\[[^\]]+\]\s*/, "")) : epicName.replace(/^\[[^\]]+\]\s*/, "")}
            color={theme.project}
          />
        ) : null}
        {reviewAppUrl ? (
          <Field label="review" value={osc8(reviewAppUrl, "↗ open review-app")} color={theme.accent} />
        ) : null}
        {project ? <Field label="project" value={`▢ ${project}`} color={theme.header} /> : null}
        {event ? <Field label="event" value={`⊞ ${event}`} color={theme.project} /> : null}
        {parentTitle ? <Field label="parent" value={parentTitle} color="yellow" /> : null}
      </Box>

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>spend</Text>
          </Box>
          <Text bold color={costColor(totalCost)}>
            {formatCost(selfCost) || "$0"} self / {formatCost(totalCost) || "$0"} total
          </Text>
        </Box>
        {descendantCount > 0 ? (
          <Field
            label=""
            value={`${descendantCount} causal/native descendant${descendantCount === 1 ? "" : "s"} included`}
            color={theme.accent}
          />
        ) : null}
        {providerCost.claude > 0 ? <Field label="Claude" value={formatCost(providerCost.claude) || "$0"} color={theme.sourceNative} /> : null}
        {providerCost.gpt > 0 ? <Field label="GPT" value={formatCost(providerCost.gpt) || "$0"} color={theme.sourceCodex} /> : null}
        {providerCost.other > 0 ? <Field label="other" value={formatCost(providerCost.other) || "$0"} color={theme.muted} /> : null}
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>tokens</Text>
          </Box>
          <Text color={theme.title} wrap="truncate-end">
            {formatTokens(row.tokInput)} in · {formatTokens(row.tokOutput)} out
            <Text color={theme.muted}> · {formatTokens(cacheTok)} cache</Text>
          </Text>
        </Box>
        {models.slice(0, 3).map((m, i) => (
          <Box key={i}>
            <Box width={9} flexShrink={0}>
              <Text color={theme.muted}>{i === 0 ? "models" : ""}</Text>
            </Box>
            <Text color={m.badge.color}>● {m.badge.label}</Text>
            <Text color={costColor(m.usd)}> {formatCost(m.usd)}</Text>
          </Box>
        ))}
        {burn != null ? (
          <Field label="burn" value={`${formatCost(burn)}/day`} color={costColor(burn * 7)} />
        ) : null}
        {cadence ? (
          <Field label="cadence" value={`~${cadence} · ${row.userTurns} ticks`} color={theme.accent} />
        ) : null}
      </Box>

      {peek.length ? (
        <Box marginTop={1} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {peek.map((line, i) => (
            <Text key={i} color={theme.faint} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
