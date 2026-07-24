import { expect, test } from "bun:test";
import { t3AttachmentColor } from "./SessionList.tsx";
import { theme } from "./theme.ts";

const running = {
  kind: "running",
  label: "T3 attachment running; sync synced; provider running",
} as const;
const unhealthy = {
  kind: "unhealthy",
  label: "T3 attachment unhealthy; sync failed; provider error",
} as const;

test("T3 attachment colors reserve cobalt for running, amber for unhealthy, and black for selection", () => {
  expect(t3AttachmentColor(running, false)).toBe("#0047ab");
  expect(t3AttachmentColor(unhealthy, false)).toBe("#d97706");
  expect(t3AttachmentColor(running, true)).toBe(theme.selFg);
  expect(t3AttachmentColor(unhealthy, true)).toBe(theme.selFg);
});
