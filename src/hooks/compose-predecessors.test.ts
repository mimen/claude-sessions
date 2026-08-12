import { expect, test } from "bun:test";
import { predecessorLifecycleLabel } from "./compose-predecessors.ts";
import type { Embodiment } from "../catalogue/lineage.ts";

const predecessor = (lifecycle: Embodiment["lifecycle"]): Embodiment => ({
  sessionId: "session-1",
  transcriptPath: "/tmp/session-1.jsonl",
  lastTs: "2026-08-11T00:00:00Z",
  lifecycle,
});

test("predecessor lifecycle labels use Saved and Done public vocabulary", () => {
  expect(predecessorLifecycleLabel(predecessor("saved"))).toBe("Saved");
  expect(predecessorLifecycleLabel(predecessor("completed"))).toBe("Done");
  expect(predecessorLifecycleLabel(predecessor("parked"))).toBe("prior");
});
