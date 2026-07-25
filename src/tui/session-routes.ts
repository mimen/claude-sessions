import type { SessionRow } from "../index/index.ts";
import { defaultRoute, resolveRoutes, type Launcher, type Route } from "../resume/launchers.ts";

export interface SessionRouteResolution {
  readonly routes: Route[];
  readonly defaultRoute: Route | null;
}

/** Resolve TUI resume routes from the same last-turn evidence used by the CLI. */
export function routesForSession(
  launchers: readonly Launcher[],
  row: Pick<SessionRow, "models" | "lastModel">,
): SessionRouteResolution {
  const routes = resolveRoutes(launchers, row.models, row.lastModel);
  return {
    routes,
    defaultRoute: defaultRoute(routes, row.models, row.lastModel),
  };
}
