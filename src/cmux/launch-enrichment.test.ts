import { describe, expect, test } from "bun:test";
import {
  launchImmediateEnrichment,
  type DetachedEnrichmentSpawnOptions,
  type ImmediateEnrichmentDependencies,
} from "./launch-enrichment.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("launchImmediateEnrichment", () => {
  test("uses nohup, an explicit UUID, one per-session log, disconnected stdio, and unref", () => {
    const events: string[] = [];
    const commands: string[][] = [];
    const options: DetachedEnrichmentSpawnOptions[] = [];
    const environment = { CCS_ROOT: "/runtime" };
    const deps: ImmediateEnrichmentDependencies = {
      ccsBinary: "/opt/ccs/bin/ccs",
      nohupBinary: "/usr/bin/nohup",
      environment,
      logPath(sessionId): string {
        events.push(`log-path:${sessionId}`);
        return `/runtime/enrich/${sessionId}.log`;
      },
      openLog(path): number {
        events.push(`open:${path}`);
        return 17;
      },
      closeLog(fd): void {
        events.push(`close-fd:${fd}`);
      },
      spawn(command, spawnOptions) {
        commands.push([...command]);
        options.push(spawnOptions);
        events.push("spawn");
        return {
          unref(): void {
            events.push("unref");
          },
        };
      },
    };

    expect(launchImmediateEnrichment(SESSION_ID, deps)).toEqual({
      ok: true,
      value: { logPath: `/runtime/enrich/${SESSION_ID}.log` },
    });
    expect(commands).toEqual([[
      "/usr/bin/nohup",
      "/opt/ccs/bin/ccs",
      "enrich",
      SESSION_ID,
    ]]);
    expect(options).toEqual([{
      stdin: "ignore",
      stdout: 17,
      stderr: 17,
      env: environment,
      detached: true,
    }]);
    expect(events).toEqual([
      `log-path:${SESSION_ID}`,
      `open:/runtime/enrich/${SESSION_ID}.log`,
      "spawn",
      "unref",
      "close-fd:17",
    ]);
  });

  test("reports launch failure and still closes the parent log descriptor", () => {
    const events: string[] = [];
    const deps: ImmediateEnrichmentDependencies = {
      ccsBinary: "/ccs",
      nohupBinary: "/usr/bin/nohup",
      environment: {},
      logPath: (sessionId) => `/runtime/enrich/${sessionId}.log`,
      openLog: () => 23,
      closeLog(fd): void {
        events.push(`close-fd:${fd}`);
      },
      spawn(): never {
        throw new Error("posix_spawn failed");
      },
    };

    const result = launchImmediateEnrichment(SESSION_ID, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("posix_spawn failed");
      expect(result.error.message).toContain(`/runtime/enrich/${SESSION_ID}.log`);
    }
    expect(events).toEqual(["close-fd:23"]);
  });
});
