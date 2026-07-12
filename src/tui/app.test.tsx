import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { Database } from "bun:sqlite";
import { openIndex } from "../index/schema.ts";
import { loadConfig } from "../config.ts";
import { App } from "./App.tsx";
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
    }),
  );
  await new Promise((r) => setTimeout(r, 80));

  const frame = lastFrame() ?? "";
  expect(frame).toContain("ccs");
  // The real (non-subagent) session is listed — assert its truncation-safe title prefix
  // ("Rea" survives the narrow test width; the cluster view's PHASE/ROLE columns eat into
  // the title, so the full word "Real" no longer fits at this width).
  expect(frame).toContain("Rea"); // visible real session (title truncates to "Rea…")
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
