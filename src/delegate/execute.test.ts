import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../result.ts";
import {
  executeDelegate,
  type DelegateDependencies,
  type DelegateLaunchResult,
  type DelegateReservation,
} from "./execute.ts";

const PARENT = "754b9a1a-e5e0-49b7-8e45-d433e82621bf";
const CHILD = "9b668ac2-1891-4b7b-9baf-1dafa4bd8953";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seatsRoot(provider: "fixed" | "inherit" = "fixed"): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-delegate-"));
  roots.push(root);
  const directory = join(root, "primary-review");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "seat.toml"),
    provider === "fixed"
      ? `name = "primary-review"
description = "Independent primary review"
tools = ["Bash", "Read"]
effort = "high"

[routing]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-sol"
`
      : `name = "primary-review"
description = "Inherited capability review"
tools = ["Bash", "Read"]
effort = "medium"

[routing]
provider = "inherit_parent"
launcher = "inherit_parent"
requested_model = "opus"
`,
  );
  writeFileSync(join(directory, "prompt.md"), "Review the specified implementation.");
  return root;
}

interface Harness {
  readonly dependencies: DelegateDependencies;
  readonly events: string[];
  readonly reservations: DelegateReservation[];
  readonly launches: Array<{
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }>;
}

function harness(launchResult: Result<DelegateLaunchResult> = ok({ exitCode: 0 })): Harness {
  const events: string[] = [];
  const reservations: DelegateReservation[] = [];
  const launches: Harness["launches"] = [];
  return {
    events,
    reservations,
    launches,
    dependencies: {
      environment: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        CLAUDE_CODE_SUBAGENT_MODEL: "must-not-leak",
      },
      mintSessionId: () => CHILD,
      cwdExists: () => true,
      reserve: (input) => {
        events.push("reserve");
        reservations.push(input);
        return ok(undefined);
      },
      launch: (input) => {
        events.push("launch");
        launches.push(input);
        return launchResult;
      },
      recordExit: (_sessionId, exitCode) => events.push(`exit:${exitCode}`),
      recordLaunchFailure: (_sessionId, message) => events.push(`failed:${message}`),
    },
  };
}

describe("executeDelegate", () => {
  test("reserves the causal child before launching an argv array", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/tmp",
        prompt: "Review this diff.\nKeep quotes like 'this' literal.",
        seatsRoot: seatsRoot(),
      },
      h.dependencies,
    );

    expect(result.ok).toBe(true);
    expect(h.events).toEqual(["reserve", "launch", "exit:0"]);
    expect(h.reservations).toEqual([
      {
        sessionId: CHILD,
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/tmp",
        provider: "gpt",
        launcher: "claude-gpt",
        requestedModel: "gpt-5.6-sol",
        compiledModel: "gpt-5.6-sol[1m]",
      },
    ]);
    const argv = h.launches[0]!.argv;
    expect(argv[0]).toBe("claude-gpt");
    expect(argv.slice(-2)).toEqual(["-p", "Review this diff.\nKeep quotes like 'this' literal."]);
    expect(argv).toContain("--agents");
    expect(argv).toContain("--agent");
    expect(argv).not.toContain("--bare");
    expect(h.launches[0]!.environment.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  test("keeps the reservation and records a process startup failure", () => {
    const h = harness(err(new Error("launcher missing")));
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/tmp",
        prompt: "Review.",
        seatsRoot: seatsRoot(),
      },
      h.dependencies,
    );

    expect(result.ok).toBe(false);
    expect(h.events).toEqual(["reserve", "launch", "failed:launcher missing"]);
    expect(h.reservations).toHaveLength(1);
  });

  test("propagates the child exit status", () => {
    const h = harness(ok({ exitCode: 17 }));
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/tmp",
        prompt: "Review.",
        seatsRoot: seatsRoot(),
      },
      h.dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(17);
    expect(h.events).toEqual(["reserve", "launch", "exit:17"]);
  });

  test("rejects inherit-parent routing when an explicit parent's provider is unavailable", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        parentProvider: null,
        cwd: "/tmp",
        prompt: "Review.",
        seatsRoot: seatsRoot("inherit"),
      },
      h.dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Cannot resolve provider for explicit parent");
    expect(h.events).toEqual([]);
  });

  test("rejects a missing cwd before minting or reserving", () => {
    const h = harness();
    const dependencies: DelegateDependencies = { ...h.dependencies, cwdExists: () => false };
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/missing",
        prompt: "Review.",
        seatsRoot: seatsRoot(),
      },
      dependencies,
    );
    expect(result.ok).toBe(false);
    expect(h.events).toEqual([]);
  });

  test("rejects invalid input before minting or reserving", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: "not-a-uuid",
        cwd: "/tmp",
        prompt: "Review.",
        seatsRoot: seatsRoot(),
      },
      h.dependencies,
    );
    expect(result.ok).toBe(false);
    expect(h.events).toEqual([]);
  });
});
