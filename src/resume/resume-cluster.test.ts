import { test, expect } from "bun:test";
import { openIndex } from "../index/schema.ts";
import { openCatalogue, setSystem, setRole, setResumeCommand, setResumeId } from "../catalogue/db.ts";
import { resumeClusterEntry } from "./resume-cluster.ts";

const NOW = "2026-07-09T00:00:00Z";

/** Seed a minimal indexed session row (only the columns resume needs). */
function seedIndex(db: ReturnType<typeof openIndex>, id: string, cwd: string) {
  db.query(
    `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
       fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
     VALUES ($id, 'h', $path, $cwd, $cwd, 'p', $id, $now, $now, 1, 0, 0, 0, $id)`,
  ).run({ $id: id, $path: `/store/${id}.jsonl`, $cwd: cwd, $now: NOW });
}

test("resume-cluster fans out over members; dry-run resumes the closed ones", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    // two cluster members, both closed (empty live bridge in dry-run env → nothing open)
    for (const id of ["ctrl", "worker"]) {
      seedIndex(idx, id, "/tmp");
      setResumeId(cat, id, id, NOW);
      setSystem(cat, id, "pr-watch", NOW);
    }
    setRole(cat, "ctrl", "control", NOW);
    setResumeCommand(cat, "ctrl", "/loop 15m /pr-watch-control", NOW);
    setRole(cat, "worker", "pr-agent", NOW);

    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true });
    expect(summary.perSession.length).toBe(2);
    // in a test env cmux isn't running, so the bridge is empty → both are "closed" → resumed
    expect(summary.resumed).toBe(2);
    expect(summary.alreadyOpen).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});

test("a member that isn't indexed is counted, not fatal", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    setResumeId(cat, "ghost", "ghost", NOW);
    setSystem(cat, "ghost", "pr-watch", NOW); // in catalogue, never indexed
    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true });
    expect(summary.notIndexed).toBe(1);
    expect(summary.resumed).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});

test("empty cluster is a clean no-op", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    const summary = resumeClusterEntry(idx, cat, "nonexistent", { dryRun: true });
    expect(summary.perSession.length).toBe(0);
    expect(summary.resumed).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});
