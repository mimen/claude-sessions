import { describe, expect, test } from "bun:test";
import { claudeCodeModelId } from "../resume/role-model-launch.ts";
import {
  buildModelDeclarationsReport,
  expectedModelDeclaration,
  modelDeclarationsExitCode,
  renderModelDeclarationsReport,
  type ModelDeclaration,
} from "./model-declarations.ts";

function declaration(
  value: string,
  mode: ModelDeclaration["mode"] = "direct",
): ModelDeclaration {
  return {
    path: "/config",
    field: "model",
    surface: mode === "direct" ? "settings.model" : "routing.default_model",
    mode,
    value,
  };
}

describe("model declaration policy", () => {
  test("direct declarations agree with the runtime compiler for every context family", () => {
    for (const model of [
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-luna(xhigh)",
    ]) {
      expect(expectedModelDeclaration(declaration(model))).toBe(claudeCodeModelId(model));
    }
  });

  test("active declarations move Fable 5 compatibility IDs to Fable 5.1", () => {
    expect(expectedModelDeclaration(declaration("claude-fable-5"))).toBe("claude-fable-5-1[1m]");
    expect(expectedModelDeclaration(declaration("claude-fable-5", "canonical"))).toBe("claude-fable-5-1");
  });

  test("reports wrong window declarations and canonical routing markers", () => {
    const report = buildModelDeclarationsReport({
      declarations: [
        declaration("claude-opus-5"),
        declaration("claude-haiku-4-5[1m]"),
        declaration("gpt-5.6-sol[1m]"),
        declaration("claude-sonnet-5[1m]", "canonical"),
      ],
      memberships: [],
      behaviorMappings: [],
    });
    expect(report.findings.map((finding) => finding.expected)).toEqual([
      "claude-opus-5[1m]",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "claude-sonnet-5",
    ]);
    expect(modelDeclarationsExitCode(report)).toBe(1);
    expect(renderModelDeclarationsReport(report)).toContain("Nothing was changed.");
  });

  test("requires the default and picker models to be selectable", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [
        {
          path: "/settings.json",
          field: "availableModels",
          value: "claude-fable-5-1[1m]",
          values: ["gpt-5.6-sol"],
        },
      ],
      behaviorMappings: [],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "settings.availableModels",
        expected: "contains \"claude-fable-5-1[1m]\"",
      }),
    ]);
  });

  test("rejects GPT-5.6 picker mappings that force Claude Code back to 200K", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      pickerRows: [{
        path: "/settings.json",
        field: "modelPicker.options[0]",
        model: "gpt-5.6-sol",
        behavesAs: "claude-sonnet-5",
      }],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "settings.modelPicker.behavesAs",
        severity: "error",
      }),
    ]);
    expect(report.findings[0]!.expected).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
  });

  test("requires a behaves_as family's picker row to carry its donor", () => {
    const missing = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      pickerRows: [{
        path: "/settings.json",
        field: "modelPicker.options[0]",
        model: "grok-4.6",
        behavesAs: null,
      }],
    });
    expect(missing.findings[0]).toMatchObject({
      check: "settings.modelPicker.behavesAs",
      actual: "omitted",
      severity: "error",
    });

    const correct = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      pickerRows: [{
        path: "/settings.json",
        field: "modelPicker.options[0]",
        model: "grok-4.6",
        behavesAs: "claude-sonnet-5",
      }],
    });
    expect(correct.findings).toEqual([]);
  });

  test("an id no registry row claims is drift wherever it is declared", () => {
    const report = buildModelDeclarationsReport({
      declarations: [declaration("gpt-5.7-ghost")],
      memberships: [],
      behaviorMappings: [],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({ check: "model.unregistered", severity: "error" }),
    ]);
    // A Claude Code tier alias names a slot, not a model, and is not drift.
    expect(buildModelDeclarationsReport({
      declarations: [declaration("opus")],
      memberships: [],
      behaviorMappings: [],
    }).findings).toEqual([]);
  });

  test("a policy file naming an unregistered id warns rather than failing", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      pstack: [{ path: "/models.json", field: "panel[0]", value: "kimi-k3" }],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({ check: "policy.unregistered", severity: "warning" }),
    ]);
    expect(modelDeclarationsExitCode(report)).toBe(0);
  });

  test("a launcher whose serves globs miss a model the registry routes to it is drift", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      launchers: [{
        name: "claude-native",
        serves: ["anthropic.*"],
        modelEnvironmentKeys: [],
        path: "/launchers.toml",
      }],
    });
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) expect(finding.check).toBe("launcher.serves");
  });

  test("a fleet entry still spelling a slot the registry sets is a warning", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      launchers: [{
        name: "claudex",
        serves: ["*"],
        modelEnvironmentKeys: ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_MODEL"],
        path: "/launchers.toml",
      }],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "launcher.slot",
        field: "launcher.claudex.env.ANTHROPIC_DEFAULT_OPUS_MODEL",
        severity: "warning",
      }),
    ]);
  });

  test("an unreachable gateway warns; a gateway missing an active model does not", () => {
    const unreachable = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      gatewayModels: null,
    });
    expect(unreachable.findings).toEqual([
      expect.objectContaining({ check: "gateway.catalogue", severity: "warning" }),
    ]);
    expect(modelDeclarationsExitCode(unreachable)).toBe(0);

    const missing = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
      gatewayModels: ["gpt-5.6-sol"],
    });
    expect(missing.findings.every((finding) => finding.check === "gateway.catalogue")).toBe(true);
    expect(modelDeclarationsExitCode(missing)).toBe(1);
  });

  test("the accounted window of every model is reported as a note", () => {
    const report = buildModelDeclarationsReport({
      declarations: [],
      memberships: [],
      behaviorMappings: [],
    });
    // Grok is 500K upstream, accounted at the donor's 200K, and GPT-5.6 at the claudex envelope.
    expect(report.notes.some((note) => note.startsWith("grok-4.6 on claudex:"))).toBe(true);
    expect(report.notes.some((note) => note.includes("921000"))).toBe(true);
  });

  test("a coherent declaration set is clean", () => {
    const report = buildModelDeclarationsReport({
      declarations: [
        declaration("claude-fable-5-1[1m]"),
        declaration("claude-haiku-4-5"),
        declaration("gpt-5.6-sol"),
        declaration("claude-fable-5-1", "canonical"),
      ],
      memberships: [],
      behaviorMappings: [],
    });
    expect(report.findings).toEqual([]);
    expect(modelDeclarationsExitCode(report)).toBe(0);
  });
});
