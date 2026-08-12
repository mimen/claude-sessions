import { Database } from "bun:sqlite";
import type { Bridge } from "../cmux/bridge.ts";
import { type CatalogueRow } from "../catalogue/db-schema.ts";
import { setExistingSessionLifecycle } from "../catalogue/commands.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";
import type { Launcher } from "./launchers.ts";
import { log } from "../logger.ts";
import {
  resumeSessionEntryAsync,
  type ResumeSessionResult,
} from "./resume-session.ts";

export type SidebarResumeActionOutcome =
  | {
    readonly status: "ok";
    readonly result: ResumeSessionResult;
    readonly paintRow: CatalogueRow | null;
  }
  | { readonly status: "index-unreadable" }
  | { readonly status: "catalogue-unreadable" };

export interface SidebarResumeActionInput {
  readonly bridge: Bridge;
  readonly sessionId: string;
  readonly cmuxBin: string;
  readonly launchers: readonly Launcher[];
}

export type SidebarResumeAction = (
  input: SidebarResumeActionInput,
) => Promise<SidebarResumeActionOutcome>;

export interface SidebarResumeActionOptions {
  readonly processAdapter: AsyncProcessAdapter;
  readonly indexPath?: string;
  readonly cataloguePath?: string;
  readonly logger?: Pick<typeof log, "warn">;
}

function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

/**
 * Own the database handles needed by managed resume. Sidebar request and snapshot modules receive
 * only this typed action, so neither can accidentally turn a read dependency into a mutation path.
 */
export function createSidebarResumeAction(
  options: SidebarResumeActionOptions,
): SidebarResumeAction {
  const logger = options.logger ?? log;
  const indexPath = options.indexPath ?? DB_PATH();
  const cataloguePath = options.cataloguePath ?? CATALOGUE_PATH();
  return async (input): Promise<SidebarResumeActionOutcome> => {
    let indexDb: Database;
    try {
      indexDb = openReadOnly(indexPath);
    } catch (error) {
      logger.warn("sidebar resume index open failed", {
        operation: "resume",
        sessionId: input.sessionId,
        indexPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "index-unreadable" };
    }

    let catalogueDb: Database | null = null;
    try {
      try {
        catalogueDb = openReadOnly(cataloguePath);
      } catch (error) {
        logger.warn("sidebar resume catalogue open failed", {
          operation: "resume",
          sessionId: input.sessionId,
          cataloguePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return { status: "catalogue-unreadable" };
      }
      const paintRow = getRow(catalogueDb, input.sessionId);
      const result = await resumeSessionEntryAsync(
        indexDb,
        catalogueDb,
        input.sessionId,
        {
          bridge: input.bridge,
          focus: true,
          cmuxBin: input.cmuxBin,
          launchers: input.launchers,
          reactivateSaved(resumedSessionId): boolean {
            return setExistingSessionLifecycle(resumedSessionId, "unsave", {
              cataloguePath,
              logger,
            }).status === "ok";
          },
        },
        options.processAdapter,
      );
      return { status: "ok", result, paintRow };
    } finally {
      catalogueDb?.close();
      indexDb.close();
    }
  };
}
