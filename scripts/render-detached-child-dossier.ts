#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  projectHistoricalDetachedChildDossier,
  type HistoricalDetachedChildDossier,
  type HistoricalDetachedChildDossierFinding,
  type HistoricalDetachedChildDossierNode,
  type HistoricalDetachedChildSessionContext,
  type HistoricalDetachedChildSessionReference,
} from "../src/cleanup/historical-detached-child-dossier.ts";
import type { HistoricalDetachedChildManifest } from "../src/cleanup/historical-detached-child-classifier.ts";
import { CATALOGUE_PATH, DB_PATH } from "../src/paths.ts";

interface ReportSource {
  readonly since?: string;
  readonly indexPath?: string;
  readonly missingTranscriptPaths?: readonly string[];
}

interface ReportWithSource extends HistoricalDetachedChildManifest {
  readonly source?: ReportSource;
}

interface RendererArgs {
  readonly inputPath: string;
  readonly indexPath: string;
  readonly cataloguePath: string;
  readonly outputPath: string;
}

interface IndexContextRow {
  readonly session_id: string;
  readonly resume_id: string;
  readonly title: string;
  readonly project_name: string | null;
  readonly branch: string | null;
  readonly cwd: string | null;
  readonly last_ts: string | null;
  readonly cost_usd: number | null;
}

interface CatalogueContextRow {
  readonly session_id: string;
  readonly resume_id: string | null;
  readonly custom_title: string | null;
  readonly parent_session_id: string | null;
  readonly session_class: "work_body" | "auxiliary" | null;
  readonly completed: number;
  readonly archived: number;
  readonly parked_task_id: string | null;
}

interface TagContextRow {
  readonly session_id: string;
  readonly entity: string;
}

interface MutableContext {
  sessionId: string;
  aliases: Set<string>;
  title: string | null;
  project: string | null;
  branch: string | null;
  cwd: string | null;
  lastActivityAt: string | null;
  selfCostUSD: number | null;
  sessionClass: "work_body" | "auxiliary" | null;
  causalParentSessionId: string | null;
  lifecycle: "idle" | "parked" | "completed" | "archived" | null;
  tags: Set<string>;
}

function parseArgs(args: readonly string[]): RendererArgs {
  const defaults = {
    inputPath: resolve("docs/reports/detached-children-2026-07-12-onward.json"),
    indexPath: DB_PATH(),
    cataloguePath: CATALOGUE_PATH(),
    outputPath: resolve("docs/reports/detached-children-2026-07-12-onward.html"),
  };
  const knownFlags = new Set(["--input", "--index", "--catalogue", "--output"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    if (equals > 0) {
      const flag = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      if (!knownFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
      if (value.length === 0) throw new Error(`${flag} requires a path`);
      values.set(flag, value);
      continue;
    }
    if (knownFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    inputPath: resolve(values.get("--input") ?? defaults.inputPath),
    indexPath: resolve(values.get("--index") ?? defaults.indexPath),
    cataloguePath: resolve(values.get("--catalogue") ?? defaults.cataloguePath),
    outputPath: resolve(values.get("--output") ?? defaults.outputPath),
  };
}

function readManifest(path: string): { readonly manifest: ReportWithSource; readonly sourceHash: string } {
  const source = readFileSync(path, "utf8");
  const parsed = JSON.parse(source) as ReportWithSource;
  if (parsed.version !== 1 || parsed.mode !== "report_only" || !Array.isArray(parsed.findings)) {
    throw new Error(`Expected a version: 1 report_only detached-child manifest at ${path}`);
  }
  return { manifest: parsed, sourceHash: createHash("sha256").update(source).digest("hex") };
}

function idsFromManifest(manifest: HistoricalDetachedChildManifest): readonly string[] {
  const ids = new Set<string>();
  for (const finding of manifest.findings) {
    if (finding.parentSessionId !== null) ids.add(finding.parentSessionId);
    for (const id of finding.candidateSessionIds) ids.add(id);
  }
  return [...ids].sort();
}

function bindList(ids: readonly string[], prefix: string): { readonly names: string; readonly parameters: Readonly<Record<string, string>> } {
  const parameters: Record<string, string> = {};
  const names = ids.map((id, index) => {
    const name = `$${prefix}${index}`;
    parameters[name] = id;
    return name;
  }).join(", ");
  return { names, parameters };
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const output: T[][] = [];
  for (let start = 0; start < items.length; start += size) output.push(items.slice(start, start + size));
  return output;
}

function readonlyDatabase(path: string): Database {
  return new Database(path, { readonly: true });
}

function initialContext(sessionId: string): MutableContext {
  return {
    sessionId,
    aliases: new Set([sessionId]),
    title: null,
    project: null,
    branch: null,
    cwd: null,
    lastActivityAt: null,
    selfCostUSD: null,
    sessionClass: null,
    causalParentSessionId: null,
    lifecycle: null,
    tags: new Set(),
  };
}

function lifecycleFor(row: CatalogueContextRow): "idle" | "parked" | "completed" | "archived" {
  if (row.archived !== 0) return "archived";
  if (row.completed !== 0) return "completed";
  if (row.parked_task_id !== null) return "parked";
  return "idle";
}

/** Reads only stable storage projections. Failures are promoted to dossier warnings. */
function loadSessionContexts(
  ids: readonly string[],
  indexPath: string,
  cataloguePath: string,
): { readonly contexts: ReadonlyMap<string, HistoricalDetachedChildSessionContext>; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const mutableById = new Map<string, MutableContext>();
  const aliasToCanonical = new Map<string, string>();
  const ensure = (id: string): MutableContext => {
    const canonical = aliasToCanonical.get(id) ?? id;
    const current = mutableById.get(canonical);
    if (current !== undefined) return current;
    const context = initialContext(canonical);
    mutableById.set(canonical, context);
    aliasToCanonical.set(canonical, canonical);
    return context;
  };
  const linkAlias = (canonicalId: string, alias: string): void => {
    const context = ensure(canonicalId);
    context.aliases.add(alias);
    aliasToCanonical.set(alias, context.sessionId);
  };

  if (existsSync(indexPath)) {
    let index: Database | null = null;
    try {
      index = readonlyDatabase(indexPath);
      for (const chunk of chunks(ids, 350)) {
        const bind = bindList(chunk, "index");
        const rows = index.query(
          `SELECT session_id, resume_id,
             COALESCE(native_title, codex_title, fallback_label) AS title,
             project_name, branch, cwd, last_ts, cost_usd
           FROM sessions
           WHERE session_id IN (${bind.names}) OR resume_id IN (${bind.names})`,
        ).all(bind.parameters) as IndexContextRow[];
        for (const row of rows) {
          const context = ensure(row.session_id);
          linkAlias(context.sessionId, row.session_id);
          if (row.resume_id.length > 0) linkAlias(context.sessionId, row.resume_id);
          context.title ??= row.title;
          context.project ??= row.project_name;
          context.branch ??= row.branch;
          context.cwd ??= row.cwd;
          context.lastActivityAt ??= row.last_ts;
          context.selfCostUSD ??= row.cost_usd;
        }
      }
    } catch (error) {
      warnings.push(`Index context unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      index?.close();
    }
  } else {
    warnings.push(`Index context database is missing: ${indexPath}`);
  }

  if (existsSync(cataloguePath)) {
    let catalogue: Database | null = null;
    try {
      catalogue = readonlyDatabase(cataloguePath);
      const catalogueRows: CatalogueContextRow[] = [];
      for (const chunk of chunks(ids, 350)) {
        const bind = bindList(chunk, "catalogue");
        const rows = catalogue.query(
          `SELECT session_id, resume_id, custom_title, parent_session_id, session_class,
             completed, archived, parked_task_id
           FROM catalogue
           WHERE session_id IN (${bind.names}) OR resume_id IN (${bind.names})`,
        ).all(bind.parameters) as CatalogueContextRow[];
        catalogueRows.push(...rows);
        for (const row of rows) {
          const context = ensure(row.session_id);
          linkAlias(context.sessionId, row.session_id);
          if (row.resume_id !== null) linkAlias(context.sessionId, row.resume_id);
          context.title = row.custom_title ?? context.title;
          context.sessionClass = row.session_class;
          context.causalParentSessionId = row.parent_session_id;
          context.lifecycle = lifecycleFor(row);
        }
      }
      for (const chunk of chunks(catalogueRows.map((row) => row.session_id).sort(), 350)) {
        if (chunk.length === 0) continue;
        const bind = bindList(chunk, "tag");
        const tags = catalogue.query(
          `SELECT session_id, entity FROM session_tags WHERE session_id IN (${bind.names})`,
        ).all(bind.parameters) as TagContextRow[];
        for (const tag of tags) ensure(tag.session_id).tags.add(tag.entity);
      }
    } catch (error) {
      warnings.push(`Catalogue context unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      catalogue?.close();
    }
  } else {
    warnings.push(`Catalogue context database is missing: ${cataloguePath}`);
  }

  const contexts = new Map<string, HistoricalDetachedChildSessionContext>();
  for (const context of mutableById.values()) {
    contexts.set(context.sessionId, {
      sessionId: context.sessionId,
      aliases: [...context.aliases].sort(),
      title: context.title,
      project: context.project,
      branch: context.branch,
      cwd: context.cwd,
      lastActivityAt: context.lastActivityAt,
      selfCostUSD: context.selfCostUSD,
      sessionClass: context.sessionClass,
      causalParentSessionId: context.causalParentSessionId,
      lifecycle: context.lifecycle,
      tags: [...context.tags].sort(),
    });
  }
  return { contexts, warnings };
}

function errorMessage(error: Error | string | number | boolean | null | undefined): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapedData(value: string): string {
  return escapeHtml(value).replaceAll("\n", " ");
}

function stableAnchor(id: string): string {
  return `parent-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function displayName(reference: HistoricalDetachedChildSessionReference): string {
  return reference.context?.title ?? shortId(reference.canonicalId);
}

function displayProject(reference: HistoricalDetachedChildSessionReference): string {
  const context = reference.context;
  if (context === null) return "context unavailable";
  return [context.project, context.branch].filter((value): value is string => value !== null && value.length > 0).join(" · ") || "no project label";
}

function formatCost(cost: number | null): string {
  return cost === null ? "cost unavailable" : `$${cost.toFixed(2)} self`;
}

function differenceMs(launch: string | null, candidate: string | null): string {
  if (launch === null || candidate === null) return "time unavailable";
  const delta = Date.parse(candidate) - Date.parse(launch);
  if (!Number.isFinite(delta)) return "time unavailable";
  const seconds = (delta / 1000).toFixed(1);
  return `${delta >= 0 ? "+" : ""}${seconds}s`;
}

function contextLine(reference: HistoricalDetachedChildSessionReference): string {
  const context = reference.context;
  if (context === null) return `<span class="missing">Missing index/catalogue context</span>`;
  const state = context.sessionClass ?? "unclassified";
  const lifecycle = context.lifecycle ?? "unknown lifecycle";
  const tags = context.tags.length === 0 ? "no tags" : context.tags.join(", ");
  return `<span>${escapeHtml(state)} · ${escapeHtml(lifecycle)} · ${escapeHtml(formatCost(context.selfCostUSD))} · ${escapeHtml(tags)}</span>`;
}

function evidenceHtml(finding: HistoricalDetachedChildDossierFinding): string {
  const evidence = finding.evidence;
  const dimensions = evidence.matchedDimensions.length === 0 ? "none" : evidence.matchedDimensions.join(" · ");
  return `<details class="evidence">
    <summary>Exact evidence</summary>
    <dl class="evidence-grid">
      <div><dt>Prompt SHA-256</dt><dd class="mono">${escapeHtml(evidence.promptHash)}</dd></div>
      <div><dt>Parent transcript</dt><dd class="mono">${escapeHtml(evidence.parentTranscriptPath)}:${evidence.parentLine}</dd></div>
      <div><dt>Launch → candidate</dt><dd>${escapeHtml(evidence.launchTimestamp)} → ${escapeHtml(evidence.candidateTimestamp)} <span class="muted">(${escapeHtml(differenceMs(evidence.launchTimestamp, evidence.candidateTimestamp))})</span></dd></div>
      <div><dt>Candidate transcript</dt><dd class="mono">${escapeHtml(evidence.candidateTranscriptPath)}</dd></div>
      <div><dt>Strict dimensions</dt><dd>${escapeHtml(dimensions)}</dd></div>
    </dl>
  </details>`;
}

function edgeKey(parentId: string, childId: string): string {
  return `${parentId}\u0000${childId}`;
}

function proposalCardHtml(
  finding: HistoricalDetachedChildDossierFinding,
  depth: number,
  includeAnchor: boolean,
): string {
  const child = finding.candidates[0];
  if (child === undefined || finding.proposal === null) return "";
  const search = [displayName(child), displayProject(child), child.rawId, child.canonicalId, finding.evidence.promptHash, finding.reason ?? ""].join(" ");
  const anchor = includeAnchor ? ` id="${stableAnchor(child.canonicalId)}"` : "";
  return `<article${anchor} class="proposal-card" data-item data-status="exact_proposed" data-missing="${child.missingContext ? "yes" : "no"}" data-search="${escapedData(search)}" style="--depth:${depth}">
    <div class="proposal-topline"><span class="eyebrow">Exact proposal</span><span class="tag exact">strict match</span></div>
    <div class="proposal-title"><span class="arrow">↳</span><strong>${escapeHtml(displayName(child))}</strong><span class="mono id">${escapeHtml(shortId(child.canonicalId))}</span></div>
    <p class="proposal-destination"><b>Destination:</b> <code>session_class=auxiliary</code> under causal parent <a href="#${stableAnchor(finding.proposal.causalParent.canonicalId)}"><code>${escapeHtml(shortId(finding.proposal.causalParent.canonicalId))}</code></a>.</p>
    <p class="meta-line">${escapeHtml(displayProject(child))} · ${contextLine(child)} · historical tags: ${finding.proposal.tags.map((tag) => `<code>${escapeHtml(tag)}</code>`).join(" ")}</p>
    ${evidenceHtml(finding)}
  </article>`;
}

function renderTree(
  nodeId: string,
  nodeById: ReadonlyMap<string, HistoricalDetachedChildDossierNode>,
  findingByEdge: ReadonlyMap<string, HistoricalDetachedChildDossierFinding>,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  const node = nodeById.get(nodeId);
  if (node === undefined) return "";
  const loop = seen.has(nodeId);
  if (loop) return `<p class="cycle-note">Cycle stops here at <code>${escapeHtml(shortId(nodeId))}</code>; the graph remains report-only.</p>`;
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const children = node.childIds.map((childId) => {
    const finding = findingByEdge.get(edgeKey(nodeId, childId));
    const childTree = renderTree(childId, nodeById, findingByEdge, nextSeen, depth + 1);
    return `${finding === undefined ? "" : proposalCardHtml(finding, depth + 1, !nextSeen.has(childId))}${childTree}`;
  }).join("");
  if (children.length === 0) return "";
  return `<div class="tree-children">${children}</div>`;
}

function treeSearchText(
  nodeId: string,
  nodeById: ReadonlyMap<string, HistoricalDetachedChildDossierNode>,
  findingByEdge: ReadonlyMap<string, HistoricalDetachedChildDossierFinding>,
  seen: ReadonlySet<string> = new Set(),
): string {
  if (seen.has(nodeId)) return "";
  const node = nodeById.get(nodeId);
  if (node === undefined) return "";
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  return node.childIds.flatMap((childId) => {
    const finding = findingByEdge.get(edgeKey(nodeId, childId));
    const child = finding?.candidates[0];
    const own = finding === undefined || child === undefined
      ? []
      : [displayName(child), displayProject(child), child.rawId, child.canonicalId, finding.evidence.promptHash, finding.reason ?? ""];
    return [...own, treeSearchText(childId, nodeById, findingByEdge, nextSeen)];
  }).join(" ");
}

function fanoutRailWidth(count: number): number {
  const normalized = Math.min(1, Math.log2(count + 1) / Math.log2(28));
  return Math.round(3 + normalized * 11);
}

function parentGroupHtml(
  node: HistoricalDetachedChildDossierNode,
  nodeById: ReadonlyMap<string, HistoricalDetachedChildDossierNode>,
  findingByEdge: ReadonlyMap<string, HistoricalDetachedChildDossierFinding>,
  open: boolean,
): string {
  const reference = node.reference;
  const search = [
    displayName(reference), displayProject(reference), reference.rawId, reference.canonicalId,
    treeSearchText(node.id, nodeById, findingByEdge),
  ].join(" ");
  const width = fanoutRailWidth(node.directProposedChildCount);
  return `<details id="${stableAnchor(node.id)}" class="parent-group" data-item data-status="exact_proposed" data-direct="${node.directProposedChildCount}" data-exceptions="${node.withheldFindingCount > 0 ? "yes" : "no"}" data-missing="${reference.missingContext ? "yes" : "no"}" data-search="${escapedData(search)}" ${open ? "open" : ""} style="--spawn:${width}px">
    <summary>
      <span class="parent-kicker">Spawner</span>
      <span class="parent-title">${escapeHtml(displayName(reference))}</span>
      <span class="mono id">${escapeHtml(shortId(node.id))}</span>
      <span class="parent-metrics"><b>${node.directProposedChildCount}</b> direct · <b>${node.descendantProposalCount}</b> below · ${node.withheldFindingCount} withheld</span>
    </summary>
    <div class="parent-body">
      <p class="meta-line">${escapeHtml(displayProject(reference))} · ${contextLine(reference)}</p>
      ${renderTree(node.id, nodeById, findingByEdge, new Set(), 0)}
    </div>
  </details>`;
}

function withheldFindingHtml(finding: HistoricalDetachedChildDossierFinding): string {
  const parent = finding.parent;
  const search = [parent === null ? "parent unavailable" : displayName(parent), parent?.canonicalId ?? "", finding.reason ?? "", finding.evidence.promptHash].join(" ");
  const candidates = finding.candidates.length === 0 ? "none" : finding.candidates.map((candidate) => `<code>${escapeHtml(shortId(candidate.canonicalId))}</code>`).join(" ");
  return `<article class="withheld-card" data-item data-status="withheld ${escapeHtml(finding.category)}" data-missing="${parent?.missingContext === true ? "yes" : "no"}" data-search="${escapedData(search)}">
    <div><span class="tag withheld">${escapeHtml(finding.category.replaceAll("_", " "))}</span><span class="muted">${escapeHtml(finding.status)}</span></div>
    <p><b>No assignment proposed.</b> ${escapeHtml(finding.reason ?? "strict matcher withheld this finding")}</p>
    <p class="meta-line">Parent: ${parent === null ? "unavailable" : `${escapeHtml(displayName(parent))} · <code>${escapeHtml(shortId(parent.canonicalId))}</code>`} · candidates: ${candidates} · prompt hash: <code>${escapeHtml(finding.evidence.promptHash)}</code></p>
    ${evidenceHtml(finding)}
  </article>`;
}

function withheldSearchText(
  parentId: string,
  label: string,
  findings: readonly HistoricalDetachedChildDossierFinding[],
): string {
  return [
    label,
    parentId,
    ...findings.flatMap((finding) => [
      finding.reason ?? "",
      finding.evidence.promptHash,
      finding.parent?.rawId ?? "",
      finding.parent?.canonicalId ?? "",
      ...finding.candidates.flatMap((candidate) => [candidate.rawId, candidate.canonicalId]),
    ]),
  ].join(" ");
}

function disconnectedGroupNodes(
  dossier: HistoricalDetachedChildDossier,
  nodeById: ReadonlyMap<string, HistoricalDetachedChildDossierNode>,
): readonly HistoricalDetachedChildDossierNode[] {
  const remaining = new Set(dossier.proposalGraph.disconnectedNodeIds);
  const neighbours = new Map<string, Set<string>>();
  for (const edge of dossier.proposalGraph.edges) {
    addNeighbour(neighbours, edge.parentId, edge.childId);
    addNeighbour(neighbours, edge.childId, edge.parentId);
  }
  const representatives: HistoricalDetachedChildDossierNode[] = [];
  for (const start of [...remaining].sort()) {
    if (!remaining.has(start)) continue;
    const component = new Set<string>();
    const visit = (id: string): void => {
      if (!remaining.delete(id)) return;
      component.add(id);
      for (const adjacent of neighbours.get(id) ?? []) visit(adjacent);
    };
    visit(start);
    const representative = [...component]
      .map((id) => nodeById.get(id))
      .filter((node): node is HistoricalDetachedChildDossierNode => node !== undefined && node.directProposedChildCount > 0)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (representative !== undefined) representatives.push(representative);
  }
  return representatives.sort((left, right) => left.id.localeCompare(right.id));
}

function addNeighbour(neighbours: Map<string, Set<string>>, from: string, to: string): void {
  const values = neighbours.get(from) ?? new Set<string>();
  values.add(to);
  neighbours.set(from, values);
}

function renderDossier(
  dossier: HistoricalDetachedChildDossier,
  source: ReportSource | undefined,
  sourceHash: string,
  warnings: readonly string[],
): string {
  const nodeById = new Map(dossier.proposalGraph.nodes.map((node) => [node.id, node]));
  const findingByEdge = new Map<string, HistoricalDetachedChildDossierFinding>();
  for (const finding of dossier.findings) {
    if (finding.proposal === null || finding.candidates[0] === undefined) continue;
    findingByEdge.set(edgeKey(finding.proposal.causalParent.canonicalId, finding.candidates[0].canonicalId), finding);
  }
  const ledgerIds = [...new Set([...dossier.proposalGraph.denseParents, ...dossier.proposalGraph.roots])]
    .sort((left, right) => {
      const leftNode = nodeById.get(left);
      const rightNode = nodeById.get(right);
      if (leftNode === undefined || rightNode === undefined) return left.localeCompare(right);
      return rightNode.directProposedChildCount - leftNode.directProposedChildCount
        || rightNode.totalFindingCount - leftNode.totalFindingCount
        || left.localeCompare(right);
    });
  const rootGroups = dossier.proposalGraph.roots.map((id) => nodeById.get(id)).filter((node): node is HistoricalDetachedChildDossierNode => node !== undefined);
  const disconnectedGroups = disconnectedGroupNodes(dossier, nodeById);
  const withheldByParent = new Map<string, HistoricalDetachedChildDossierFinding[]>();
  for (const finding of dossier.findings.filter((finding) => finding.proposal === null)) {
    const parentId = finding.parent?.canonicalId ?? "parent-unavailable";
    const list = withheldByParent.get(parentId) ?? [];
    list.push(finding);
    withheldByParent.set(parentId, list);
  }
  const withheldGroups = [...withheldByParent.entries()].sort(([left], [right]) => left.localeCompare(right));
  const categoryCounts = dossier.categories.map((group) => `<li><span class="legend-dot ${group.category}"></span>${escapeHtml(group.category.replaceAll("_", " "))}<b>${group.findings.length}</b></li>`).join("");
  const reportWarnings = [...warnings, ...dossier.warnings, ...(source?.missingTranscriptPaths?.length ? [`${source.missingTranscriptPaths.length} stale transcript path${source.missingTranscriptPaths.length === 1 ? "" : "s"} recorded in source manifest.`] : [])];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Detached-child proposal dossier · report only</title>
<style>
:root{--canvas:#e7eaee;--paper:#fbfcfd;--ink:#192233;--muted:#637082;--hair:#cad1da;--rail:#3c607f;--signal:#cc5a42;--signal-pale:#f7dfd8;--hold:#7d5d25;--hold-pale:#f8efd9;--missing:#a13d5d;--code:#edf1f5;--shadow:0 8px 24px rgba(35,51,70,.09)}
*{box-sizing:border-box}html{max-width:100%;overflow-x:hidden;scroll-behavior:smooth}body{margin:0;overflow-x:hidden;background:linear-gradient(90deg,rgba(60,96,127,.05) 1px,transparent 1px) 0 0/22px 22px,var(--canvas);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--rail);text-underline-offset:2px}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}code{background:var(--code);border:1px solid var(--hair);border-radius:3px;padding:1px 4px}.layout{max-width:1540px;margin:0 auto;display:grid;grid-template-columns:280px minmax(0,1fr)}aside{position:sticky;top:0;height:100vh;overflow:auto;padding:28px 20px;border-right:1px solid var(--hair);background:rgba(251,252,253,.82);backdrop-filter:blur(10px)}main{min-width:0;padding:42px clamp(20px,4vw,62px) 88px}.brand{font:700 13px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--rail)}aside h2{font-size:15px;margin:29px 0 8px}.nav-link{display:block;padding:5px 8px;color:var(--muted);text-decoration:none;border-left:2px solid transparent}.nav-link:hover{color:var(--ink);border-color:var(--signal)}.sidebar-note{font-size:12px;color:var(--muted);margin:8px 0}.kicker,.eyebrow,.parent-kicker{font:700 10px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--rail)}h1{font-size:clamp(32px,5vw,64px);letter-spacing:-.055em;line-height:.95;margin:10px 0 16px;max-width:12ch}h2{font-size:22px;letter-spacing:-.025em;margin:52px 0 13px}h3{font-size:16px;margin:0}.lede{max-width:72ch;color:var(--muted);font-size:17px}.report-only{display:flex;gap:10px;align-items:center;padding:12px 15px;border:1px solid var(--signal);background:var(--signal-pale);font-weight:650}.report-only::before{content:"READ ONLY";font:700 10px/1 ui-monospace,monospace;letter-spacing:.1em;color:var(--signal)}.stamp{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0 0}.stamp span{max-width:100%;min-width:0;overflow-wrap:anywhere;border:1px solid var(--hair);background:var(--paper);padding:4px 7px;font-size:12px;color:var(--muted)}.numbers{display:grid;grid-template-columns:repeat(4,minmax(125px,1fr));gap:1px;background:var(--hair);border:1px solid var(--hair);margin:32px 0;box-shadow:var(--shadow)}.number{background:var(--paper);padding:19px 18px}.number b{display:block;font-size:30px;letter-spacing:-.05em}.number span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.callout{border-left:4px solid var(--rail);background:var(--paper);padding:13px 16px;margin:18px 0;box-shadow:var(--shadow)}.warning{border-left-color:var(--hold);background:var(--hold-pale)}.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:1px;list-style:none;padding:0;margin:14px 0;background:var(--hair);border:1px solid var(--hair)}.legend li{background:var(--paper);padding:9px 11px;text-transform:capitalize;font-size:12px;display:flex;align-items:center;gap:7px}.legend b{margin-left:auto}.legend-dot{width:8px;height:8px;border-radius:50%;background:var(--hold)}.legend-dot.exact_proposed{background:var(--signal)}.legend-dot.provider_mismatch{background:#b06d2f}.legend-dot.prompt_mismatch{background:#8f5379}.legend-dot.model_mismatch{background:#6a67a5}.legend-dot.duplicate_claim{background:#697382}.legend-dot.ambiguous{background:#8b7d44}.legend-dot.timestamp_or_cwd_mismatch{background:#497a7b}.filters{position:sticky;top:0;z-index:3;display:grid;grid-template-columns:1fr auto auto auto auto;gap:8px;padding:12px;border:1px solid var(--hair);background:rgba(251,252,253,.94);backdrop-filter:blur(10px);box-shadow:var(--shadow)}.filters input,.filters select,.filter-button{min-width:0;border:1px solid var(--hair);background:var(--paper);color:var(--ink);padding:8px 10px;font:inherit}.filter-button{cursor:pointer}.filter-button[aria-pressed="true"]{border-color:var(--rail);box-shadow:inset 0 -3px var(--rail)}#filter-summary{grid-column:1/-1;color:var(--muted);font-size:12px}.table-wrap{width:100%;max-width:100%;overflow-x:auto}.ledger{width:100%;border-collapse:collapse;background:var(--paper);box-shadow:var(--shadow)}.ledger th,.ledger td{padding:9px 11px;border:1px solid var(--hair);text-align:left;vertical-align:top}.ledger th{font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);background:#f0f3f6}.ledger td.number-cell{text-align:right;font-variant-numeric:tabular-nums}.queue-label{font:700 10px/1 ui-monospace,monospace;letter-spacing:.1em;color:var(--signal);margin-right:7px}.parent-group{position:relative;margin:13px 0;background:var(--paper);border:1px solid var(--hair);box-shadow:var(--shadow)}.parent-group::before{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--spawn);background:var(--rail)}.parent-group>summary{list-style:none;cursor:pointer;padding:15px 16px 15px 27px;display:grid;grid-template-columns:auto minmax(180px,1fr) auto auto;gap:10px;align-items:baseline}.parent-group>summary::-webkit-details-marker{display:none}.parent-group>summary::after{content:"+";grid-column:1;grid-row:1;font-weight:800;color:var(--rail);transform:translateX(-15px)}.parent-group[open]>summary::after{content:"–"}.parent-title{font-weight:750}.id{color:var(--muted)}.parent-metrics{font-size:12px;color:var(--muted);white-space:nowrap}.parent-body{padding:0 16px 16px 27px;border-top:1px solid var(--hair)}.meta-line{font-size:12px;color:var(--muted);margin:8px 0}.missing{color:var(--missing);font-weight:650}.tree-children{border-left:1px solid var(--hair);padding-left:14px;margin:10px 0 0}.proposal-card,.withheld-card{margin:10px 0;background:#fff;border:1px solid var(--hair);padding:12px 13px}.proposal-card{border-left:3px solid var(--signal)}.proposal-topline{display:flex;justify-content:space-between;gap:8px}.proposal-title{margin:5px 0}.arrow{color:var(--signal);font-weight:800;margin-right:7px}.tag{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:2px 6px;font:700 10px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase}.tag.exact{color:var(--signal)}.tag.withheld{color:var(--hold)}.proposal-destination{margin:7px 0}.evidence{margin-top:9px;border-top:1px dashed var(--hair);padding-top:7px}.evidence summary{cursor:pointer;font-size:12px;color:var(--rail);font-weight:650}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin:8px 0 0}.evidence-grid div{min-width:0}.evidence-grid dt{font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.evidence-grid dd{margin:3px 0;overflow-wrap:anywhere;font-size:12px}.withheld-group{margin:12px 0;background:var(--paper);border:1px solid var(--hair)}.withheld-group>summary{cursor:pointer;padding:12px 14px;font-weight:700}.withheld-body{padding:0 13px 13px}.cycle-note{color:var(--hold);font-size:12px}.muted{color:var(--muted)}footer{margin-top:65px;padding-top:18px;border-top:1px solid var(--hair);color:var(--muted);font-size:13px}@media(max-width:1000px){.layout{display:block}aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--hair);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding:15px 20px}aside h2,.sidebar-note{display:none}.nav-link{display:inline-block}.numbers{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){main{padding:28px 14px 50px}.filters{grid-template-columns:1fr 1fr}.filters input{grid-column:1/-1}.parent-group>summary{grid-template-columns:1fr auto;gap:5px;padding-left:25px}.parent-kicker{grid-column:1/-1}.parent-metrics{grid-column:1/-1;white-space:normal}.ledger{font-size:12px}.ledger th:nth-child(4),.ledger td:nth-child(4){display:none}.evidence-grid{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<div class="layout">
<aside aria-label="Dossier navigation"><div class="brand">ccs / trace atlas</div><p class="sidebar-note">A parent-first reading of the report-only historical matcher.</p><a class="nav-link" href="#overview">Overview</a><a class="nav-link" href="#concentration">Concentration ledger</a><a class="nav-link" href="#forest">Causal forest</a><a class="nav-link" href="#withheld">Withheld findings</a><a class="nav-link" href="#method">Method and limits</a></aside>
<main>
<section id="overview"><p class="kicker">Historical detached-child classification · July 12 onward</p><h1>Trace the spawners, not 1,480 rows.</h1><p class="lede">This dossier reorders the existing strict-match manifest around the sessions that generated the work. It is evidence for review only: it cannot apply metadata, archive a session, or alter the classifier.</p><div class="report-only">No catalogue metadata is written. No session is archived. No proposal is applied from this page.</div><div class="stamp"><span>manifest SHA-256 ${escapeHtml(sourceHash)}</span><span>scope ${escapeHtml(source?.since ?? "recorded in manifest")}</span><span>source report_only v1</span></div><div class="numbers"><div class="number"><b>${dossier.totals.findingCount}</b><span>findings</span></div><div class="number"><b>${dossier.totals.proposalCount}</b><span>exact proposals</span></div><div class="number"><b>${dossier.totals.withheldCount}</b><span>withheld</span></div><div class="number"><b>${dossier.totals.rootCount}</b><span>causal roots</span></div></div>${reportWarnings.map((warning) => `<div class="callout warning">${escapeHtml(warning)}</div>`).join("")}<ul class="legend" aria-label="Finding status legend">${categoryCounts}</ul></section>
<section aria-label="Review filters"><h2>Review lens</h2><div class="filters"><input id="query" type="search" placeholder="Search title, project, ID, hash, or reason" aria-label="Search dossier"><select id="status" aria-label="Filter finding status"><option value="all">All findings</option><option value="exact_proposed">Exact proposals</option><option value="withheld">Withheld only</option></select><select id="minimum" aria-label="Minimum direct child count"><option value="0">Any child count</option><option value="4">4+ direct children</option><option value="6">6+ direct children</option><option value="10">10+ direct children</option></select><button type="button" class="filter-button" id="exceptions" aria-pressed="false">Has exceptions</button><button type="button" class="filter-button" id="missing" aria-pressed="false">Missing context</button><button type="button" class="filter-button" id="evidence" aria-pressed="false">Expand evidence</button><p id="filter-summary" aria-live="polite">Showing all review groups.</p></div></section>
<section id="concentration"><h2>Concentration ledger</h2><p class="lede">Dense spawners (four or more direct exact proposals) lead. Roots are included even when they are sparse, so the review starts where the causal chains begin.</p><div class="table-wrap"><table class="ledger"><thead><tr><th>Spawner</th><th>Project / branch</th><th>Direct</th><th>Below</th><th>Findings</th><th>Withheld</th></tr></thead><tbody>${ledgerIds.map((id) => { const node = nodeById.get(id); if (node === undefined) return ""; const kind = dossier.proposalGraph.denseParents.includes(id) ? "dense queue" : "root"; return `<tr><td><span class="queue-label">${kind}</span><a href="#${stableAnchor(id)}">${escapeHtml(displayName(node.reference))}</a><br><span class="mono muted">${escapeHtml(shortId(id))}</span></td><td>${escapeHtml(displayProject(node.reference))}</td><td class="number-cell">${node.directProposedChildCount}</td><td class="number-cell">${node.descendantProposalCount}</td><td class="number-cell">${node.totalFindingCount}</td><td class="number-cell">${node.withheldFindingCount}</td></tr>`; }).join("")}</tbody></table></div></section>
<section id="forest"><h2>Causal forest</h2><p class="lede">Every exact proposal is shown beneath the parent that launched it. The copper rail measures immediate fan-out; evidence retains the strict dimensions that satisfied the matcher.</p>${rootGroups.map((node) => parentGroupHtml(node, nodeById, findingByEdge, node.directProposedChildCount >= 4)).join("")}${disconnectedGroups.length > 0 ? `<h3>Disconnected or cyclic groups</h3>${disconnectedGroups.map((node) => parentGroupHtml(node, nodeById, findingByEdge, false)).join("")}` : ""}</section>
<section id="withheld"><h2>Withheld findings</h2><p class="lede">These observations remain deliberately separate. They explain why the report does <em>not</em> propose a causal assignment: a mismatch, a duplicate claim, or ambiguity is not evidence to backfill.</p>${withheldGroups.map(([parentId, findings]) => { const first = findings[0]; if (first === undefined) return ""; const label = first.parent === null ? "Parent unavailable" : `${displayName(first.parent)} · ${shortId(parentId)}`; return `<details class="withheld-group" data-item data-status="withheld" data-direct="0" data-exceptions="yes" data-missing="${first.parent?.missingContext === true ? "yes" : "no"}" data-search="${escapedData(withheldSearchText(parentId, label, findings))}"><summary>${escapeHtml(label)} <span class="muted">· ${findings.length} withheld</span></summary><div class="withheld-body">${findings.map(withheldFindingHtml).join("")}</div></details>`; }).join("")}</section>
<section id="method"><h2>Method and limits</h2><div class="callout"><b>Strict matching remains unchanged.</b> Exact proposals require one-to-one prompt, cwd, entrypoint, provider/model, and narrow timestamp evidence. Index and catalogue labels above are navigation convenience only; they do not make an inference stronger.</div><ul><li>Raw prompts are intentionally absent. Prompt SHA-256 values remain as reproducible evidence.</li><li>Provider/model mismatches, prompt mismatches, duplicate claims, ambiguity, and timestamp/CWD mismatches remain withheld.</li><li>This artifact reads context through read-only SQLite handles and writes only this HTML file.</li><li>Any application or archive decision requires a separately reviewed operation; this page exposes no control for one.</li></ul></section>
<footer>Generated from the deterministic report-only manifest. Open the JSON audit for source records; regenerate this dossier after regenerating the manifest.</footer>
</main></div>
<script>
(() => {
  const query = document.getElementById('query'); const status = document.getElementById('status'); const minimum = document.getElementById('minimum'); const exceptions = document.getElementById('exceptions'); const missing = document.getElementById('missing'); const evidence = document.getElementById('evidence'); const summary = document.getElementById('filter-summary');
  const groups = Array.from(document.querySelectorAll('.parent-group, .withheld-group'));
  const toggle = (button) => button.addEventListener('click', () => { button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') !== 'true' ? 'true' : 'false'); apply(); });
  const apply = () => { const term = query.value.trim().toLowerCase(); const wanted = status.value; const min = Number(minimum.value); const needExceptions = exceptions.getAttribute('aria-pressed') === 'true'; const needMissing = missing.getAttribute('aria-pressed') === 'true'; let visible = 0; for (const group of groups) { const text = ((group.dataset.search || '') + ' ' + group.innerText).toLowerCase(); const statusMatch = wanted === 'all' || (wanted === 'withheld' ? (group.dataset.status || '').includes('withheld') : (group.dataset.status || '').includes(wanted)); const directMatch = Number(group.dataset.direct || '0') >= min; const exceptionMatch = !needExceptions || group.dataset.exceptions === 'yes' || (group.dataset.status || '').includes('withheld'); const missingMatch = !needMissing || group.dataset.missing === 'yes'; const show = statusMatch && directMatch && exceptionMatch && missingMatch && (!term || text.includes(term)); group.hidden = !show; if (show) visible += 1; } summary.textContent = 'Showing ' + visible + ' review group' + (visible === 1 ? '' : 's') + ' under the active lens.'; };
  query.addEventListener('input', apply); status.addEventListener('change', apply); minimum.addEventListener('change', apply); toggle(exceptions); toggle(missing); evidence.addEventListener('click', () => { const expanded = evidence.getAttribute('aria-pressed') !== 'true'; evidence.setAttribute('aria-pressed', expanded ? 'true' : 'false'); document.querySelectorAll('.evidence').forEach((detail) => { detail.open = expanded; }); });
})();
</script>
</body></html>`;
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { manifest, sourceHash } = readManifest(args.inputPath);
    const context = loadSessionContexts(idsFromManifest(manifest), args.indexPath, args.cataloguePath);
    const dossier = projectHistoricalDetachedChildDossier(manifest, context.contexts);
    const html = renderDossier(dossier, manifest.source, sourceHash, context.warnings);
    writeFileSync(args.outputPath, html, "utf8");
    console.log(`Wrote report-only dossier: ${args.outputPath}`);
    return 0;
  } catch (error) {
    console.error(`ccs detached-child dossier: ${errorMessage(error instanceof Error ? error : String(error))}`);
    return 1;
  }
}

process.exit(await main());
