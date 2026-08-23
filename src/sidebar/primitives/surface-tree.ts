/**
 * Primitive 1 — the live cmux surface tree.
 *
 * Answers: which workspaces and surfaces exist right now, in display order, and which
 * workspace is focused. Fail-closed: an unreadable tree is empty and `readable: false`,
 * never an invented surface. Revision advances only on a successful read whose identity
 * payload actually changed.
 */
import { execFile } from "node:child_process";
import { parseTree, type CmuxTree, type SurfaceLocation } from "../../cmux/bridge.ts";

export interface SurfaceTreeIo {
  runTree(cmuxBin: string): Promise<string | null>;
}

export interface SurfaceTreeRead {
  readonly surfaces: readonly SurfaceLocation[];
  readonly workspaceIds: ReadonlySet<string>;
  readonly focusedWorkspaceId: string | null;
  readonly readable: boolean;
  readonly revision: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function defaultRunTree(cmuxBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmuxBin,
      ["tree", "--all", "--json", "--id-format", "both"],
      { encoding: "utf8", timeout: DEFAULT_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error === null && typeof stdout === "string" ? stdout : null);
      },
    );
  });
}

export function identityOf(surfaces: readonly SurfaceLocation[]): string {
  return surfaces
    .map(
      (s) =>
        `${s.surfaceId}\t${s.windowRef}\t${s.windowActive === true ? "1" : "0"}\t${s.workspaceId}\t${s.workspaceSelected === true ? "1" : "0"}\t${s.surfaceSelected === true ? "1" : "0"}\t${s.title ?? ""}\t${s.workspaceTitle ?? ""}`,
    )
    .join("\n");
}

export function parseSurfaceTree(raw: string): SurfaceTreeRead | null {
  let tree: unknown;
  try {
    tree = JSON.parse(raw);
  } catch {
    return null;
  }
  const surfaces = parseTree(tree as CmuxTree);
  const workspaceIds = new Set<string>();
  let focusedWorkspaceId: string | null = null;
  for (const s of surfaces) {
    workspaceIds.add(s.workspaceId);
    if (s.workspaceActive === true) focusedWorkspaceId = s.workspaceId;
  }
  return {
    surfaces,
    workspaceIds,
    focusedWorkspaceId,
    readable: true,
    revision: 0,
  };
}

export function createSurfaceTreeReader(
  io: SurfaceTreeIo = { runTree: defaultRunTree },
  cmuxBin = process.env.CMUX_BIN ?? "cmux",
): { read(): Promise<SurfaceTreeRead> } {
  let revision = 0;
  let lastIdentity: string | null = null;
  return {
    async read(): Promise<SurfaceTreeRead> {
      const raw = await io.runTree(cmuxBin);
      if (raw === null) {
        return {
          surfaces: [],
          workspaceIds: new Set(),
          focusedWorkspaceId: null,
          readable: false,
          revision,
        };
      }
      const parsed = parseSurfaceTree(raw);
      if (parsed === null) {
        return {
          surfaces: [],
          workspaceIds: new Set(),
          focusedWorkspaceId: null,
          readable: false,
          revision,
        };
      }
      const identity = identityOf(parsed.surfaces);
      if (identity !== lastIdentity) {
        revision += 1;
        lastIdentity = identity;
      }
      return { ...parsed, revision };
    },
  };
}
