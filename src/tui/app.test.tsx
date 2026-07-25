import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../index/schema.ts";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";
import { openCatalogue, setEnrichment, setSessionClass } from "../catalogue/db.ts";
import type { Titler } from "../titler/codex.ts";
import type { EngineState } from "./Root.tsx";
import { encodePath } from "../resume/locate.ts";

function seed(db: Database): void {
  const ins = db.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id
    ) VALUES ($id,'h','/p','/c','/c','myproj',$br,'1',
      '2026-01-01T00:00:00Z',$last,5,1,1,
      $nat,$fb,'user: hello there',$sub,$parent,$id)`,
  );
  // Recent last_ts so the session lands in RECENTLY IDLE (expanded) under the default
  // group-by-state view, not the collapsed STALE bucket.
  const recent = new Date().toISOString();
  ins.run({ $id: "real1", $br: "main", $nat: "Real Session One", $fb: "fallback", $sub: 0, $parent: null, $last: recent });
  ins.run({ $id: "agent-1", $br: null, $nat: null, $fb: "SUBAGENTONLY", $sub: 1, $parent: "real1", $last: recent });
}

const noopTitler: Titler = { available: () => true, async generate() { return null; } };
const noopEngineState: EngineState = {
  titler: noopTitler,
  engine: null,
  active: null,
  available: [],
  cycle() {},
};
const noopCmuxProbes = {
  async reachable(): Promise<boolean> { return false; },
  async openSessionTitles(): Promise<Map<string, string>> { return new Map(); },
};
const noopT3StatusClient = {
  async snapshot() {
    return {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        generatedAt: "2026-07-22T00:00:00.000Z",
        attachments: [],
      },
    } as const;
  },
};
const runningT3Attachment = {
  providerInstanceId: "claudeAgent",
  localSourceHost: "h",
  nativeSessionId: "real1",
  sourceCwd: realpathSync(process.cwd()),
  sourceId: "source-1",
  threadId: "thread-1",
  projectId: "project-1",
  state: "synced",
  lastSyncedAt: "2026-07-22T00:00:00.000Z",
  diagnostic: null,
  runtimeStatus: "running",
  runtimeLastSeenAt: "2026-07-22T00:00:00.000Z",
} as const;

function makeConfig() {
  const r = loadConfig("/nonexistent-ccs-test.toml");
  if (!r.ok) throw r.error;
  return r.value;
}

function updateRootCwd(index: Database, cwd: string): void {
  index.query("UPDATE sessions SET path = $path, cwd = $cwd, project_root = $cwd WHERE session_id = 'real1'").run({
    $path: `/store/${encodePath(cwd)}/real1.jsonl`,
    $cwd: cwd,
  });
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  includes: string,
  excludes?: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const frame = lastFrame() ?? "";
    if (frame.includes(includes) && (!excludes || !frame.includes(excludes))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  const frame = lastFrame() ?? "";
  expect(frame).toContain(includes);
  if (excludes) expect(frame).not.toContain(excludes);
}

function useFlatView(): () => void {
  const prior = process.env.CCS_ROOT;
  const root = mkdtempSync(join(tmpdir(), "ccs-tui-t3-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "prefs.json"), JSON.stringify({ view: "flat" }));
  process.env.CCS_ROOT = root;
  return () => {
    if (prior === undefined) delete process.env.CCS_ROOT;
    else process.env.CCS_ROOT = prior;
    rmSync(root, { recursive: true, force: true });
  };
}

// The real binary is also verified end-to-end via a PTY smoke (script(1) → `q`): full
// rendered frame, exits 0. This mount test covers the default filtering + render wiring.
test("App mounts, lists real sessions, hides subagents by default", async () => {
  const real = openIndex(":memory:");
  seed(real);

  const { lastFrame, unmount } = render(
    createElement(App, {
      db: real,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: noopT3StatusClient,
    }),
  );
  await new Promise((r) => setTimeout(r, 80));

  const frame = lastFrame() ?? "";
  expect(frame).toContain("ccs");
  // The real (non-subagent) root contributes the only visible row. The current cluster columns
  // consume the title in Ink's narrow test viewport, so assert the row count and child rollup.
  expect(frame).toContain("1 sessions");
  expect(frame).toContain("↳1");
  expect(frame).not.toContain("●"); // native-only row leaves the T3 attachment column blank
  expect(frame).not.toContain("SUBAGENTONLY"); // subagent hidden by default
  expect(frame).toContain("sessions"); // dashboard header stat
  // The added T3 shortcut can truncate the final skills label in Ink's narrow test viewport,
  // but the Tab mode-toggle key remains visible.
  expect(frame).toContain("Tab");

  unmount();
  real.close();
});

test("App shows enrichment titles when no live, custom, or role title overrides them", async () => {
  const restorePrefs = useFlatView();
  const index = openIndex(":memory:");
  const catalogue = openCatalogue(":memory:");
  seed(index);
  const now = "2026-07-24T12:00:00.000Z";
  setEnrichment(catalogue, "real1", {
    title: "Enriched outcome title",
    summary: "The session completed its intended work.",
    outstanding: "",
    recommendation: "complete",
    reason: "The implementation and verification are finished.",
    junk: false,
    cwdCorrect: true,
    suggestedLocation: "",
    suggestedCwd: "",
    atMessages: 5,
    at: now,
  }, now);

  const { lastFrame, unmount } = render(
    createElement(App, {
      db: index,
      catalogue,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: noopT3StatusClient,
    }),
  );
  try {
    await waitForFrame(lastFrame, "Enriched outcome title");
    expect(lastFrame() ?? "").not.toContain("Real Session One");
  } finally {
    unmount();
    catalogue.close();
    index.close();
    restorePrefs();
  }
});

test("App reads one T3 attachment snapshot and renders its second status circle", async () => {
  const restorePrefs = useFlatView();
  const index = openIndex(":memory:");
  seed(index);
  updateRootCwd(index, realpathSync(process.cwd()));
  let calls = 0;

  const { lastFrame, unmount } = render(
    createElement(App, {
      db: index,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: {
        async snapshot() {
          calls++;
          return {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              generatedAt: "2026-07-22T00:00:00.000Z",
              attachments: [runningT3Attachment],
            },
          } as const;
        },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));

  expect(calls).toBe(1);
  expect(lastFrame() ?? "").toContain("○ ●");

  unmount();
  index.close();
  restorePrefs();
});

test("T3 attachment circle exposes textual status in screen-reader mode", async () => {
  const restorePrefs = useFlatView();
  const index = openIndex(":memory:");
  seed(index);
  updateRootCwd(index, realpathSync(process.cwd()));
  const priorScreenReader = process.env.INK_SCREEN_READER;
  process.env.INK_SCREEN_READER = "true";

  const { lastFrame, unmount } = render(
    createElement(App, {
      db: index,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: {
        async snapshot() {
          return {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              generatedAt: "2026-07-22T00:00:00.000Z",
              attachments: [runningT3Attachment],
            },
          } as const;
        },
      },
    }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lastFrame() ?? "").toContain(
      "T3 attachment running; sync synced; provider running",
    );
  } finally {
    unmount();
    index.close();
    restorePrefs();
    if (priorScreenReader === undefined) delete process.env.INK_SCREEN_READER;
    else process.env.INK_SCREEN_READER = priorScreenReader;
  }
});

test("auxiliary sessions stay hidden until the session-local u toggle reveals them", async () => {
  const index = openIndex(":memory:");
  seed(index);
  index.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id
    ) VALUES ('aux1','h','/aux','/c','/c','myproj',NULL,'1',
      '2026-07-20T01:00:00Z','2026-07-20T01:01:00Z',2,1,1,
      'Auxiliary Row','fallback','user: delegated',0,NULL,'aux1')`,
  ).run();
  index.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id
    ) VALUES ('new1','h','/new','/c','/c','myproj',NULL,'1',
      '2026-07-20T02:00:00Z','2026-07-20T02:01:00Z',2,1,1,
      'Recent Unclassified','fallback','user: plain claude',0,NULL,'new1')`,
  ).run();
  const catalogue = openCatalogue(":memory:");
  setSessionClass(catalogue, "aux1", "auxiliary", "2026-07-20T01:00:00Z");

  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      db: index,
      catalogue,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: noopT3StatusClient,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(lastFrame() ?? "").not.toContain("AUX");
  expect(lastFrame() ?? "").toContain("UNCLASSIFIED");

  stdin.write("u");
  await waitForFrame(lastFrame, "AUX");

  unmount();
  catalogue.close();
  index.close();
});

test("T opens the selected root session after the T3 CLI contract ships", async () => {
  const restorePrefs = useFlatView();
  const index = openIndex(":memory:");
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ccs-t3-cwd-")));
  seed(index);
  updateRootCwd(index, cwd);
  let calls = 0;
  const resumeRequest = { current: null };

  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      db: index,
      config: makeConfig(),
      engineState: noopEngineState,
      resumeRequest,
      cmuxProbes: noopCmuxProbes,
      t3StatusClient: noopT3StatusClient,
      t3Opener: {
        async open(request) {
          calls++;
          expect(request).toEqual({ resumeId: "real1", cwd });
          return { kind: "opened", threadId: "thread", projectId: "project", created: true } as const;
        },
      },
    }),
  );
  await waitForFrame(lastFrame, "open in T3");

  stdin.write("?");
  await waitForFrame(lastFrame, "open this root Claude session in T3");
  stdin.write("?");
  await waitForFrame(lastFrame, "T open in T3", "open this root Claude session in T3");
  stdin.write("T");
  await waitForFrame(lastFrame, "created T3 thread");

  expect(calls).toBe(1);
  expect(lastFrame() ?? "").toContain("created T3 thread");
  expect(resumeRequest.current).toBeNull();

  unmount();
  index.close();
  rmSync(cwd, { recursive: true, force: true });
  restorePrefs();
});
