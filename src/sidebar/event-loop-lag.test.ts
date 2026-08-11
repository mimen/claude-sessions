/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { startEventLoopLagSampler } from "./event-loop-lag.ts";

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Hold the thread so the sampler's timer cannot fire on schedule. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Deliberate: a real starved loop is busy, not awaiting.
  }
}

describe("event loop lag sampler", () => {
  test("reads near zero on an idle loop", async () => {
    const sampler = startEventLoopLagSampler(20);
    await settle(120);
    // Generous: CI and a loaded laptop both add noise, and the claim under test is only that an
    // idle loop is nowhere near the multi-second lag a starved one shows.
    expect(sampler.current()).toBeLessThan(100);
    sampler.stop();
  });

  test("reports the block that kept the loop from its own timer", async () => {
    const sampler = startEventLoopLagSampler(20);
    await settle(60);
    block(200);
    await settle(80);
    expect(sampler.takePeak()).toBeGreaterThan(100);
    sampler.stop();
  });

  test("taking the peak clears it so each slow request reports its own burst", async () => {
    const sampler = startEventLoopLagSampler(20);
    await settle(40);
    block(200);
    await settle(80);
    expect(sampler.takePeak()).toBeGreaterThan(100);

    await settle(80);
    // The burst is gone; what remains describes the loop as it is now.
    expect(sampler.takePeak()).toBeLessThan(100);
    sampler.stop();
  });

  test("stops cleanly and holds its last reading", async () => {
    const sampler = startEventLoopLagSampler(20);
    await settle(60);
    sampler.stop();
    const afterStop = sampler.current();
    await settle(60);
    expect(sampler.current()).toBe(afterStop);
  });
});
