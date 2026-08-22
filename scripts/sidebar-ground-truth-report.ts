/**
 * Turn raw sweep findings into a report a human can act on.
 *
 * One section per primitive: what it claims to track, how reality was measured, and what
 * drifted. Ends with the manual spot-checks a person can run where they themselves are the
 * oracle — the checks no script can perform.
 */
import type { Finding } from "./sidebar-ground-truth-lib.ts";

interface PrimitiveSpec {
  readonly name: string;
  readonly tracks: string;
  readonly measured: string;
}

const PRIMITIVES: readonly PrimitiveSpec[] = [
  {
    name: "surface-tree",
    tracks: "which cmux workspaces and surfaces exist right now",
    measured: "a fresh `cmux tree --all --json` taken seconds before every other read",
  },
  {
    name: "hook-bindings",
    tracks: "which claude session is bound to which surface, and whether it is alive",
    measured:
      "the hook store file diffed against the fresh tree (stale bindings), `ps` for claimed pids (ghost running), and the filesystem for claimed transcripts",
  },
  {
    name: "agent-activity",
    tracks: "whether each agent is running or waiting for you",
    measured:
      "the free hook-store lifecycle signal against cmux's own authoritative status pill for every live surface",
  },
  {
    name: "transcript-facts",
    tracks: "message counts, byte sizes, and last-activity times from the session index",
    measured:
      "`stat()` on the actual transcript files plus real line counts — the index must trail an append-only file, never lead it",
  },
  {
    name: "coverage",
    tracks: "whether recent transcripts made it into the index at all",
    measured:
      "every store file touched in the last 24h checked against the index's id set, with a 10-minute grace window for the reindex timer",
  },
  {
    name: "catalogue-identity",
    tracks: "the durable registry of sessions and their titles/lifecycles",
    measured: "every catalogue row checked for a transcript still existing on disk",
  },
  {
    name: "directory-facts",
    tracks: "the project directory behind each row",
    measured: "`existsSync()` on each distinct cwd of the newest rows",
  },
];

function findingsFor(findings: readonly Finding[], primitive: string): Finding[] {
  return findings.filter((f) => f.primitive === primitive);
}

function verdictFor(spec: PrimitiveSpec, found: readonly Finding[]): string {
  const errors = found.filter((f) => f.severity === "error");
  const warns = found.filter((f) => f.severity === "warn");
  if (errors.length === 0 && warns.length === 0) {
    return "**MATCHES REALITY**";
  }
  const parts = [
    errors.length > 0 ? `${errors.length} drift${errors.length === 1 ? "" : "s"}` : null,
    warns.length > 0 ? `${warns.length} warning${warns.length === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p !== null);
  return `**DRIFTED — ${parts.join(", ")}**`;
}

export interface ReportFacts {
  readonly surfaces: number;
  readonly hookBindings: number;
  readonly hookSessionsKnown: number;
  readonly indexRowsSampled: number;
}

export function renderHumanReport(
  facts: ReportFacts,
  findings: readonly Finding[],
): string {
  const lines: string[] = [];
  lines.push("# Sidebar ground truth — verdict per primitive\n");
  lines.push(
    `Live state this run: ${facts.surfaces} surfaces, ${facts.hookBindings} hook-store bindings, ` +
      `${facts.hookSessionsKnown} known sessions, ${facts.indexRowsSampled} indexed rows sampled.\n`,
  );

  for (const spec of PRIMITIVES) {
    const found = findingsFor(findings, spec.name);
    lines.push(`## ${spec.name} — ${verdictFor(spec, found)}\n`);
    lines.push(`- **Tracks:** ${spec.tracks}`);
    lines.push(`- **Reality check:** ${spec.measured}`);
    const actionable = [...found.filter((f) => f.severity !== "info")];
    if (actionable.length === 0) {
      lines.push("- **Result:** clean. Nothing to do.\n");
      continue;
    }
    lines.push("- **What drifted:**");
    for (const f of actionable.slice(0, 10)) {
      lines.push(`  - [${f.severity}] ${f.detail}`);
    }
    if (actionable.length > 10) {
      lines.push(`  - …and ${actionable.length - 10} more (see the JSON evidence file)\n`);
    } else {
      lines.push("");
    }
  }

  lines.push("## Spot-checks only you can run\n");
  lines.push("The scripts prove the sources agree with each other and with disk. Three things ");
  lines.push("only a human at the keyboard can verify:\n");
  lines.push("1. **Tab count.** Count your open cmux tabs/windows by eye. The sweep says this " +
    `run saw ${facts.surfaces}. Off by more than one you just opened/closed mid-run means ` +
    "the surface-tree tracking is wrong.");
  lines.push("2. **The waiting flip.** Send any agent a task that ends needing your input. Its " +
    "sidebar pill should flip to *needs input* within ~3 seconds. Run this sweep right after; " +
    "agent-activity should show agreement, not a lagging derived label.");
  lines.push("3. **Click-through.** Pick any live row in the sidebar and click it. The tab that " +
    "gains focus must contain that exact session — not a twin, not a dead pane. This is the " +
    "one check that validates identity resolution end to end, because only you know which " +
    "session you meant.");
  lines.push("\nIf all three feel right but the sidebar still reads stale to you, the drift is " +
    "in delivery/redraw (classes C/D), not in the tracked state — say so and we chase the " +
    "revision pipeline instead of the data.");
  return lines.join("\n");
}
