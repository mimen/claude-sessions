import { createInterface } from "node:readline";
import { openIndex } from "../index/schema.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { mark } from "../catalogue/commands.ts";
import { DB_PATH, CATALOGUE_PATH } from "../paths.ts";
import { triageQueue, nextActions, type TriageItem } from "./triage.ts";
import { readSweepHealth, sweepWarning } from "./health.ts";

/**
 * `ccs triage` — work the gap between what sessions ARE and what they are filed as.
 * `ccs next`   — what you are mid-flight on, and the one action each would start with.
 *
 * Both are readers. `next` writes nothing at all; `triage` writes only in response to a keypress,
 * one session at a time. That restraint is deliberate and was chosen over auto-applying the
 * verdict: the conjunction "model says complete AND the branch is gone" is usually right, and a
 * model verdict driving an unattended lifecycle write is still not a line this design crosses.
 */

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const warn = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;

/** "2d", "3w" — enough to judge staleness, short enough to sit in a row. */
function ago(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 90) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function projectOf(cwd: string | null): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "—";
}

/** Print the sweep-liveness banner when the runner is behind. Silent when it is healthy. */
function printHealth(): void {
  const message = sweepWarning(readSweepHealth());
  if (message) console.log(`${warn("⚠")} ${message}\n`);
}

export async function triageCommand(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const listOnly = args.includes("--list") || asJson;

  const index = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    const queue = triageQueue(index, catalogue);
    const now = new Date();

    if (asJson) {
      const health = readSweepHealth();
      console.log(JSON.stringify({ health, junk: queue.junk, items: queue.items }, null, 2));
      return 0;
    }

    printHealth();
    if (queue.junk.length === 0 && queue.items.length === 0) {
      console.log("Nothing to triage — every enriched session is filed the way it reads.");
      return 0;
    }

    if (listOnly) {
      if (queue.junk.length > 0) {
        console.log(bold(`junk · ${queue.junk.length} probes and throwaways`));
        for (const item of queue.junk.slice(0, 5)) {
          console.log(`  ${dim(item.sessionId.slice(0, 8))}  ${item.title}  ${dim(`${item.messages} msg`)}`);
        }
        if (queue.junk.length > 5) console.log(dim(`  … ${queue.junk.length - 5} more`));
        console.log("");
      }
      for (const item of queue.items) {
        console.log(
          `${dim(item.sessionId.slice(0, 8))}  ${item.lifecycle} → ${bold(item.target)}  ${item.title}` +
          `  ${dim(`${ago(item.lastTs, now)} · ${projectOf(item.cwd)}`)}`,
        );
      }
      console.log(dim(`\n${queue.items.length} to review · ${queue.junk.length} junk`));
      return 0;
    }

    // The queue is fully materialised before any keypress, so `mark` opening its own
    // connection per apply cannot interleave with an in-flight read of this one.
    return await interactive(queue.junk, queue.items, now);
  } finally {
    index.close();
    catalogue.close();
  }
}

/**
 * Apply one verdict through `ccs mark`, not through the raw setters.
 *
 * ADR-0068 makes `commands.ts` the single mutation door, and the reason bites here: `mark` also
 * mirrors lifecycle onto the session's identity (ADR-0089). Calling `setCompleted` directly would
 * have closed the session out in the catalogue while leaving every identity reader still seeing it
 * as live — a queue that half-applies its own verdicts is worse than no queue.
 */
function apply(item: TriageItem): void {
  mark(item.sessionId, ["--completed"]);
}

async function interactive(
  junk: readonly TriageItem[],
  items: readonly TriageItem[],
  now: Date,
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim().toLowerCase())));

  let applied = 0;
  let skipped = 0;
  try {
    // The junk lane first, and collapsed. 28 archives should cost one keystroke, not 28 — and
    // clearing it first means the reviewed queue below contains only real sessions.
    if (junk.length > 0) {
      console.log(bold(`junk · ${junk.length} probes and throwaways`));
      for (const item of junk.slice(0, 3)) {
        console.log(`  ${item.title}  ${dim(`${item.messages} msg`)}`);
      }
      if (junk.length > 3) console.log(dim(`  … ${junk.length - 3} more`));
      const answer = await ask("\n  [D] mark all Done  [s] skip  > ");
      if (answer === "d") {
        for (const item of junk) apply(item);
        applied += junk.length;
        console.log(green(`  marked ${junk.length} Done\n`));
      } else {
        skipped += junk.length;
        console.log(dim("  skipped\n"));
      }
    }

    for (const [i, item] of items.entries()) {
      console.log(
        `${dim(`${i + 1}/${items.length}`)}   ${dim(item.sessionId.slice(0, 8))} · ` +
        `${item.lifecycle} → ${bold(item.target)}`,
      );
      console.log(bold(item.title));
      if (item.state) console.log(item.state);
      if (item.reason) console.log(dim(item.reason));
      console.log(dim(`${ago(item.lastTs, now)} · ${projectOf(item.cwd)} · ${item.messages} msg`));

      const answer = await ask("  [d] Done  [s] skip  [q] quit  > ");
      if (answer === "q") break;
      if (answer === "d") {
        apply(item);
        applied++;
        console.log(green("  Done\n"));
      } else {
        skipped++;
        console.log(dim("  skipped\n"));
      }
    }
  } finally {
    rl.close();
  }
  console.log(dim(`── applied ${applied} · skipped ${skipped}`));
  return 0;
}

export function nextCommand(args: string[]): number {
  const asJson = args.includes("--json");
  const index = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    const items = nextActions(index, catalogue);
    if (asJson) {
      console.log(JSON.stringify(items, null, 2));
      return 0;
    }
    printHealth();
    if (items.length === 0) {
      console.log("Nothing mid-flight.");
      return 0;
    }
    const now = new Date();
    for (const item of items) {
      console.log(`${dim(item.sessionId.slice(0, 8))}  ${bold(item.title)}`);
      console.log(`          ${item.next}`);
      if (item.remaining) console.log(dim(`          ${item.remaining}`));
      console.log(dim(`          ${ago(item.lastTs, now)} · ${projectOf(item.cwd)}`));
    }
    console.log(dim(`\n${items.length} mid-flight · ccs triage to close others out`));
    return 0;
  } finally {
    index.close();
    catalogue.close();
  }
}
