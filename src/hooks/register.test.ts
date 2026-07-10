import { describe, expect, test } from "bun:test";
import { openCatalogue, getRow, setRole, setResumeCommand } from "../catalogue/db.ts";
import { handleSessionStart } from "./register.ts";

const NOW = "2026-07-09T00:00:00Z";

describe("handleSessionStart", () => {
  test("registered session: refreshed silently, no additionalContext", () => {
    const db = openCatalogue(":memory:");
    setRole(db, "s1", "pr-agent", NOW);
    const out = handleSessionStart(db, { session_id: "s1", source: "startup", cwd: "/x" }, NOW);
    expect(out.registered).toBe(true);
    expect(out.additionalContext).toBeNull();
    expect(out.degraded).toBe(false);
  });

  test("unregistered session: emits additionalContext asking the agent to self-register", () => {
    const db = openCatalogue(":memory:");
    const out = handleSessionStart(db, { session_id: "new", source: "startup", cwd: "/x" }, NOW);
    expect(out.registered).toBe(false);
    expect(out.additionalContext).toContain("ccs role");
    // an unregistered session is marked degraded until it gets a role (ADR-0035)
    expect(out.degraded).toBe(true);
  });

  test("registration touches updated_at on a known session (refresh)", () => {
    const db = openCatalogue(":memory:");
    setRole(db, "s1", "control", "2026-07-01T00:00:00Z");
    handleSessionStart(db, { session_id: "s1", source: "startup", cwd: "/x" }, NOW);
    expect(getRow(db, "s1")!.updatedAt).toBe(NOW);
  });

  test("re-arm: a resumed loop with a resume_command is flagged for re-arming", () => {
    const db = openCatalogue(":memory:");
    setRole(db, "loop", "control", NOW);
    setResumeCommand(db, "loop", "/loop 15m /pr-watch-control", NOW);
    const out = handleSessionStart(db, { session_id: "loop", source: "resume", cwd: "/x" }, NOW);
    expect(out.reArm).toBe("/loop 15m /pr-watch-control");
    // re-arm surfaces the command as context (belt-and-suspenders, ADR-0017)
    expect(out.additionalContext).toContain("/loop 15m /pr-watch-control");
  });

  test("no re-arm on a fresh (startup) start, even with a resume_command", () => {
    const db = openCatalogue(":memory:");
    setRole(db, "loop", "control", NOW);
    setResumeCommand(db, "loop", "/loop 15m /pr-watch-control", NOW);
    const out = handleSessionStart(db, { session_id: "loop", source: "startup", cwd: "/x" }, NOW);
    expect(out.reArm).toBeNull();
  });

  test("a worker resume (no resume_command) does not re-arm", () => {
    const db = openCatalogue(":memory:");
    setRole(db, "w", "pr-agent", NOW);
    const out = handleSessionStart(db, { session_id: "w", source: "resume", cwd: "/x" }, NOW);
    expect(out.reArm).toBeNull();
  });

  test("a malformed payload (no session_id) fails open — no throw, degraded", () => {
    const db = openCatalogue(":memory:");
    const out = handleSessionStart(db, { source: "startup" } as never, NOW);
    expect(out.registered).toBe(false);
    expect(out.degraded).toBe(true);
    expect(out.additionalContext).toBeNull(); // nothing to ask about; just don't crash
  });
});
