import { describe, expect, test } from "bun:test";
import { parseDelegateArgs } from "./args.ts";

const PARENT = "754b9a1a-e5e0-49b7-8e45-d433e82621bf";

describe("parseDelegateArgs", () => {
  test("resolves dot from the parent session environment", () => {
    const result = parseDelegateArgs(
      ["primary-review", "--child-of", ".", "--cwd", "/repo", "--prompt", "Review this."],
      { CLAUDE_CODE_SESSION_ID: PARENT },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        seat: "primary-review",
        parentSessionId: PARENT,
        parentIsCurrent: true,
        cwd: "/repo",
        prompt: "Review this.",
        seatsRoot: null,
      },
    });
  });

  test("preserves multiline prompts as one argument", () => {
    const prompt = "Review this.\nReport findings only.";
    const result = parseDelegateArgs(
      ["primary-review", "--child-of", PARENT, "--cwd", "/repo", "--prompt", prompt],
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe(prompt);
  });

  test("accepts prompt values that begin with dashes and equals-style flags", () => {
    const dashed = parseDelegateArgs(
      ["primary-review", "--child-of", PARENT, "--cwd", "/repo", "--prompt", "--focus the API diff"],
      {},
    );
    expect(dashed.ok).toBe(true);
    if (!dashed.ok) return;
    expect(dashed.value.prompt).toBe("--focus the API diff");

    const inline = parseDelegateArgs(
      [`primary-review`, `--child-of=${PARENT}`, "--cwd=/repo", "--prompt=Review."],
      {},
    );
    expect(inline.ok).toBe(true);
  });

  test("requires an explicit causal parent", () => {
    expect(parseDelegateArgs(["primary-review", "--cwd", "/repo", "--prompt", "Review."], {}).ok).toBe(false);
  });

  test("dot fails outside a Claude parent session", () => {
    const result = parseDelegateArgs(
      ["primary-review", "--child-of", ".", "--cwd", "/repo", "--prompt", "Review."],
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("CLAUDE_CODE_SESSION_ID");
  });
});
