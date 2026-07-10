/**
 * The ccs state API (ADR-0025/0031): durable state at two scopes, on the store (store.ts) and
 * the runtime paths (identity-path.ts).
 *
 *  - CLUSTER-scoped: shared operational state (board, gate, dispositions…) — one set per
 *    cluster, under ~/.ccs/clusters/<c>/cluster/<name>.json.
 *  - IDENTITY-scoped: an identity's own state (result, judgment…) keyed by responsibility,
 *    under its identity dir (alongside its inbox).
 *
 * This is what pr-watch's private ~/.claude/pr-watch-2/ dir dissolves into (Phase 6c).
 */
import { join } from "node:path";
import {
  clusterStateDir,
  identityDir,
  type Responsibility,
} from "../inbox/identity-path.ts";
import { readDoc, writeDoc, mergeFields, type StateDoc, type WriteOpts } from "./store.ts";

const SAFE = /[^a-zA-Z0-9_.-]+/g;
const docFile = (name: string) => `${name.replace(SAFE, "-")}.json`;

// --- cluster-scoped -------------------------------------------------------------

export function writeClusterDoc<T>(
  root: string,
  cluster: string,
  name: string,
  data: T,
  opts: WriteOpts,
): void {
  writeDoc(join(clusterStateDir(root, cluster), docFile(name)), data, opts);
}

export function readClusterDoc<T = unknown>(
  root: string,
  cluster: string,
  name: string,
): StateDoc<T> | null {
  return readDoc<T>(join(clusterStateDir(root, cluster), docFile(name)));
}

export function mergeClusterDoc(
  root: string,
  cluster: string,
  name: string,
  fields: Record<string, unknown>,
  opts: WriteOpts,
): void {
  mergeFields(join(clusterStateDir(root, cluster), docFile(name)), fields, opts);
}

// --- identity-scoped ------------------------------------------------------------

export function writeIdentityDoc<T>(
  root: string,
  r: Responsibility,
  name: string,
  data: T,
  opts: WriteOpts,
): void {
  writeDoc(join(identityDir(root, r), docFile(name)), data, opts);
}

export function readIdentityDoc<T = unknown>(
  root: string,
  r: Responsibility,
  name: string,
): StateDoc<T> | null {
  return readDoc<T>(join(identityDir(root, r), docFile(name)));
}

export function mergeIdentityDoc(
  root: string,
  r: Responsibility,
  name: string,
  fields: Record<string, unknown>,
  opts: WriteOpts,
): void {
  mergeFields(join(identityDir(root, r), docFile(name)), fields, opts);
}
