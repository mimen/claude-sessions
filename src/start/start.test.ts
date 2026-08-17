import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { setSessionClass } from "../catalogue/db-mutations.ts";
import type { SurfaceLocation } from "../cmux/bridge.ts";
import { err, ok } from "../result.ts";
import {
  birthManagedLauncher,
  composerIsReady,
  composerPrefillArgs,
  discoverLauncherWorkspace,
  prefillComposer,
  startCommand,
  waitForComposerReady,
  type LauncherBirthRequest,
  type PollClock,
  type StartCommandDependencies,
} from "./command.ts";

const NOW = "2026-07-24T12:00:00.000Z";
const roots: string[] = [];

const LOCATION: SurfaceLocation = {
  surfaceId: "surface-uuid",
  surfaceRef: "surface:9",
  surfaceType: "terminal",
  title: "Claude",
  paneId: "pane-uuid",
  paneIndex: 0,
  indexInPane: 0,
  workspaceId: "workspace-uuid",
  workspaceRef: "workspace:41",
  workspaceTitle: "/ccs:new launcher",
  windowId: "window-uuid",
  windowRef: "window:3",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CCS_ROOT;
  delete process.env.CMUX_BIN;
});

function quietConsole(): () => void {
  const error = spyOn(console, "error").mockImplementation((): void => {});
  const log = spyOn(console, "log").mockImplementation((): void => {});
  return () => {
    error.mockRestore();
    log.mockRestore();
  };
}

function successfulDependencies(
  prefills: string[],
  requests: LauncherBirthRequest[],
): StartCommandDependencies {
  return {
    cwd: () => "/repo/current",
    birth: (request) => {
      requests.push(request);
      return ok({
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceRef: "workspace:41",
      });
    },
    discover: async () => ok(LOCATION),
    waitUntilReady: async () => ok(undefined),
    prefill: (_location, text) => {
      prefills.push(text);
      return ok(undefined);
    },
  };
}

test("start creates one fresh top-level launcher request and one exact unsubmitted prefill", async () => {
  const prefills: string[] = [];
  const requests: LauncherBirthRequest[] = [];
  const restore = quietConsole();
  try {
    const code = await startCommand([
      "--dangerously-skip-permissions",
      "$(touch /tmp/must-not-run)",
      "`whoami`",
      "a;b",
      "x|y",
      "x&y",
      "quoted value",
    ], successfulDependencies(prefills, requests));

    expect(code).toBe(0);
    expect(requests).toEqual([{
      topLevel: true,
      cwd: "/repo/current",
      title: "/ccs:new launcher",
      focus: true,
    }]);
    expect(prefills).toEqual([
      "/ccs:new --dangerously-skip-permissions $(touch /tmp/must-not-run) `whoami` a;b x|y x&y quoted value",
    ]);
  } finally {
    restore();
  }
});

test("bare start pre-fills exactly /ccs:new plus one trailing space", async () => {
  const prefills: string[] = [];
  const requests: LauncherBirthRequest[] = [];
  const restore = quietConsole();
  try {
    expect(await startCommand([], successfulDependencies(prefills, requests))).toBe(0);
    expect(prefills).toEqual(["/ccs:new "]);
    expect(requests).toHaveLength(1);
  } finally {
    restore();
  }
});

test("managed launcher birth uses session-new once, never reuses an idle session, and focuses cmux", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-start-birth-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  writeFileSync(join(root, "config.toml"), "[host]\nlabel = \"test-host\"\n");
  process.env.CCS_ROOT = root;

  const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const seeded = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    setSessionClass(seeded, oldId, "work_body", NOW);
  } finally {
    seeded.close();
  }

  const callsPath = join(root, "cmux-calls");
  const fakeCmux = join(root, "fake-cmux");
  writeFileSync(fakeCmux, `#!/bin/bash
printf '%s\\n' "$@" > "${callsPath}"
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
if [[ "$command" == *" && /usr/bin/env "* ]]; then
  setup="\${command%% && /usr/bin/env *}"
  /bin/bash -c "\${setup} && true)" || exit 1
fi
printf '%s\\n' 'workspace:901'
`);
  chmodSync(fakeCmux, 0o755);
  process.env.CMUX_BIN = fakeCmux;

  const result = birthManagedLauncher({
    topLevel: true,
    cwd: root,
    title: "/ccs:new launcher",
    focus: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.sessionId).not.toBe(oldId);
  expect(result.value.workspaceRef).toBe("workspace:901");

  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const rows = db.query("SELECT session_id FROM catalogue ORDER BY session_id").all() as Array<{ session_id: string }>;
    expect(rows).toHaveLength(2);
    expect(getRow(db, result.value.sessionId)?.sessionClass).toBe("work_body");
    expect(getRow(db, result.value.sessionId)?.parentSessionId).toBeNull();
  } finally {
    db.close();
  }

  const calls = readFileSync(callsPath, "utf8").trim().split("\n");
  expect(calls.filter((arg) => arg === "new-workspace")).toHaveLength(1);
  const focusIndex = calls.indexOf("--focus");
  expect(calls[focusIndex + 1]).toBe("true");
  const commandIndex = calls.indexOf("--command");
  const launchCommand = calls[commandIndex + 1] ?? "";
  // The typed command is only the short transport source line; the real launcher invocation
  // travels in the transport's launch.sh, which the fake cmux never consumed.
  expect(launchCommand).toStartWith("builtin . ");
  const launchScript = readFileSync(launchCommand.slice("builtin . ".length), "utf8");
  expect(launchScript).toContain("claude");
  expect(launchScript).toContain("--session-id");
  expect(launchScript).not.toContain("--resume");
  expect(launchScript).not.toContain("/ccs:new");
  expect(launchCommand).not.toContain("/ccs:new");
});

test("composer prefill passes metacharacters literally in one send call with no Enter", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-start-prefill-"));
  roots.push(root);
  const callsPath = join(root, "cmux-calls");
  const countPath = join(root, "cmux-count");
  const markerPath = join(root, "executed");
  const fakeCmux = join(root, "fake-cmux");
  writeFileSync(fakeCmux, `#!/bin/bash
printf '%s\\n' call >> "${countPath}"
printf '%s\\n' "$@" > "${callsPath}"
`);
  chmodSync(fakeCmux, 0o755);
  process.env.CMUX_BIN = fakeCmux;

  const text = `/ccs:new --leading $(touch ${markerPath}) \`whoami\` 'single' "double" ; | &`;
  const result = prefillComposer(LOCATION, text);
  expect(result.ok).toBe(true);
  expect(existsSync(markerPath)).toBe(false);
  expect(readFileSync(countPath, "utf8").trim().split("\n")).toEqual(["call"]);

  const calls = readFileSync(callsPath, "utf8").trim().split("\n");
  expect(calls).toEqual(composerPrefillArgs(LOCATION, text));
  expect(calls[0]).toBe("send");
  expect(calls).not.toContain("send-key");
  expect(calls.map((arg) => arg.toLowerCase())).not.toContain("enter");
  expect(calls.at(-1)).toBe(text);
});

test("workspace discovery and readiness poll until exact evidence appears", async () => {
  let now = 0;
  const clock: PollClock = {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  };
  let locationProbes = 0;
  const discovered = await discoverLauncherWorkspace(
    { sessionId: "fresh", workspaceRef: "workspace:41" },
    () => {
      locationProbes += 1;
      return ok(locationProbes === 1 ? null : LOCATION);
    },
    clock,
    1_000,
  );
  expect(discovered).toEqual(ok(LOCATION));
  expect(locationProbes).toBe(2);

  let screenReads = 0;
  const ready = await waitForComposerReady(
    LOCATION,
    () => {
      screenReads += 1;
      return ok(screenReads === 1 ? "Starting Claude Code…" : "Claude Code\n\n❯   \n");
    },
    clock,
    1_000,
  );
  expect(ready).toEqual(ok(undefined));
  expect(screenReads).toBe(2);
  expect(composerIsReady("❯ task already present")).toBe(false);
  expect(composerIsReady("[32m❯[0m  \n")).toBe(true);
});

test("help and obsolete inference flags never create a birth", async () => {
  let births = 0;
  const dependencies: StartCommandDependencies = {
    birth: () => {
      births += 1;
      return err(new Error("must not launch"));
    },
  };
  const restore = quietConsole();
  try {
    expect(await startCommand(["--help"], dependencies)).toBe(0);
    expect(await startCommand(["--explain", "old route"], dependencies)).toBe(2);
    expect(await startCommand(["--dry-run"], dependencies)).toBe(2);
    expect(await startCommand(["literal\\nenter"], dependencies)).toBe(2);
    expect(await startCommand(["literal\nenter"], dependencies)).toBe(2);
    expect(births).toBe(0);
  } finally {
    restore();
  }
});

test("a separator permits obsolete-looking text as literal composer content", async () => {
  const prefills: string[] = [];
  const requests: LauncherBirthRequest[] = [];
  const restore = quietConsole();
  try {
    expect(await startCommand(["--", "--explain", "this", "request"], successfulDependencies(prefills, requests))).toBe(0);
    expect(prefills).toEqual(["/ccs:new --explain this request"]);
    expect(requests).toHaveLength(1);
  } finally {
    restore();
  }
});

test("birth, discovery, readiness, and prefill failures stop at their exact stage", async () => {
  const messages: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation((message?: string): void => {
    messages.push(message ?? "");
  });
  try {
    let downstream = 0;
    const birthCode = await startCommand([], {
      birth: () => err(new Error("birth unavailable")),
      discover: async () => { downstream += 1; return ok(LOCATION); },
    });
    expect(birthCode).toBe(1);
    expect(downstream).toBe(0);
    expect(messages.at(-1)).toContain("managed birth failed");

    let prefills = 0;
    const discoveryCode = await startCommand([], {
      birth: () => ok({ sessionId: "fresh", workspaceRef: "workspace:1" }),
      discover: async () => err(new Error("surface missing")),
      waitUntilReady: async () => { downstream += 1; return ok(undefined); },
      prefill: () => { prefills += 1; return ok(undefined); },
    });
    expect(discoveryCode).toBe(1);
    expect(prefills).toBe(0);
    expect(messages.at(-1)).toContain("workspace discovery failed");

    const readinessCode = await startCommand([], {
      birth: () => ok({ sessionId: "fresh", workspaceRef: "workspace:1" }),
      discover: async () => ok(LOCATION),
      waitUntilReady: async () => err(new Error("composer unavailable")),
      prefill: () => { prefills += 1; return ok(undefined); },
    });
    expect(readinessCode).toBe(1);
    expect(prefills).toBe(0);
    expect(messages.at(-1)).toContain("composer readiness failed");

    const prefillCode = await startCommand([], {
      birth: () => ok({ sessionId: "fresh", workspaceRef: "workspace:1" }),
      discover: async () => ok(LOCATION),
      waitUntilReady: async () => ok(undefined),
      prefill: () => err(new Error("send rejected")),
    });
    expect(prefillCode).toBe(1);
    expect(messages.at(-1)).toContain("composer prefill failed");
  } finally {
    errorSpy.mockRestore();
  }
});
