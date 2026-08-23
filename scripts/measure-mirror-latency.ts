/**
 * Automated focus-latency harness: `t_focus_command → t_mirror_flip`.
 *
 * Drive: pick a live workspace different from the focused one, issue `cmux workspace focus`,
 *       watch `/api/events` (SSE) for the mirror's `workspaceFocused` flip.
 * Metric: per-trial ms plus mean / p50 / p95 / budget pass-fail.
 *
 * No video. One clock. Repeatable.
 *
 * Usage:
 *   bun run scripts/measure-mirror-latency.ts [--trials 50] [--port 8793] [--budget-p95 500] [--out path.json]
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function intArg(flag:string, fallback:number):number{const i=process.argv.indexOf(flag);return i>=0?Number(process.argv[i+1]):fallback;}
const PORT = Number(process.env.GT_PORT ?? String(intArg("--port", 8793)));
const TRIALS = intArg("--trials", 30);
const BUDGET_P95 = intArg("--budget-p95", 500);
const OUT = (()=>{const i=process.argv.indexOf("--out");return i>=0?process.argv[i+1]??null:null;})();
const SETTLE_MS = 600;
const TIMEOUT_MS = 8_000;

function execCmux(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cmux", [...args], { timeout: 4_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function fetchState(): Promise<{
  mirror: { live: Array<{ workspaceRef: string; workspaceFocused: boolean }> };
  cycles: number;
  lastEventAt: number;
}> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
  if (!r.ok) throw new Error(`state fetch ${r.status}`);
  return r.json() as Promise<ReturnType<typeof fetchState> extends Promise<infer T> ? T : never>;
}

async function measureOneTrial(target: string): Promise<{ ms: number; ok: boolean; reason?: string }> {
  const t0 = performance.now();
  await execCmux(["workspace", "select", target]);
  const deadline = t0 + TIMEOUT_MS;
  while (performance.now() < deadline) {
    const d = await fetchState();
    const focused = d.mirror.live.find((r) => r.workspaceFocused)?.workspaceRef ?? null;
    if (focused === target) return { ms: performance.now() - t0, ok: true };
    await Bun.sleep(20);
  }
  const d = await fetchState();
  const focused = d.mirror.live.find((r) => r.workspaceFocused)?.workspaceRef ?? null;
  return { ms: TIMEOUT_MS, ok: false, reason: `timeout: focused=${focused ?? "none"}, wanted ${target}` };
}

async function main(): Promise<void> {
  // Probe that the server is up.
  await fetchState();

  const initial = await fetchState();
  const refs = initial.mirror.live.map((r) => r.workspaceRef);
  if (refs.length < 2) throw new Error(`need ≥2 live workspaces, have ${refs.length}`);

  const results: Array<{ trial: number; target: string; ms: number; ok: boolean; reason?: string }> = [];
  for (let i = 0; i < TRIALS; i++) {
    const cur = (await fetchState()).mirror.live.find((r) => r.workspaceFocused)?.workspaceRef ?? refs[0]!;
    // Rotate to a different target each trial.
    const candidates = refs.filter((r) => r !== cur);
    const target = candidates[i % candidates.length]!;
    const r = await measureOneTrial(target);
    results.push({ trial: i + 1, target, ...r });
    const tag = r.ok ? `${Math.round(r.ms)}ms` : `TIMEOUT (${r.reason ?? ""})`;
    process.stdout.write(`trial ${i + 1}/${TRIALS} → ${target}  ${tag}\n`);
    await Bun.sleep(SETTLE_MS);
  }

  const oks = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const p50 = oks.length ? oks[Math.floor(oks.length * 0.5)]! : null;
  const p95 = oks.length ? oks[Math.ceil(oks.length * 0.95) - 1]! : null;
  const mean = oks.length ? oks.reduce((a, b) => a + b, 0) / oks.length : null;
  const passed = p95 !== null && p95 <= BUDGET_P95;

  const summary = {
    port: PORT,
    trials: TRIALS,
    budgetP95Ms: BUDGET_P95,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    meanMs: mean !== null ? Math.round(mean) : null,
    p50Ms: p50 !== null ? Math.round(p50) : null,
    p95Ms: p95 !== null ? Math.round(p95) : null,
    passed,
    results,
  };

  process.stdout.write(`\nmean ${summary.meanMs}ms  p50 ${summary.p50Ms}ms  p95 ${summary.p95Ms}ms  ` +
    `budget p95 ≤${BUDGET_P95}ms  ${passed ? "PASS" : "FAIL"}\n`);

  if (OUT) {
    mkdirSync(join(OUT, "..").replace(/\/[^/]+$/, "") || ".", { recursive: true });
    const path = OUT.includes("/") ? OUT : join("docs/evidence/sidebar-ground-truth", OUT);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`wrote ${path}\n`);
  } else {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const path = join(import.meta.dir, "..", "docs/evidence/sidebar-ground-truth", `latency-${stamp}.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`wrote ${path}\n`);
  }

  if (!passed) process.exitCode = 1;
}

await main();
