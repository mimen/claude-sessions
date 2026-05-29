import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openIndex } from "../index/schema.ts";
import { listByRecency } from "../index/index.ts";
import { backfillTitles } from "./queue.ts";
import type { Titler } from "./codex.ts";

let counter = 0;
function tmpDb(): Database {
  return openIndex(`:memory:`);
}

interface SeedRow {
  id: string;
  native?: string | null;
  codex?: string | null;
  msgCount?: number;
  titleMsgCount?: number | null;
  attempts?: number;
  skeleton?: string;
}

function seed(db: Database, rows: SeedRow[]): void {
  for (const r of rows) {
    db.query(
      `INSERT INTO sessions (
        session_id, host, path, cwd, project_root, project_name,
        fallback_label, native_title, codex_title, msg_count, title_msg_count,
        title_attempts, file_mtime, file_size, skeleton
      ) VALUES ($id,'h','/p','/c','/c','c','fallback',$native,$codex,$mc,$tmc,$att,1,1,$skel)`,
    ).run({
      $id: r.id,
      $native: r.native ?? null,
      $codex: r.codex ?? null,
      $mc: r.msgCount ?? 5,
      $tmc: r.titleMsgCount ?? null,
      $att: r.attempts ?? 0,
      $skel: r.skeleton ?? "user: hello\nassistant: hi",
    });
  }
}

/** Titler that always succeeds, recording max concurrent in-flight calls. */
function trackingTitler(): { titler: Titler; maxInFlight: number } {
  const state = { maxInFlight: 0, inFlight: 0 };
  const titler: Titler = {
    async generate() {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight--;
      return `Title ${++counter}`;
    },
  };
  return { titler, get maxInFlight() { return state.maxInFlight; } };
}

test("titles only sessions without a native title", async () => {
  const db = tmpDb();
  seed(db, [
    { id: "has-native", native: "Native One" },
    { id: "needs-codex" },
  ]);
  const { titler } = trackingTitler();

  const stats = await backfillTitles(db, titler, { concurrency: 2, maxAttempts: 3 });
  expect(stats.generated).toBe(1); // only needs-codex

  const rows = listByRecency(db);
  const native = rows.find((r) => r.sessionId === "has-native")!;
  const codex = rows.find((r) => r.sessionId === "needs-codex")!;
  expect(native.title).toBe("Native One");
  expect(native.titleSource).toBe("native");
  expect(codex.titleSource).toBe("codex");
  expect(codex.title.startsWith("Title ")).toBe(true);
});

test("respects the concurrency cap", async () => {
  const db = tmpDb();
  seed(db, Array.from({ length: 10 }, (_, i) => ({ id: `s${i}` })));
  const tracker = trackingTitler();

  await backfillTitles(db, tracker.titler, { concurrency: 3, maxAttempts: 3 });
  expect(tracker.maxInFlight).toBeLessThanOrEqual(3);
  expect(tracker.maxInFlight).toBeGreaterThan(1);
});

test("failures increment attempts and stop at the cap", async () => {
  const db = tmpDb();
  seed(db, [{ id: "flaky", attempts: 0 }]);
  const failing: Titler = { async generate() { return null; } };

  await backfillTitles(db, failing, { concurrency: 1, maxAttempts: 3 });
  let attempts = (db.query("SELECT title_attempts a FROM sessions WHERE session_id='flaky'").get() as { a: number }).a;
  expect(attempts).toBe(1);

  // Two more runs reach the cap; a fourth run skips it entirely.
  await backfillTitles(db, failing, { concurrency: 1, maxAttempts: 3 });
  await backfillTitles(db, failing, { concurrency: 1, maxAttempts: 3 });
  attempts = (db.query("SELECT title_attempts a FROM sessions WHERE session_id='flaky'").get() as { a: number }).a;
  expect(attempts).toBe(3);

  const stats = await backfillTitles(db, failing, { concurrency: 1, maxAttempts: 3 });
  expect(stats.failed).toBe(0); // capped → not attempted again
});

test("re-titles a stale session that grew past 1.5x", async () => {
  const db = tmpDb();
  seed(db, [
    { id: "fresh", codex: "Old", msgCount: 10, titleMsgCount: 10 },
    { id: "stale", codex: "Old", msgCount: 20, titleMsgCount: 10 },
  ]);
  const { titler } = trackingTitler();

  const stats = await backfillTitles(db, titler, { concurrency: 2, maxAttempts: 3 });
  expect(stats.generated).toBe(1); // only the stale one
});
