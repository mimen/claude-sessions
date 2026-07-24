import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileAgent,
  loadSeat,
  normalizeGptModel,
  resolveSeatRoute,
} from "./seat.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, manifest: string, prompt = "Review the implementation."): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-seat-"));
  roots.push(root);
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "seat.toml"), manifest);
  writeFileSync(join(directory, "prompt.md"), prompt);
  return root;
}

const PRIMARY_REVIEW = `name = "primary-review"
description = "Primary implementation review"
tools = ["Bash", "Read"]
skills = ["review"]

[routing.primary]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-sol"
effort = "high"

[routing.fallback]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-terra"
effort = "xhigh"
`;

describe("loadSeat", () => {
  test("loads fixed primary and fallback routes from TOML plus prompt", () => {
    const root = fixture("primary-review", PRIMARY_REVIEW);

    const result = loadSeat(root, "primary-review");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe("Review the implementation.");
    expect(result.value.routing.primary.provider).toBe("gpt");
    expect(result.value.routing.fallback?.requested_model).toBe("gpt-5.6-terra");
  });

  test("rejects legacy inherited routes and top-level effort", () => {
    const root = fixture(
      "implementer",
      `name = "implementer"
description = "Implement a specified change"
effort = "medium"

[routing]
provider = "inherit_parent"
launcher = "inherit_parent"
requested_model = "opus"
`,
    );
    expect(loadSeat(root, "implementer").ok).toBe(false);
  });

  test("rejects a manifest whose name differs from its directory", () => {
    const root = fixture(
      "architect",
      `name = "other"
description = "Architecture"

[routing.primary]
provider = "claude"
launcher = "claude-native"
requested_model = "claude-fable-5"
effort = "high"
`,
    );
    const result = loadSeat(root, "architect");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not match directory");
  });

  test("rejects path traversal before reading", () => {
    expect(loadSeat("/tmp", "../secret").ok).toBe(false);
  });
});

describe("routing and compilation", () => {
  test("normalizes GPT model context marker exactly once", () => {
    expect(normalizeGptModel("gpt-5.6-sol")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("claude-fable-5")).toBe("claude-fable-5");
  });

  test("compiles primary and fallback with their route-local models and efforts", () => {
    const root = fixture("primary-review", PRIMARY_REVIEW, "Review focused code.");
    const loaded = loadSeat(root, "primary-review");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const primary = resolveSeatRoute(loaded.value);
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;
    expect(primary.value).toMatchObject({
      route: "primary",
      launcher: "claude-gpt",
      compiledModel: "gpt-5.6-sol[1m]",
      effort: "high",
    });

    const fallback = resolveSeatRoute(loaded.value, "fallback");
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.value).toMatchObject({
      route: "fallback",
      launcher: "claude-gpt",
      compiledModel: "gpt-5.6-terra[1m]",
      effort: "xhigh",
    });
    expect(compileAgent(loaded.value, fallback.value)).toEqual({
      "primary-review": {
        description: "Primary implementation review",
        prompt: "Review focused code.",
        tools: ["Bash", "Read"],
        model: "gpt-5.6-terra[1m]",
        skills: ["review"],
        effort: "xhigh",
      },
    });
  });

  test("compiles a native Fable-to-Opus fallback", () => {
    const root = fixture(
      "architect",
      `name = "architect"
description = "Design an architecture"

[routing.primary]
provider = "claude"
launcher = "claude-native"
requested_model = "claude-fable-5"
effort = "high"

[routing.fallback]
provider = "claude"
launcher = "claude-native"
requested_model = "claude-opus-4-8"
effort = "high"
`,
    );
    const loaded = loadSeat(root, "architect");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const fallback = resolveSeatRoute(loaded.value, "fallback");
    expect(fallback).toEqual({
      ok: true,
      value: {
        route: "fallback",
        provider: "claude",
        launcher: "claude-native",
        requestedModel: "claude-opus-4-8",
        compiledModel: "claude-opus-4-8",
        effort: "high",
      },
    });
  });

  test("rejects a provider-launcher mismatch and missing fallback route", () => {
    const root = fixture(
      "broken",
      `name = "broken"
description = "Broken route"

[routing.primary]
provider = "claude"
launcher = "claude-gpt"
requested_model = "claude-fable-5"
effort = "high"
`,
    );
    const loaded = loadSeat(root, "broken");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(resolveSeatRoute(loaded.value).ok).toBe(false);
    expect(resolveSeatRoute(loaded.value, "fallback").ok).toBe(false);
  });
});
