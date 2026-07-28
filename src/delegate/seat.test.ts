import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Write one native agent definition — frontmatter plus role prompt — into a fresh agents root. */
function fixture(name: string, definition: string): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-agents-"));
  roots.push(root);
  writeFileSync(join(root, `${name}.md`), definition);
  return root;
}

const PRIMARY_REVIEW = `---
name: primary-review
description: Primary implementation review
tools: ["Bash", "Read"]
model: gpt-5.6-sol
effort: high
fallback_model: gpt-5.6-terra
fallback_effort: xhigh
skills: ["review"]
---

Review the implementation.
`;

describe("loadSeat", () => {
  test("loads the route, the optional fallback, and the body as the role prompt", () => {
    const result = loadSeat(fixture("primary-review", PRIMARY_REVIEW), "primary-review");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: "primary-review",
      description: "Primary implementation review",
      tools: ["Bash", "Read"],
      model: "gpt-5.6-sol",
      effort: "high",
      fallback: { model: "gpt-5.6-terra", effort: "xhigh" },
      skills: ["review"],
      permissionMode: null,
      prompt: "Review the implementation.",
    });
  });

  test("a definition without fallback keys loads with no fallback route", () => {
    const root = fixture("implementer", `---
name: implementer
description: Implement a specified change
tools: ["Bash", "Read", "Edit"]
model: gpt-5.6-sol
effort: medium
---

Implement exactly what the task specifies.
`);
    const result = loadSeat(root, "implementer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fallback).toBeNull();
  });

  test("keys ccs does not know are ignored, not errors", () => {
    // The whole premise of one file for both readers: Claude Code tolerates ccs-only keys, and ccs
    // must tolerate everything else a definition carries — including nested maps.
    const root = fixture("designer", `---
name: designer
description: Product and visual taste
tools: ["Read", "Write"]
model: claude-fable-5
effort: high
color: purple
proactive: true
metadata:
  owner: milad
  tiers:
    - one
    - two
---

Design the surface.
`);
    const result = loadSeat(root, "designer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("claude-fable-5");
    expect(result.value.prompt).toBe("Design the surface.");
  });

  test("accepts Claude Code's comma-separated tools and skills spelling", () => {
    const root = fixture("fact-shaped", `---
name: fact-shaped
description: Comma-separated lists
tools: Bash, Read, Skill
model: claude-sonnet-5
effort: low
skills: antigravity, browser-use
---

Check the fact.
`);
    const result = loadSeat(root, "fact-shaped");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools).toEqual(["Bash", "Read", "Skill"]);
    expect(result.value.skills).toEqual(["antigravity", "browser-use"]);
  });

  test("carries permission_mode through as an embodiment posture", () => {
    const root = fixture("bulk-grinder", `---
name: bulk-grinder
description: Mechanical grinding
tools: ["Bash"]
model: gpt-5.6-terra
effort: medium
permission_mode: bypassPermissions
---

Grind the list.
`);
    const result = loadSeat(root, "bulk-grinder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionMode).toBe("bypassPermissions");
  });

  test("rejects a missing required key, half a fallback, and an unknown effort", () => {
    const missingModel = fixture("broken", `---
name: broken
description: No model
tools: ["Bash"]
effort: high
---

Body.
`);
    expect(loadSeat(missingModel, "broken").ok).toBe(false);

    const halfFallback = fixture("broken", `---
name: broken
description: Half a fallback
tools: ["Bash"]
model: gpt-5.6-sol
effort: high
fallback_model: gpt-5.6-terra
---

Body.
`);
    const half = loadSeat(halfFallback, "broken");
    expect(half.ok).toBe(false);
    if (half.ok) return;
    expect(half.error.message).toContain("fallback_model and fallback_effort together");

    const badEffort = fixture("broken", `---
name: broken
description: Unknown effort
tools: ["Bash"]
model: gpt-5.6-sol
effort: ultra
---

Body.
`);
    expect(loadSeat(badEffort, "broken").ok).toBe(false);
  });

  test("rejects a definition whose name differs from its filename", () => {
    const root = fixture("architect", `---
name: other
description: Architecture
tools: ["Read"]
model: claude-fable-5
effort: high
---

Design it.
`);
    const result = loadSeat(root, "architect");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not match file");
  });

  test("rejects a file with no frontmatter and one with an empty role prompt", () => {
    const noFrontmatter = fixture("plain", "Just a markdown file.\n");
    const plain = loadSeat(noFrontmatter, "plain");
    expect(plain.ok).toBe(false);
    if (plain.ok) return;
    expect(plain.error.message).toContain("no YAML frontmatter");

    const emptyBody = fixture("hollow", `---
name: hollow
description: No prompt
tools: ["Bash"]
model: gpt-5.6-sol
effort: high
---

`);
    const hollow = loadSeat(emptyBody, "hollow");
    expect(hollow.ok).toBe(false);
    if (hollow.ok) return;
    expect(hollow.error.message).toContain("empty role prompt");
  });

  test("rejects path traversal before reading", () => {
    expect(loadSeat("/tmp", "../secret").ok).toBe(false);
  });
});

describe("routing and compilation", () => {
  test("normalizes the GPT context marker exactly once and only for gpt-*", () => {
    expect(normalizeGptModel("gpt-5.6-sol")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol[1m]");
    expect(normalizeGptModel("claude-fable-5")).toBe("claude-fable-5");
    expect(normalizeGptModel("claude-opus-5")).toBe("claude-opus-5");
  });

  test("compiles primary and fallback with their route-local models and efforts", () => {
    const loaded = loadSeat(fixture("primary-review", PRIMARY_REVIEW), "primary-review");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const primary = resolveSeatRoute(loaded.value);
    expect(primary).toEqual({
      ok: true,
      value: {
        route: "primary",
        provider: "gpt",
        launcher: "claudex",
        requestedModel: "gpt-5.6-sol",
        compiledModel: "gpt-5.6-sol[1m]",
        effort: "high",
      },
    });

    const fallback = resolveSeatRoute(loaded.value, "fallback");
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.value).toMatchObject({
      route: "fallback",
      compiledModel: "gpt-5.6-terra[1m]",
      effort: "xhigh",
    });
    expect(compileAgent(loaded.value, fallback.value)).toEqual({
      "primary-review": {
        description: "Primary implementation review",
        prompt: "Review the implementation.",
        tools: ["Bash", "Read"],
        model: "gpt-5.6-terra[1m]",
        skills: ["review"],
        effort: "xhigh",
      },
    });
  });

  test("routes a Claude model through the same both-vendor launcher, unsuffixed", () => {
    const root = fixture("generalist", `---
name: generalist
description: Broad default seat
tools: ["Bash", "Read"]
model: claude-opus-5
effort: high
fallback_model: claude-fable-5
fallback_effort: high
permission_mode: bypassPermissions
---

Do the specified work.
`);
    const loaded = loadSeat(root, "generalist");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const fallback = resolveSeatRoute(loaded.value, "fallback");
    expect(fallback).toEqual({
      ok: true,
      value: {
        route: "fallback",
        provider: "claude",
        launcher: "claudex",
        requestedModel: "claude-fable-5",
        compiledModel: "claude-fable-5",
        effort: "high",
      },
    });
    if (!fallback.ok) return;
    expect(compileAgent(loaded.value, fallback.value)).toEqual({
      generalist: {
        description: "Broad default seat",
        prompt: "Do the specified work.",
        tools: ["Bash", "Read"],
        model: "claude-fable-5",
        permissionMode: "bypassPermissions",
        effort: "high",
      },
    });
  });

  test("refuses a fallback the definition never declared", () => {
    const root = fixture("utility", `---
name: utility
description: Mechanical glue
tools: ["Bash"]
model: gpt-5.6-luna
effort: low
---

Do the mechanical step.
`);
    const loaded = loadSeat(root, "utility");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(resolveSeatRoute(loaded.value).ok).toBe(true);
    const fallback = resolveSeatRoute(loaded.value, "fallback");
    expect(fallback.ok).toBe(false);
    if (fallback.ok) return;
    expect(fallback.error.message).toContain("does not declare a fallback route");
  });

  test("an empty tools list compiles to no tools key, inheriting every tool", () => {
    const root = fixture("wide-open", `---
name: wide-open
description: Every tool
tools: []
model: gpt-5.6-sol
effort: high
---

Use anything.
`);
    const loaded = loadSeat(root, "wide-open");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const route = resolveSeatRoute(loaded.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(compileAgent(loaded.value, route.value)["wide-open"]).not.toHaveProperty("tools");
  });
});
