import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileAgent,
  inferParentProvider,
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

describe("loadSeat", () => {
  test("loads a fixed GPT seat from TOML plus prompt", () => {
    const root = fixture(
      "primary-review",
      `name = "primary-review"
description = "Primary implementation review"
tools = ["Bash", "Read"]
effort = "high"
skills = ["review"]

[routing]
provider = "gpt"
launcher = "claude-gpt"
requested_model = "gpt-5.6-sol"
`,
    );

    const result = loadSeat(root, "primary-review");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe("Review the implementation.");
    expect(result.value.routing.provider).toBe("gpt");
  });

  test("rejects a manifest whose name differs from its directory", () => {
    const root = fixture(
      "architect",
      `name = "other"
description = "Architecture"
[routing]
provider = "claude"
launcher = "claude-native"
requested_model = "claude-fable-5"
`,
    );
    const result = loadSeat(root, "architect");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not match directory");
  });

  test("rejects path traversal before reading", () => {
    const result = loadSeat("/tmp", "../secret");
    expect(result.ok).toBe(false);
  });
});

describe("routing and compilation", () => {
  test("normalizes GPT model context marker exactly once", () => {
    expect(normalizeGptModel("gpt-5.6-sol")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("claude-fable-5")).toBe("claude-fable-5");
  });

  test("infers gateway-backed parent provider", () => {
    expect(inferParentProvider({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" })).toBe("gpt");
    expect(inferParentProvider({ ANTHROPIC_BASE_URL: "http://localhost:8317/v1" })).toBe("gpt");
    expect(inferParentProvider({})).toBe("claude");
  });

  test("resolves inherit-parent routes and compiles only Claude agent fields", () => {
    const root = fixture(
      "implementer",
      `name = "implementer"
description = "Implement a specified change"
tools = ["Read", "Edit", "Write", "Bash"]
effort = "medium"
permission_mode = "acceptEdits"
skills = ["testing"]

[routing]
provider = "inherit_parent"
launcher = "inherit_parent"
requested_model = "opus"
`,
      "Write focused code.",
    );
    const loaded = loadSeat(root, "implementer");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const route = resolveSeatRoute(loaded.value, "gpt");
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.value.launcher).toBe("claude-gpt");
    expect(route.value.compiledModel).toBe("opus");
    expect(compileAgent(loaded.value, route.value)).toEqual({
      implementer: {
        description: "Implement a specified change",
        prompt: "Write focused code.",
        tools: ["Read", "Edit", "Write", "Bash"],
        model: "opus",
        permissionMode: "acceptEdits",
        skills: ["testing"],
        effort: "medium",
      },
    });
  });

  test("rejects a provider-launcher mismatch", () => {
    const root = fixture(
      "broken",
      `name = "broken"
description = "Broken route"
[routing]
provider = "claude"
launcher = "claude-gpt"
requested_model = "claude-fable-5"
`,
    );
    const loaded = loadSeat(root, "broken");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const route = resolveSeatRoute(loaded.value, "claude");
    expect(route.ok).toBe(false);
  });
});
