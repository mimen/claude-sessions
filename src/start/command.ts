import { execFileSync } from "node:child_process";
import type { SurfaceLocation } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { workspaceForSessionFrom } from "../cmux/liveness.ts";
import {
  newSession,
  type LocalLaunchReceipt,
} from "../resume/new-session.ts";
import { err as resultErr, ok as resultOk, type Result } from "../result.ts";

const START_HELP = `ccs start — open a fresh launcher for /ccs:new

Usage:
  ccs start [initial text...]
  ccs start -- [initial text beginning with a dash...]

Creates one fresh CCS-managed top-level Claude session in the current directory, focuses its
new cmux workspace, waits for the empty composer, and pre-fills /ccs:new plus any supplied
text. It never submits Enter, routes the request, runs inference, resumes an idle session, or
executes the prompt.

Options:
  -h, --help    Show this help

The obsolete inference flags --dry-run and --explain are rejected. /ccs:new is the only router.
`;

const ROUTER_PREFIX = "/ccs:new ";
const LAUNCHER_TITLE = "/ccs:new launcher";
const DISCOVERY_TIMEOUT_MS = 20_000;
const READINESS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;

export interface LauncherBirthRequest {
  readonly topLevel: true;
  readonly cwd: string;
  readonly title: string;
  readonly focus: true;
}

export interface LauncherBirth {
  readonly sessionId: string;
  readonly workspaceRef: string;
}

export interface PollClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type WorkspaceLocator = (sessionId: string) => Result<SurfaceLocation | null>;
export type ComposerReader = (location: SurfaceLocation) => Result<string>;

export interface StartCommandDependencies {
  readonly cwd?: () => string;
  readonly birth?: (request: LauncherBirthRequest) => Result<LauncherBirth>;
  readonly discover?: (birth: LauncherBirth) => Promise<Result<SurfaceLocation>>;
  readonly waitUntilReady?: (location: SurfaceLocation) => Promise<Result<void>>;
  readonly prefill?: (location: SurfaceLocation, text: string) => Result<void>;
}

type StartInvocation =
  | { readonly mode: "help" }
  | { readonly mode: "launch"; readonly prefill: string };

const REAL_CLOCK: PollClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => Bun.sleep(milliseconds),
};

/** Deterministic interactive shortcut. /ccs:new remains the only routing surface. */
export async function startCommand(
  args: string[],
  dependencies: StartCommandDependencies = {},
): Promise<number> {
  const invocation = parseInvocation(args);
  if (!invocation.ok) {
    console.error(`ccs start: ${invocation.error.message}`);
    return 2;
  }
  if (invocation.value.mode === "help") {
    console.log(START_HELP);
    return 0;
  }

  const cwd = dependencies.cwd?.() ?? process.cwd();
  const birthRequest: LauncherBirthRequest = {
    topLevel: true,
    cwd,
    title: LAUNCHER_TITLE,
    focus: true,
  };
  const birth = (dependencies.birth ?? birthManagedLauncher)(birthRequest);
  if (!birth.ok) return stageFailure("managed birth", birth.error);

  const discovered = await (dependencies.discover ?? discoverLauncherWorkspace)(birth.value);
  if (!discovered.ok) return stageFailure("workspace discovery", discovered.error);

  const ready = await (dependencies.waitUntilReady ?? waitForComposerReady)(discovered.value);
  if (!ready.ok) return stageFailure("composer readiness", ready.error);

  const prefilled = (dependencies.prefill ?? prefillComposer)(discovered.value, invocation.value.prefill);
  if (!prefilled.ok) return stageFailure("composer prefill", prefilled.error);

  console.error(
    `ccs start: launcher ready in ${discovered.value.workspaceRef}; ` +
      "/ccs:new is prefilled and has not been submitted",
  );
  return 0;
}

function parseInvocation(args: readonly string[]): Result<StartInvocation> {
  const separator = args.indexOf("--");
  const optionsEnd = separator === -1 ? args.length : separator;
  const optionRegion = args.slice(0, optionsEnd);
  if (optionRegion.includes("--help") || optionRegion.includes("-h")) {
    return resultOk({ mode: "help" });
  }
  for (const obsolete of ["--dry-run", "--explain"]) {
    if (optionRegion.includes(obsolete)) {
      return resultErr(new Error(
        `${obsolete} is obsolete; /ccs:new is the only router and ccs start never runs inference`,
      ));
    }
  }

  const textArgs = separator === -1
    ? [...args]
    : [...args.slice(0, separator), ...args.slice(separator + 1)];
  const prefill = `${ROUTER_PREFIX}${textArgs.join(" ")}`;
  const safe = validatePrefillText(prefill);
  return safe.ok ? resultOk({ mode: "launch", prefill }) : safe;
}

/** Launch through the established managed session-new path and observe its exact local receipt. */
export function birthManagedLauncher(request: LauncherBirthRequest): Result<LauncherBirth> {
  const observed: { receipt?: LocalLaunchReceipt } = {};
  let exitCode: number;
  try {
    exitCode = newSession([
      "--top-level",
      "--cwd",
      request.cwd,
      "--title",
      request.title,
    ], undefined, {
      focus: request.focus,
      onLocalLaunch: (receipt) => { observed.receipt = receipt; },
    });
  } catch {
    return resultErr(new Error("the managed session-new path threw before returning a launch receipt"));
  }

  if (exitCode !== 0) {
    return resultErr(new Error(
      observed.receipt?.error ?? `the managed session-new path exited ${exitCode}`,
    ));
  }
  const receipt = observed.receipt;
  if (!receipt) return resultErr(new Error("the managed session-new path returned no local launch receipt"));
  if (receipt.status !== "launched" || !receipt.workspace_ref) {
    return resultErr(new Error(receipt.error ?? "cmux did not return a workspace reference"));
  }
  return resultOk({ sessionId: receipt.session_id, workspaceRef: receipt.workspace_ref });
}

/** Wait until cmux binds the fresh session UUID to its exact live surface. */
export async function discoverLauncherWorkspace(
  birth: LauncherBirth,
  locator: WorkspaceLocator = locateLiveWorkspace,
  clock: PollClock = REAL_CLOCK,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<Result<SurfaceLocation>> {
  const deadline = clock.now() + timeoutMs;
  let lastError: Error | null = null;
  while (true) {
    const located = locator(birth.sessionId);
    if (located.ok && located.value) return resultOk(located.value);
    if (!located.ok) lastError = located.error;
    if (clock.now() >= deadline) {
      const detail = lastError ? `; last probe failed: ${lastError.message}` : "";
      return resultErr(new Error(
        `fresh session ${birth.sessionId} never appeared on a live cmux surface ` +
          `(birth workspace ${birth.workspaceRef})${detail}`,
      ));
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}

function locateLiveWorkspace(sessionId: string): Result<SurfaceLocation | null> {
  try {
    const bridge = liveBridge();
    if (!bridge.readable) return resultErr(new Error("cmux tree or Claude hook state is unreadable"));
    return resultOk(workspaceForSessionFrom(bridge, sessionId));
  } catch {
    return resultErr(new Error("cmux workspace lookup failed"));
  }
}

/** Wait for the fresh Claude surface to expose an empty composer before typing into it. */
export async function waitForComposerReady(
  location: SurfaceLocation,
  reader: ComposerReader = readComposer,
  clock: PollClock = REAL_CLOCK,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<Result<void>> {
  const deadline = clock.now() + timeoutMs;
  let lastError: Error | null = null;
  while (true) {
    const screen = reader(location);
    if (screen.ok && composerIsReady(screen.value)) return resultOk(undefined);
    if (!screen.ok) lastError = screen.error;
    if (clock.now() >= deadline) {
      const detail = lastError ? `; last read failed: ${lastError.message}` : "";
      return resultErr(new Error(
        `Claude composer did not become ready on ${location.surfaceRef}${detail}`,
      ));
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}

function readComposer(location: SurfaceLocation): Result<string> {
  const cmux = process.env.CMUX_BIN ?? "cmux";
  try {
    const output = execFileSync(cmux, [
      "read-screen",
      "--surface",
      location.surfaceId,
      "--window",
      location.windowId,
      "--lines",
      "40",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    return resultOk(output);
  } catch {
    return resultErr(new Error(`could not read ${location.surfaceRef}`));
  }
}

/** Claude's empty input row is the readiness evidence required before prefill. */
export function composerIsReady(screen: string): boolean {
  const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return plain.split(/\r?\n/).some((line) => /^\s*❯\s*$/.test(line));
}

/** The one and only composer mutation: one literal send call, with no submit key. */
export function prefillComposer(location: SurfaceLocation, text: string): Result<void> {
  const safe = validatePrefillText(text);
  if (!safe.ok) return safe;
  const cmux = process.env.CMUX_BIN ?? "cmux";
  try {
    execFileSync(cmux, composerPrefillArgs(location, text), {
      stdio: "ignore",
      timeout: 5_000,
    });
    return resultOk(undefined);
  } catch {
    return resultErr(new Error(`cmux send failed for ${location.surfaceRef}`));
  }
}

export function composerPrefillArgs(
  location: Pick<SurfaceLocation, "surfaceId" | "windowId">,
  text: string,
): string[] {
  return [
    "send",
    "--surface",
    location.surfaceId,
    "--window",
    location.windowId,
    "--",
    text,
  ];
}

/** Reject input that cmux send would reinterpret as Enter, Tab, or another control key. */
export function validatePrefillText(text: string): Result<void> {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return resultErr(new Error("initial text contains a control character that cannot be prefilled without a key event"));
    }
  }
  if (/\\[nrt]/.test(text)) {
    return resultErr(new Error(
      "initial text contains a cmux escape (\\n, \\r, or \\t) that would synthesize a key event",
    ));
  }
  return resultOk(undefined);
}

function stageFailure(stage: string, error: Error): number {
  console.error(`ccs start: ${stage} failed: ${error.message}`);
  return 1;
}
