/**
 * Terminal drawing for `ccs usage`. Every decision about sections, labels, plans, and order
 * comes from packages/usage-view, which the menu bar and the hub also draw. This file only
 * turns that view into aligned text.
 */

import type { UsageSnapshot } from "./types.ts";
import { formatCost } from "../cost.ts";
import { buildView, renewalLabel, type Row } from "../../packages/usage-view/index.ts";

/**
 * An eight-segment usage bar, e.g. `███████░`. Filled segments scale with use.
 */
export function bar(usedPct: number | null, width = 8): string {
  if (usedPct === null) return "─".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** ANSI colors keyed to how full a window is — green under 70, amber under 90, red past that. */
function colorFor(pct: number | null, s: string): string {
  if (!process.stdout.isTTY || pct === null) return s;
  const c = pct >= 90 ? "\x1b[31m" : pct >= 70 ? "\x1b[33m" : "\x1b[32m";
  return `${c}${s}\x1b[0m`;
}

/** "in 4h 12m"-style countdown from now; empty string when absent. */
export function countdown(at: number | null): string {
  if (at === null) return "";
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return `in ${h}h ${rem}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "Aug 25 13:59" style short timestamp; falls back to the raw ISO when unparseable. */
export function shortReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const WINDOW_NAME: Record<string, string> = { "5h": "five-hour", day: "daily", wk: "weekly", mo: "monthly" };

/** The allowance name within its group: the window for the main pool, else the scope name. */
function rowName(r: Row): string {
  if (r.kind !== "allowance") return r.kind === "reset" ? "banked reset" : r.label;
  if ((r.label === "All models" || r.label === "All usage") && r.window) return WINDOW_NAME[r.window] ?? r.window;
  return r.label;
}

function rowText(r: Row, name: string): string {
  switch (r.kind) {
    case "allowance": {
      if (r.fractionUsed === null) return `${name}— unknown`;
      const pct = Math.round(r.fractionUsed * 100);
      const segments = r.segments.map(s => `${s.name} ${Math.round((s.fractionUsed ?? 0) * 100)}%`).join(" · ");
      const notes = [countdown(r.resetsAt), r.stale ? "cached" : "", segments].filter(Boolean).join(" · ");
      return `${colorFor(pct, name + bar(pct))} ${String(pct).padStart(3)}%  ${notes}`.trimEnd();
    }
    case "reset":
      return `${name}${r.available ? "available" : "consumed"}${r.expiresAt ? ` · expires ${shortReset(new Date(r.expiresAt).toISOString())}` : ""}`;
    case "credit": {
      const amount = r.unit === "USD" ? (r.balance === 0 ? "none" : `${formatCost(r.balance)} remaining`) : `${r.balance} credits remaining`;
      return `${name}${amount}`;
    }
  }
}

export function renderSnapshot(snap: UsageSnapshot): string {
  const view = buildView(snap);
  const names = view.sections.flatMap(s => s.rows.map(rowName));
  const pad = Math.min(Math.max(6, ...names.map(n => n.length)), 18);
  const lines: string[] = [];

  for (const s of view.sections) {
    lines.push(s.account ? `${s.title} · ${s.account}` : s.title);
    if (s.plan) lines.push(`  ${s.plan.name} · ${s.renewsOn ? `renews ${renewalLabel(s.renewsOn)}` : "renewal unknown"}`);
    for (const r of s.rows) lines.push(`  ${rowText(r, `${rowName(r).padEnd(pad)} `)}`);
    lines.push("");
  }

  // Adapter failures close the view, after the data, where they read as footnotes.
  if (view.notes.length) lines.push("unavailable", ...view.notes.map(n => `  ${n}`), "");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
