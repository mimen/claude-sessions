// JavaScriptCore entry: exposes one JSON-in, JSON-out function so Swift never marshals objects.
import { buildView, carryForward, reordered, shortAge, renewalLabel, type Order, type Snapshot } from "./index.ts";

(globalThis as Record<string, unknown>).usageView = {
  build(snapshotJson: string, previousJson: string | null, orderJson: string): string {
    const next = JSON.parse(snapshotJson) as Snapshot;
    const previous = previousJson ? JSON.parse(previousJson) as Snapshot : null;
    const snapshot = carryForward(next, previous);
    return JSON.stringify({ snapshot, view: buildView(snapshot, JSON.parse(orderJson) as Order) });
  },
  reordered(idsJson: string, moving: string, target: string): string {
    return JSON.stringify(reordered(JSON.parse(idsJson) as string[], moving, target));
  },
  shortAge,
  renewalLabel,
};
