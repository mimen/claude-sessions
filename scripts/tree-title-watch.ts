// Watch cmux tree title fields once per second; log every change with a timestamp.
// bun run scripts/tree-title-watch.ts [seconds]
import { execFileSync } from "node:child_process";

const seconds = Number(process.argv[2] ?? 120);
interface Snap {
  surfaces: Map<string, { st: string | null; wt: string | null }>;
}
function snap(): Snap {
  const raw = execFileSync("cmux", ["tree", "--all", "--json", "--id-format", "both"], {
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const t = JSON.parse(raw);
  const surfaces = new Map<string, { st: string | null; wt: string | null }>();
  for (const w of t.windows ?? []) {
    for (const ws of w.workspaces ?? []) {
      for (const p of ws.panes ?? []) {
        for (const s of p.surfaces ?? []) {
          if (!s.id) continue;
          surfaces.set(s.id, { st: s.title ?? null, wt: ws.title ?? null });
        }
      }
    }
  }
  return { surfaces };
}

const t0 = Date.now();
let prev = snap();
process.stdout.write(`watching ${prev.surfaces.size} surfaces for ${seconds}s — rename something now\n`);
while ((Date.now() - t0) / 1000 < seconds) {
  Bun.sleepSync(1_000);
  let next: Snap;
  try {
    next = snap();
  } catch {
    continue;
  }
  for (const [id, cur] of next.surfaces) {
    const before = prev.surfaces.get(id);
    if (!before) {
      process.stdout.write(`[+${Math.round((Date.now() - t0) / 1000)}s] NEW surface ${id.slice(0, 8)} tab=${JSON.stringify(cur.st)} ws=${JSON.stringify(cur.wt)}\n`);
      continue;
    }
    if (before.st !== cur.st) {
      process.stdout.write(`[+${Math.round((Date.now() - t0) / 1000)}s] TAB-TITLE ${id.slice(0, 8)}: ${JSON.stringify(before.st)} -> ${JSON.stringify(cur.st)}\n`);
    }
    if (before.wt !== cur.wt) {
      process.stdout.write(`[+${Math.round((Date.now() - t0) / 1000)}s] WS-TITLE  ${id.slice(0, 8)}: ${JSON.stringify(before.wt)} -> ${JSON.stringify(cur.wt)}\n`);
    }
  }
  prev = next;
}
process.stdout.write("done\n");
