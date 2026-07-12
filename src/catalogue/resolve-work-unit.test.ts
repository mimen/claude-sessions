import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkUnit } from "./resolve-work-unit.ts";
import { getWorkUnit } from "../state/work-units.ts";

const NOW = "2026-07-11T00:00:00Z";

function withRoot<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-rwu-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try {
    return fn();
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveWorkUnit: PR anchor → find-or-create with deterministic id", () => {
  withRoot(() => {
    const id1 = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/api", prNumber: 100 },
      NOW,
    );
    expect(id1).toBe("wu_api_100");

    // Second call finds the existing work-unit
    const id2 = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/api", prNumber: 100 },
      NOW,
    );
    expect(id2).toBe(id1); // same id
  });
});

test("resolveWorkUnit: GUS anchor → find-or-create with deterministic id", () => {
  withRoot(() => {
    const id1 = resolveWorkUnit("pr-watch", { gusWork: "W-12345678" }, NOW);
    expect(id1).toBe("wu_W12345678");

    // Second call finds the existing work-unit
    const id2 = resolveWorkUnit("pr-watch", { gusWork: "W-12345678" }, NOW);
    expect(id2).toBe(id1);
  });
});

test("resolveWorkUnit: no anchor → mint anchorless work-unit (incrementing id)", () => {
  withRoot(() => {
    const id1 = resolveWorkUnit("pr-watch", {}, NOW);
    expect(id1).toBe("wu_anon_1");

    const id2 = resolveWorkUnit("pr-watch", {}, NOW);
    expect(id2).toBe("wu_anon_2"); // separate work-unit (no auto-reconnection)
  });
});

test("resolveWorkUnit: PR anchor takes precedence over GUS", () => {
  withRoot(() => {
    const id = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/web", prNumber: 200, gusWork: "W-99999999" },
      NOW,
    );
    expect(id).toBe("wu_web_200"); // PR anchor wins

    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.prRepo).toBe("acme/web");
    expect(wu.prNumber).toBe(200);
    expect(wu.gusWork).toBeNull(); // GUS not attached (mint only took PR)
  });
});

test("resolveWorkUnit: reconnection after initial creation", () => {
  withRoot(() => {
    // First spawn: create work-unit with PR anchor
    const id1 = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/dashboard", prNumber: 500 },
      NOW,
    );

    // Second spawn (fresh session): reconnect to the same work-unit by PR anchor
    const id2 = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/dashboard", prNumber: 500, sessionId: "s2" },
      NOW,
    );

    expect(id2).toBe(id1); // same work-unit id
  });
});

test("resolveWorkUnit: per-cluster isolation", () => {
  withRoot(() => {
    const id1 = resolveWorkUnit(
      "pr-watch",
      { prRepo: "acme/web", prNumber: 100 },
      NOW,
    );
    const id2 = resolveWorkUnit(
      "event-watch",
      { prRepo: "acme/web", prNumber: 100 },
      NOW,
    );

    expect(id1).toBe("wu_web_100");
    expect(id2).toBe("wu_web_100"); // same derived id, but different clusters
    expect(getWorkUnit("pr-watch", id1)!.cluster).toBe("pr-watch");
    expect(getWorkUnit("event-watch", id2)!.cluster).toBe("event-watch");
  });
});

test("resolveWorkUnit: anchorless stays isolated (no cross-session reconnection)", () => {
  withRoot(() => {
    const id1 = resolveWorkUnit("pr-watch", { sessionId: "s1" }, NOW);
    const id2 = resolveWorkUnit("pr-watch", { sessionId: "s2" }, NOW);

    expect(id1).not.toBe(id2); // separate work-units
    expect(id1).toBe("wu_anon_1");
    expect(id2).toBe("wu_anon_2");
  });
});

test("resolveWorkUnit: null anchors treated as absent (anchorless)", () => {
  withRoot(() => {
    const id = resolveWorkUnit(
      "pr-watch",
      { prRepo: null, prNumber: null, gusWork: null },
      NOW,
    );
    expect(id).toBe("wu_anon_1"); // no anchor → anchorless
  });
});

test("resolveWorkUnit: partial PR anchor (repo but no number) → anchorless", () => {
  withRoot(() => {
    const id = resolveWorkUnit("pr-watch", { prRepo: "acme/web" }, NOW);
    expect(id).toBe("wu_anon_1"); // need both repo + number for PR anchor
  });
});

test("resolveWorkUnit: partial PR anchor (number but no repo) → anchorless", () => {
  withRoot(() => {
    const id = resolveWorkUnit("pr-watch", { prNumber: 123 }, NOW);
    expect(id).toBe("wu_anon_1");
  });
});
