/** A cmux sidebar pill the tool paints as-is. Vocabulary is cluster-defined. */
export interface Pill {
  key: string;
  label: string;
  icon?: string;
  color?: string;
  priority?: number;
}

/** A named sensor-backed alert. Tool renders (as a badge, pill, or list); doesn't interpret. */
export interface Alert {
  name: string;
  severity: "hard" | "soft";
  reason: string;
  owner: string;
  sinceTick?: number;
}

/** A session's presence on this identity (for the composed row's session list). */
export interface RowSession {
  sessionId: string;
  isPrimary: boolean;
  lastActivity: string;
}

/** The composed row for one identity. Written by the cluster's composer, read by ccs consumers. */
export interface BoardRow {
  identity: string;
  workUnit: { kind: string; [k: string]: unknown };
  sessions: RowSession[];
  pills: Pill[];
  description: string | null;
  alerts: Alert[];
  awaitingFrom: string[];
  lastComposed: string;
  data?: Record<string, unknown>;
}

/** The whole board.json file. */
export interface Board {
  status: "OK" | "DEGRADED" | "FAILED";
  provenance: { source: string; command?: string; at: string };
  rows: BoardRow[];
  senses?: Record<string, { status: string; lastRun?: string }>;
  counts?: Record<string, number>;
  clusterData?: Record<string, unknown>;
}
