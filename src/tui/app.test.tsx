import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../index/schema.ts";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";
import { openCatalogue, setSessionClass } from "../catalogue/db.ts";
import type { Titler } from "../titler/codex.ts";
import type { EngineState } from "./Root.tsx";

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

function makeConfig() {
  const r = loadConfig("/nonexistent-ccs-test.toml");
  if (!r.ok) throw r.error;
  return r.value;
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
    }),
  );
  await new Promise((r) => setTimeout(r, 80));

  const frame = lastFrame() ?? "";
  expect(frame).toContain("ccs");
  // The real (non-subagent) session is listed. At the narrow test width the cluster
  // columns leave room for only the first title character plus an ellipsis.
  expect(frame).toContain("R…");
  expect(frame).not.toContain("SUBAGENTONLY"); // subagent hidden by default
  expect(frame).toContain("sessions"); // dashboard header stat
  // Footer highlights keys with ANSI escapes (the key and its label are separated by color
  // codes), so "Tab skills" is never a contiguous substring. Assert the mode-toggle label +
  // the key independently — both present means the skills toggle rendered.
  expect(frame).toContain("skills");
  expect(frame).toContain("Tab");

  unmount();
  real.close();
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
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(lastFrame() ?? "").not.toContain("AUX");
  expect(lastFrame() ?? "").toContain("UNCLASSIFIED");

  stdin.write("u");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const revealed = lastFrame() ?? "";
  expect(revealed).toContain("AUX");

  unmount();
  catalogue.close();
  index.close();
});

// `R` re-scans the store and re-indexes, so a session that appeared on disk after the TUI opened
// shows up without quitting and relaunching (the whole point of the refresh key).
test("R refreshes the store and surfaces a session created after mount", async () => {
  const index = openIndex(":memory:"); // empty index — nothing listed at mount
  const store = mkdtempSync(join(tmpdir(), "ccs-refresh-"));

  const configPath = join(store, "config.toml");
  writeFileSync(configPath, `[store]\npath = "${store}"\n[host]\nlabel = "reftest"\n`);
  const cfg = loadConfig(configPath);
  if (!cfg.ok) throw cfg.error;

  const { lastFrame, stdin, unmount } = render(
    createElement(App, {
      db: index,
      config: cfg.value,
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(lastFrame() ?? "").toContain("0 sessions"); // empty index at mount
  expect(lastFrame() ?? "").toContain("No sessions indexed yet.");

  // Now the session lands on disk (as if a fresh Claude Code run just started).
  const now = new Date().toISOString();
  const id = "refresh-sess-1";
  const lines = [
    JSON.stringify({ type: "ai-title", aiTitle: "REFRESHMARK", sessionId: id, cwd: "/tmp/proj", timestamp: now }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, sessionId: id, cwd: "/tmp/proj", timestamp: now }),
  ].join("\n");
  writeFileSync(join(store, `${id}.jsonl`), lines);

  stdin.write("R");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const frame = lastFrame() ?? "";
  expect(frame).toContain("1 sessions"); // re-index picked the new file up
  expect(frame).toContain("refreshed — 1 new/updated"); // and reported it

  unmount();
  index.close();
});

// Auto-refresh (config.tui.autoRefreshSec) picks up a new on-disk session with NO keypress — the
// background poll runs the same re-index on its interval.
test("auto-refresh surfaces a new session on its interval without a keypress", async () => {
  const index = openIndex(":memory:");
  const store = mkdtempSync(join(tmpdir(), "ccs-autorefresh-"));

  const configPath = join(store, "config.toml");
  writeFileSync(configPath, `[store]\npath = "${store}"\n[host]\nlabel = "reftest"\n[tui]\nautoRefreshSec = 1\n`);
  const cfg = loadConfig(configPath);
  if (!cfg.ok) throw cfg.error;

  const { lastFrame, unmount } = render(
    createElement(App, {
      db: index,
      config: cfg.value,
      engineState: noopEngineState,
      resumeRequest: { current: null },
      cmuxProbes: noopCmuxProbes,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(lastFrame() ?? "").toContain("0 sessions");

  const now = new Date().toISOString();
  const id = "auto-sess-1";
  writeFileSync(
    join(store, `${id}.jsonl`),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, sessionId: id, cwd: "/tmp/proj", timestamp: now }),
  );

  await new Promise((resolve) => setTimeout(resolve, 1400)); // let one ~1s poll tick fire
  expect(lastFrame() ?? "").toContain("1 sessions"); // indexed with no input

  unmount();
  index.close();
});
