import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getRow, lifecycleOf, openCatalogue } from "../catalogue/db.ts";
import type { SurfaceLocation } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { workspaceForSessionFrom } from "../cmux/liveness.ts";
import { loadConfig } from "../config.ts";
import { reindexStore, sessionById } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir, expandHome } from "../paths.ts";
import { newSession } from "../resume/new-session.ts";
import { loadLaunchers } from "../resume/launchers.ts";
import { resumeSessionEntry } from "../resume/resume-session.ts";
import { scanStore } from "../store.ts";
import { buildStartCandidates, type StartCandidates } from "./candidates.ts";
import { buildStartChoices, choiceDetail, choiceLabel, type StartChoice } from "./choices.ts";
import { routeStart, type StartRouteDecision } from "./gateway.ts";

export const START_AUTO_CONFIDENCE = 0.8;

type StartMode = "execute" | "dry-run" | "explain";

interface StartInvocation {
  readonly descriptionArgs: readonly string[];
  readonly mode: StartMode;
}

export interface StartCommandDependencies {
  readonly loadCandidates?: (description: string) => Promise<StartCandidates>;
  readonly route?: typeof routeStart;
  readonly execute?: (choice: StartChoice, description: string) => Promise<number>;
}

/** Natural-language entry point that routes to a managed resume or managed new-session birth. */
export async function startCommand(
  args: string[],
  dependencies: StartCommandDependencies = {},
): Promise<number> {
  const invocation = parseInvocation(args);
  const description = await descriptionFrom(invocation.descriptionArgs);
  if (!description) return 2;

  let candidates: StartCandidates;
  try {
    candidates = await (dependencies.loadCandidates ?? loadStartCandidates)(description);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`ccs start: ${detail}`);
    return 1;
  }
  process.stderr.write("ccs start: routing…\n");
  const routed = await (dependencies.route ?? routeStart)({ description, candidates });
  const decision = routed.ok ? routed.value : fallbackDecision(candidates, routed.error);
  if (!routed.ok) console.error(`ccs start: ${routed.error.message}`);

  const choices = buildStartChoices(decision, candidates);
  const recommended = choices[0];
  if (!recommended) {
    console.error("ccs start: no resumable sessions or valid project directories were found");
    return 1;
  }

  const aboveAutoThreshold = decision.confidence >= START_AUTO_CONFIDENCE
    && decision.action !== "ask_directory";
  const autoEligible = aboveAutoThreshold && autoChoiceStillEligible(recommended);
  if (invocation.mode !== "execute") {
    printPreview(invocation.mode, decision, recommended, choices, candidates, autoEligible);
    return 0;
  }

  const execute = dependencies.execute ?? executeChoice;
  if (autoEligible) {
    console.error(`ccs start: ${decision.reason} (${Math.round(decision.confidence * 100)}% confidence)`);
    return execute(recommended, description);
  }
  if (aboveAutoThreshold) {
    console.error("ccs start: the recommended target changed while routing; confirmation is now required");
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`ccs start: confirmation required below ${Math.round(START_AUTO_CONFIDENCE * 100)}% confidence`);
    console.error(`Recommendation: ${choiceLabel(recommended)} — ${choiceDetail(recommended)}`);
    return 1;
  }

  console.log(`\nRecommendation: ${decision.reason} (${Math.round(decision.confidence * 100)}% confidence)\n`);
  const selected = await promptForChoice(choices);
  if (!selected) {
    console.error("ccs start: cancelled");
    return 0;
  }
  return execute(selected, description);
}

function parseInvocation(args: readonly string[]): StartInvocation {
  const explain = args.includes("--explain");
  const dryRun = args.includes("--dry-run");
  return {
    mode: explain ? "explain" : dryRun ? "dry-run" : "execute",
    descriptionArgs: args.filter((arg) => arg !== "--dry-run" && arg !== "--explain"),
  };
}

async function loadStartCandidates(description: string): Promise<StartCandidates> {
  ensureDataDir();
  const configResult = loadConfig();
  if (!configResult.ok) throw configResult.error;

  const indexDb = openIndex(DB_PATH());
  const catalogueDb = openCatalogue(CATALOGUE_PATH());
  try {
    const scan = scanStore(configResult.value.store.path);
    if (scan.ok) {
      await reindexStore(indexDb, scan.value, configResult.value.host.label);
    } else {
      console.error(`ccs start: index refresh skipped: ${scan.error.message}`);
    }
    return buildStartCandidates(indexDb, catalogueDb, description, process.cwd());
  } finally {
    indexDb.close();
    catalogueDb.close();
  }
}

function printPreview(
  mode: Exclude<StartMode, "execute">,
  decision: StartRouteDecision,
  recommended: StartChoice,
  choices: readonly StartChoice[],
  candidates: StartCandidates,
  autoEligible: boolean,
): void {
  console.log(`ccs start ${mode === "explain" ? "explain" : "dry-run"}`);
  console.log(`route: ${decision.action}`);
  console.log(`confidence: ${Math.round(decision.confidence * 100)}%`);
  console.log(`reason: ${decision.reason}`);
  console.log(`recommendation: ${choiceLabel(recommended)}`);
  console.log(`target: ${choiceDetail(recommended)}`);
  console.log(`execution: ${autoEligible ? "would auto-launch" : "would require confirmation"}`);
  console.log("session side effects: none");
  if (mode !== "explain") return;

  console.log(
    `candidates: ${candidates.autoResumeSessions.length} active sessions, ` +
      `${candidates.manualOnlySessions.length} manual-only sessions, ${candidates.projects.length} projects`,
  );
  for (const [index, choice] of choices.entries()) {
    console.log(`${index + 1}. ${choiceLabel(choice)} — ${choiceDetail(choice)}`);
  }
}

async function descriptionFrom(args: readonly string[]): Promise<string | null> {
  const supplied = args.join(" ").trim();
  if (supplied) return supplied;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("usage: ccs start [description...] (description is required without a TTY)");
    return null;
  }
  const answer = await promptLine("What are you about to work on? ");
  if (!answer.trim()) {
    console.error("ccs start: description cannot be empty");
    return null;
  }
  return answer.trim();
}

async function promptForChoice(choices: readonly StartChoice[]): Promise<StartChoice | null> {
  choices.forEach((choice, index) => {
    const recommended = index === 0 ? "  recommended" : "";
    console.log(`${index + 1}. ${choiceLabel(choice)}${recommended}`);
    console.log(`   ${choiceDetail(choice)}`);
  });
  while (true) {
    const answer = (await promptLine("\nChoose [1, q to cancel]: ")).trim().toLowerCase();
    if (answer === "q" || answer === "quit") return null;
    if (answer === "") return choices[0] ?? null;
    const index = Number.parseInt(answer, 10) - 1;
    const selected = choices[index];
    if (selected) return selected;
    console.error(`Enter a number from 1 to ${choices.length}, or q.`);
  }
}

async function executeChoice(choice: StartChoice, description: string): Promise<number> {
  switch (choice.kind) {
    case "new":
      return newSession([
        "--top-level",
        "--cwd",
        choice.project.path,
        "--prompt",
        safeTrailingPrompt(description),
      ]);
    case "directory": {
      const directory = await promptForDirectory();
      if (!directory) {
        console.error("ccs start: cancelled");
        return 0;
      }
      return newSession([
        "--top-level",
        "--cwd",
        directory,
        "--prompt",
        safeTrailingPrompt(description),
      ]);
    }
    case "resume":
      return resumeChoice(choice, description);
  }
}

function autoChoiceStillEligible(choice: StartChoice): boolean {
  if (choice.kind === "directory") return false;
  if (choice.kind === "new") return verifiedDirectory(choice.project.path) !== null;
  return readAutoResumeEligibility(choice.session.id);
}

/** Fail closed when the final catalogue read cannot prove automatic-resume eligibility. */
export function readAutoResumeEligibility(
  sessionId: string,
  openDatabase: () => Database = () => openCatalogue(CATALOGUE_PATH()),
): boolean {
  let catalogueDb: Database | null = null;
  try {
    catalogueDb = openDatabase();
    return autoResumeStillEligible(catalogueDb, sessionId);
  } catch {
    return false;
  } finally {
    catalogueDb?.close();
  }
}

/** Revalidate the active-work-only contract immediately before an automatic resume. */
export function autoResumeStillEligible(catalogueDb: Database, sessionId: string): boolean {
  const row = getRow(catalogueDb, sessionId);
  return row?.sessionClass === "work_body"
    && row.kind !== "loop"
    && lifecycleOf(row) === "idle";
}

function resumeChoice(choice: Extract<StartChoice, { readonly kind: "resume" }>, description: string): number {
  const launcherResult = loadLaunchers();
  if (!launcherResult.ok) {
    console.error(`ccs start: ${launcherResult.error.message}`);
    return 1;
  }
  const indexDb = openIndex(DB_PATH());
  const catalogueDb = openCatalogue(CATALOGUE_PATH());
  try {
    const row = sessionById(indexDb, choice.session.id);
    const result = resumeSessionEntry(indexDb, catalogueDb, choice.session.id, {
      focus: true,
      prompt: safeTrailingPrompt(description),
      launchers: launcherResult.value,
    });
    switch (result.status) {
      case "resumed":
        console.error(`ccs start: resumed ${choice.session.title}`);
        if (result.note) console.error(`ccs start: ${result.note}`);
        return 0;
      case "already-open": {
        const ids = row ? [row.sessionId, row.resumeId] : [choice.session.id];
        if (deliverToOpenSession(ids, description)) {
          console.error(`ccs start: submitted the description to ${choice.session.title}`);
          return 0;
        }
        console.error(`ccs start: ${choice.session.title} is already open, but its prompt could not be submitted`);
        return 1;
      }
      case "not-indexed":
        console.error(`ccs start: session ${choice.session.id} is no longer indexed`);
        return 1;
      case "spawn-failed":
        console.error(`ccs start: failed to spawn a workspace for ${choice.session.title}`);
        return 1;
      case "liveness-unreadable":
        console.error("ccs start: cmux liveness is unreadable; refusing to risk a duplicate resume");
        return 1;
      case "route-ineligible":
        console.error(`ccs start: no eligible launcher can resume this session: ${result.reason}`);
        return 1;
      case "unknown-launcher":
        console.error(`ccs start: configured launcher ${result.name} is unavailable`);
        return 1;
      case "cwd-unreadable":
        console.error(`ccs start: ${result.error}`);
        return 1;
    }
  } finally {
    indexDb.close();
    catalogueDb.close();
  }
}

function deliverToOpenSession(sessionIds: readonly string[], description: string): boolean {
  const bridge = liveBridge();
  if (!bridge.readable) return false;
  const location = sessionIds
    .map((sessionId) => workspaceForSessionFrom(bridge, sessionId))
    .find((candidate) => candidate !== null);
  if (!location) return false;
  const cmux = process.env.CMUX_BIN ?? "cmux";
  const submission = cmuxSubmissionText(description);
  if (!submission) return false;
  try {
    // Target the exact Claude surface: a workspace can contain unrelated terminal/browser panes.
    // The single final newline submits in the same call, so no half-entered prompt can remain.
    execFileSync(cmux, cmuxSendArgs(location, submission), {
      timeout: 5_000,
      stdio: "ignore",
    });
  } catch {
    return false;
  }
  try {
    execFileSync(cmux, ["select-workspace", "--workspace", location.workspaceRef, "--window", location.windowRef], {
      timeout: 3_000,
      stdio: "ignore",
    });
    execFileSync(cmux, [
      "focus-pane",
      "--pane",
      location.paneId,
      "--workspace",
      location.workspaceRef,
      "--window",
      location.windowRef,
    ], {
      timeout: 3_000,
      stdio: "ignore",
    });
    execFileSync(cmux, ["focus-window", "--window", location.windowRef], {
      timeout: 3_000,
      stdio: "ignore",
    });
  } catch {
    // Submission already succeeded; focusing is best-effort and must not turn success into failure.
  }
  return true;
}

export function cmuxSendArgs(
  location: Pick<SurfaceLocation, "surfaceRef" | "windowRef">,
  submission: string,
): string[] {
  return [
    "send",
    "--surface",
    location.surfaceRef,
    "--window",
    location.windowRef,
    "--",
    submission,
  ];
}

/** Keep free text positional even when it begins with a CLI flag token. */
export function safeTrailingPrompt(description: string): string {
  return description.startsWith("-") ? ` ${description}` : description;
}

/** Build one safe cmux payload containing exactly one final submit event. */
export function cmuxSubmissionText(description: string): string | null {
  const oneLine = description
    .replace(/[\r\n]+/g, " ")
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine ? `${oneLine}\n` : null;
}

async function promptForDirectory(): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  while (true) {
    const answer = (await promptLine("Directory (blank to cancel): ")).trim();
    if (!answer) return null;
    const directory = verifiedDirectory(resolve(expandHome(answer)));
    if (directory) return directory;
    console.error(`Not an existing directory: ${answer}`);
  }
}

async function promptLine(question: string): Promise<string> {
  const terminal = createInterface({ input, output });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

function fallbackDecision(candidates: StartCandidates, error: Error): StartRouteDecision {
  const current = candidates.projects.find((project) => project.source === "current") ?? candidates.projects[0];
  if (current) {
    return {
      action: "new",
      confidence: 0,
      reason: `Automatic routing unavailable; defaulting to ${current.name} for human confirmation`,
      sessionId: null,
      projectId: current.id,
      alternativeSessionIds: candidates.autoResumeSessions.slice(0, 3).map((session) => session.id),
    };
  }
  return {
    action: "ask_directory",
    confidence: 0,
    reason: `Automatic routing unavailable: ${error.message}`,
    sessionId: null,
    projectId: null,
    alternativeSessionIds: candidates.autoResumeSessions.slice(0, 3).map((session) => session.id),
  };
}

function verifiedDirectory(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
