import React from "react";
import { Box, Text } from "ink";
import type { SkillRow } from "../../skills/view.ts";
import { theme } from "../theme.ts";
import { formatAge } from "../../store.ts";

export interface UsedByEntry {
  project: string;
  count: number;
}

export interface FileEntry {
  /** Path relative to the skill dir, e.g. "references/api.md". */
  rel: string;
  sizeBytes: number;
}

interface SkillsPreviewProps {
  row: SkillRow;
  /** Same-name copies elsewhere on disk (path + whether its hash differs from this one). */
  siblings: Array<{ path: string; differs: boolean }>;
  usedBy: UsedByEntry[];
  files: FileEntry[];
  height: number;
}

const label = (t: string): React.ReactElement => (
  <Text color={theme.headerLabel} bold>
    {t}
  </Text>
);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** Right-hand metadata card for the selected skill. */
export function SkillsPreview({ row, siblings, usedBy, files, height }: SkillsPreviewProps): React.ReactElement {
  const u = row.usage;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.headerBorder} paddingX={1} height={height} overflow="hidden">
      <Text bold color={theme.title}>
        {row.rec.name}
        {row.drift ? <Text color="yellow"> ≠ drifted copies</Text> : null}
      </Text>
      <Text color={theme.muted} wrap="wrap">
        {row.rec.description || "(no description)"}
      </Text>
      <Text> </Text>
      <Text>
        {label("home ")}
        <Text color={theme.project}>{row.home}</Text>
        {"  "}
        {label("eco ")}
        <Text color={theme.muted}>{row.rec.ecosystem}</Text>
      </Text>
      <Text color={theme.faint} wrap="truncate-middle">
        {row.rec.path}
      </Text>
      {siblings.slice(0, 3).map((s) => (
        <Text key={s.path} color={s.differs ? "yellow" : theme.faint} wrap="truncate-middle">
          {s.differs ? "≠ " : "= "}
          {s.path}
        </Text>
      ))}
      {siblings.length > 3 ? <Text color={theme.faint}>… {siblings.length - 3} more copies</Text> : null}
      <Text> </Text>
      <Text>
        {label("category ")}
        <Text color={theme.branch}>{row.category ?? "—"}</Text>
        {row.tags.length > 0 ? (
          <>
            {"  "}
            {label("tags ")}
            <Text color={theme.accent}>{row.tags.join(", ")}</Text>
          </>
        ) : null}
      </Text>
      <Text>
        {label("usage ")}
        {u ? (
          <Text color={theme.muted}>
            {u.invocations} invoked · {u.commands} slash · {u.reads} reads · last {formatAge(u.lastUsed)}
          </Text>
        ) : (
          <Text color={theme.costNil}>never observed on this machine</Text>
        )}
      </Text>
      {usedBy.length > 0 ? (
        <Text wrap="truncate-end">
          {label("used by ")}
          <Text color={theme.muted}>{usedBy.map((p) => `${p.project} ×${p.count}`).join(" · ")}</Text>
        </Text>
      ) : null}
      <Text> </Text>
      {label("files")}
      {files.slice(0, 6).map((f) => (
        <Text key={f.rel} color={f.rel === "SKILL.md" ? theme.title : theme.muted} wrap="truncate-end">
          {"  "}
          {f.rel} <Text color={theme.faint}>{fmtSize(f.sizeBytes)}</Text>
        </Text>
      ))}
      {files.length > 6 ? <Text color={theme.faint}>  … {files.length - 6} more files</Text> : null}
    </Box>
  );
}
