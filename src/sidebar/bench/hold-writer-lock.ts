import { Database } from "bun:sqlite";

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? "5500");
if (!dbPath || !Number.isFinite(holdMs) || holdMs < 0) {
  throw new Error("usage: hold-writer-lock.ts <database> <milliseconds>");
}

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
process.stdout.write("ready\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, holdMs);
db.exec("ROLLBACK;");
db.close();
