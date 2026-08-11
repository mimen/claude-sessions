/**
 * How late the event loop is running its own timers.
 *
 * A slow snapshot has two very different causes and the same symptom. Either a source read
 * genuinely blocked — the cmux socket, the catalogue, the index — or this process simply did not
 * get the CPU, which on a loaded machine is routine and is not a bug in anything the sidebar
 * does. Phase timings cannot tell those apart: a phase that spans a descheduled period looks
 * exactly like a phase that did slow work.
 *
 * Lag separates them. A timer asked to fire in `INTERVAL_MS` that fires 4 seconds late says the
 * loop was starved, whatever the phases claim. Reading close to zero while a phase reports
 * seconds says the phase really was blocked.
 *
 * The sampler is a single interval, unref'd so it never keeps the process alive on its own.
 */
const INTERVAL_MS = 500;

export interface EventLoopLagSampler {
  /** Lag on the most recent tick, in milliseconds. */
  current(): number;
  /** Highest lag seen since the last read, then reset. Slow requests are rare and bursty. */
  takePeak(): number;
  stop(): void;
}

export function startEventLoopLagSampler(intervalMs: number = INTERVAL_MS): EventLoopLagSampler {
  let lag = 0;
  let peak = 0;
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    // Anything beyond the interval is time the loop owed this timer and did not pay.
    lag = Math.max(0, now - expected);
    peak = Math.max(peak, lag);
    expected = now + intervalMs;
  }, intervalMs);
  // Bun and Node both support unref on the returned handle; a diagnostic must never be the
  // reason a process refuses to exit.
  timer.unref?.();

  return {
    current: () => lag,
    takePeak: () => {
      const seen = peak;
      peak = lag;
      return seen;
    },
    stop: () => clearInterval(timer),
  };
}
