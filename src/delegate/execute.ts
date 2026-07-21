import { compileAgent, loadSeat, resolveSeatRoute, type ProviderFamily, type SeatEffort, type SeatRouteKind } from "./seat.ts";
import { err, ok, type Result } from "../result.ts";

export interface DelegateRequest {
  readonly seat: string;
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly seatsRoot: string;
  readonly route?: SeatRouteKind;
}

export interface DelegateReservation {
  readonly sessionId: string;
  readonly seat: string;
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly route: SeatRouteKind;
  readonly provider: ProviderFamily;
  readonly launcher: "claude-native" | "claude-gpt";
  readonly requestedModel: string;
  readonly compiledModel: string;
  readonly effort: SeatEffort;
}

export interface DelegateLaunchResult {
  readonly exitCode: number;
}

export interface DelegateDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  reserve(input: DelegateReservation): Result<void>;
  launch(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }): Result<DelegateLaunchResult>;
  recordExit(sessionId: string, exitCode: number): void;
  recordLaunchFailure(sessionId: string, message: string): void;
  cwdExists(path: string): boolean;
  mintSessionId(): string;
}

export interface DelegateExecution {
  readonly sessionId: string;
  readonly exitCode: number;
  readonly argv: readonly string[];
}

function cleanEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const cleaned: Record<string, string | undefined> = { ...environment };
  delete cleaned.CLAUDE_CODE_SUBAGENT_MODEL;
  return cleaned;
}

function validateRequest(request: DelegateRequest): Result<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.parentSessionId)) {
    return err(new Error(`Invalid parent session UUID: ${request.parentSessionId}`));
  }
  if (request.cwd.trim().length === 0) return err(new Error("Delegation cwd is required"));
  if (request.prompt.trim().length === 0) return err(new Error("Delegation prompt is required"));
  return ok(undefined);
}

export function executeDelegate(
  request: DelegateRequest,
  dependencies: DelegateDependencies,
): Result<DelegateExecution> {
  const valid = validateRequest(request);
  if (!valid.ok) return valid;
  if (!dependencies.cwdExists(request.cwd)) {
    return err(new Error(`Delegation cwd does not exist or is not a directory: ${request.cwd}`));
  }

  const loaded = loadSeat(request.seatsRoot, request.seat);
  if (!loaded.ok) return loaded;
  const route = request.route ?? "primary";
  const routed = resolveSeatRoute(loaded.value, route);
  if (!routed.ok) return routed;

  const sessionId = dependencies.mintSessionId();
  const reservation: DelegateReservation = {
    sessionId,
    seat: loaded.value.name,
    parentSessionId: request.parentSessionId,
    cwd: request.cwd,
    route: routed.value.route,
    provider: routed.value.provider,
    launcher: routed.value.launcher,
    requestedModel: routed.value.requestedModel,
    compiledModel: routed.value.compiledModel,
    effort: routed.value.effort,
  };
  const reserved = dependencies.reserve(reservation);
  if (!reserved.ok) return reserved;

  const argv = [
    routed.value.launcher,
    "--agents",
    JSON.stringify(compileAgent(loaded.value, routed.value)),
    "--agent",
    loaded.value.name,
    "--session-id",
    sessionId,
    "-p",
    request.prompt,
  ] as const;

  const launched = dependencies.launch({
    argv,
    cwd: request.cwd,
    environment: cleanEnvironment(dependencies.environment),
  });
  if (!launched.ok) {
    dependencies.recordLaunchFailure(sessionId, launched.error.message);
    return launched;
  }

  dependencies.recordExit(sessionId, launched.value.exitCode);
  return ok({ sessionId, exitCode: launched.value.exitCode, argv });
}
