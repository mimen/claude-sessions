import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tasksFor, sessionsWithTasks } from "./reader.ts";

const root = join(tmpdir(), `ccs-tasks-test-${process.pid}`);
const sid = "11111111-2222-3333-4444-555555555555";

function writeTask(dir: string, n: number, body: Record<string, unknown>): void {
  writeFileSync(join(dir, `${n}.json`), JSON.stringify(body));
}

beforeAll(() => {
  const dir = join(root, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".lock"), "");
  writeTask(dir, 2, { id: "2", subject: "Second", description: "", activeForm: "Doing second", status: "in_progress", blocks: [], blockedBy: ["1"] });
  writeTask(dir, 1, { id: "1", subject: "First", description: "d", activeForm: "", status: "completed", blocks: ["2"], blockedBy: [] });
  writeTask(dir, 10, { id: "10", subject: "Tenth", description: "", activeForm: "", status: "pending", blocks: [], blockedBy: [] });
  writeFileSync(join(dir, "99.json"), "{not json");
  process.env.CCS_TASKS_PATH = root;
});

afterAll(() => {
  delete process.env.CCS_TASKS_PATH;
  rmSync(root, { recursive: true, force: true });
});

describe("tasksFor", () => {
  test("summarizes and sorts numerically, skipping junk", () => {
    const s = tasksFor(sid);
    expect(s).not.toBeNull();
    expect(s!.total).toBe(3);
    expect(s!.completed).toBe(1);
    expect(s!.inProgress).toBe(1);
    expect(s!.pending).toBe(1);
    expect(s!.tasks.map((t) => t.id)).toEqual(["1", "2", "10"]);
    expect(s!.active?.subject).toBe("Second");
    expect(s!.tasks[1]!.blockedBy).toEqual(["1"]);
  });

  test("null for unknown session", () => {
    expect(tasksFor("no-such-session")).toBeNull();
  });

  test("sessionsWithTasks lists dirs", () => {
    expect(sessionsWithTasks().has(sid)).toBe(true);
  });
});
