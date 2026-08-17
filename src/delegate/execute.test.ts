import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function agentsRoot(withFallback = true): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-delegate-"));
  roots.push(root);
  writeFileSync(
    join(root, "primary-review.md"),
    `---
name: primary-review
description: Independent primary review
tools: ["Bash", "Read"]
model: gpt-5.6-sol
effort: high
${withFallback ? `fallback_model: gpt-5.6-terra
fallback_effort: xhigh
` : ""}---

Review the specified implementation.
`,
  );
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
        CLAUDE_CODE_SUBAGENT_MODEL: "must-not-leak",
        CCS_CREATOR_KIND: "automation",
        CCS_CREATOR_REF: "imsg-server",
        HOME: "/tmp/ccs-test-home",
        PATH: "/raw-claude:/tmp/ccs-test-home/.ccs/bin:/usr/bin",
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
  test("reserves the primary causal child before launching an argv array", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        cwd: "/tmp",
        prompt: "Review this diff.\nKeep quotes like 'this' literal.",
        agentsRoot: agentsRoot(),
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
        route: "primary",
        provider: "gpt",
        launcher: "claudex",
        requestedModel: "gpt-5.6-sol",
        compiledModel: "gpt-5.6-sol",
        effort: "high",
      },
    ]);
    const argv = h.launches[0]!.argv;
    expect(argv[0]).toBe("claudex");
    expect(argv.slice(-2)).toEqual(["-p", "Review this diff.\nKeep quotes like 'this' literal."]);
    expect(argv).toContain("--agents");
    expect(argv).toContain("--agent");
    expect(argv).not.toContain("--bare");
    expect(h.launches[0]!.environment.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(h.launches[0]!.environment.CCS_CREATOR_KIND).toBeUndefined();
    expect(h.launches[0]!.environment.CCS_CREATOR_REF).toBeUndefined();
    expect(h.launches[0]!.environment.CCS_LAUNCH_PARENT_SESSION_ID).toBe(PARENT);
    expect(h.launches[0]!.environment.PATH?.split(":")[0]).toBe("/tmp/ccs-test-home/.ccs/bin");
  });

  test("selects the fallback route once with its model and effort", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        route: "fallback",
        cwd: "/tmp",
        prompt: "Review.",
        agentsRoot: agentsRoot(),
      },
      h.dependencies,
    );
    expect(result.ok).toBe(true);
    expect(h.events).toEqual(["reserve", "launch", "exit:0"]);
    expect(h.reservations[0]).toMatchObject({
      route: "fallback",
      requestedModel: "gpt-5.6-terra",
      compiledModel: "gpt-5.6-terra",
      effort: "xhigh",
    });
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.argv.join(" ")).toContain('"model":"gpt-5.6-terra"');
    expect(h.launches[0]!.argv.join(" ")).toContain('"effort":"xhigh"');
  });

  test("rejects a missing fallback before minting or reserving", () => {
    const h = harness();
    const result = executeDelegate(
      {
        seat: "primary-review",
        parentSessionId: PARENT,
        route: "fallback",
        cwd: "/tmp",
        prompt: "Review.",
        agentsRoot: agentsRoot(false),
      },
      h.dependencies,
    );
    expect(result.ok).toBe(false);
    expect(h.events).toEqual([]);
  });

  test("keeps the reservation and records a process startup failure", () => {
    const h = harness(err(new Error("launcher missing")));
    const result = executeDelegate(
      { seat: "primary-review", parentSessionId: PARENT, cwd: "/tmp", prompt: "Review.", agentsRoot: agentsRoot() },
      h.dependencies,
    );
    expect(result.ok).toBe(false);
    expect(h.events).toEqual(["reserve", "launch", "failed:launcher missing"]);
    expect(h.reservations).toHaveLength(1);
  });

  test("propagates a nonzero child exit without a hidden fallback retry", () => {
    const h = harness(ok({ exitCode: 17 }));
    const result = executeDelegate(
      { seat: "primary-review", parentSessionId: PARENT, cwd: "/tmp", prompt: "Review.", agentsRoot: agentsRoot() },
      h.dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(17);
    expect(h.events).toEqual(["reserve", "launch", "exit:17"]);
    expect(h.reservations).toHaveLength(1);
    expect(h.launches).toHaveLength(1);
  });

  test("launches a Claude-model seat on the same both-vendor launcher, window declared", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-delegate-"));
    roots.push(root);
    writeFileSync(
      join(root, "generalist.md"),
      `---
name: generalist
description: Broad default seat
tools: ["Bash", "Read"]
model: claude-opus-5
effort: high
---

Do the specified work.
`,
    );

    const h = harness();
    const result = executeDelegate(
      { seat: "generalist", parentSessionId: PARENT, cwd: "/tmp", prompt: "Go.", agentsRoot: root },
      h.dependencies,
    );
    expect(result.ok).toBe(true);
    expect(h.reservations[0]).toMatchObject({
      provider: "claude",
      launcher: "claudex",
      compiledModel: "claude-opus-5[1m]",
    });
    expect(h.launches[0]!.argv[0]).toBe("claudex");
    expect(h.launches[0]!.argv.join(" ")).toContain('"model":"claude-opus-5[1m]"');
  });

  test("rejects missing cwd and invalid input before minting or reserving", () => {
    const h = harness();
    const missingCwd = executeDelegate(
      { seat: "primary-review", parentSessionId: PARENT, cwd: "/missing", prompt: "Review.", agentsRoot: agentsRoot() },
      { ...h.dependencies, cwdExists: () => false },
    );
    expect(missingCwd.ok).toBe(false);
    expect(h.events).toEqual([]);

    const invalid = executeDelegate(
      { seat: "primary-review", parentSessionId: "not-a-uuid", cwd: "/tmp", prompt: "Review.", agentsRoot: agentsRoot() },
      h.dependencies,
    );
    expect(invalid.ok).toBe(false);
    expect(h.events).toEqual([]);
  });
});
