import {
  subscribeToCmuxEvents,
  type CmuxChangeScope,
  type CmuxEventSubscription,
  type CmuxEventSubscriptionOptions,
} from "../cmux/events.ts";
import { log } from "../logger.ts";

const DURABLE_RECONCILE_INTERVAL_MS = 1_000;

interface SidebarChangeSource {
  invalidate?(scopes: Iterable<CmuxChangeScope>): void;
  reconcileDurableState?(): void;
  close?(): void;
}

interface ScheduledRepeat {
  stop(): void;
}

type Subscribe = (options: CmuxEventSubscriptionOptions) => CmuxEventSubscription;
type ScheduleEvery = (callback: () => void, intervalMs: number) => ScheduledRepeat;

export interface SidebarChangeMonitor {
  stop(): void;
}

export interface SidebarChangeMonitorOptions {
  readonly source: SidebarChangeSource;
  readonly subscribe?: Subscribe;
  readonly scheduleEvery?: ScheduleEvery;
  readonly logger?: Pick<typeof log, "warn">;
}

function scheduleEvery(callback: () => void, intervalMs: number): ScheduledRepeat {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * One lifecycle for every way the sidebar learns that its sources changed.
 *
 * cmux publishes short-horizon workspace changes. SQLite exposes durable catalogue and index commits
 * through cheap header probes. Both converge on the source's one monotonic revision interface, so
 * clients never need to know which store changed or restart themselves to discover it.
 */
export function startSidebarChangeMonitor(
  options: SidebarChangeMonitorOptions,
): SidebarChangeMonitor {
  const logger = options.logger ?? log;
  const subscription = (options.subscribe ?? subscribeToCmuxEvents)({
    onChange: (scopes) => options.source.invalidate?.(scopes),
  });
  const timer = (options.scheduleEvery ?? scheduleEvery)(() => {
    try {
      options.source.reconcileDurableState?.();
    } catch (error) {
      logger.warn("sidebar durable-state reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, DURABLE_RECONCILE_INTERVAL_MS);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      subscription.stop();
      timer.stop();
      options.source.close?.();
    },
  };
}
