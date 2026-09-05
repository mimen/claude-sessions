import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRegistry, type ModelRegistry } from "../models/registry.ts";
import {
  launcherSettingsContents,
  opencodeModelMap,
  renderOpencodeConfig,
  renderT3ClientSettings,
  renderT3Settings,
  slotEnvironment,
  writeClientSurfaces,
} from "./model-surfaces.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): ModelRegistry {
  const loaded = loadModelRegistry(join(import.meta.dir, "..", "models", "fixtures", "models.toml"));
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

const OPENCODE = `{
  // a comment the generator has to survive
  "$schema": "https://opencode.ai/config.json",
  "theme": "kanagawa",
  "provider": {
    "cliproxyapi": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8317/v1" },
      "models": { "kimi-k3": { "name": "Kimi", "limit": { "context": 1, "output": 1 } } }
    },
    "other": { "npm": "keep-me" }
  }
}
`;

const T3_SETTINGS = JSON.stringify({
  backgroundActivity: true,
  providerInstances: {
    claudeAgent: {
      driver: "claudeAgent",
      config: { binaryPath: "/Users/x/.ccs/bin/claude", customModels: ["kimi-k3"], launchArgs: "" },
    },
    opencode: { driver: "opencode" },
  },
}, null, 2);

const T3_CLIENT = JSON.stringify({
  wordWrap: true,
  providerModelPreferences: {
    claudeAgent: { hiddenModels: [], modelOrder: ["gpt-5.6-sol", "kimi-k3"] },
  },
}, null, 2);

test("a launcher's settings carry only the models it hosts", () => {
  const contents = launcherSettingsContents(registry(), "claude-native");
  expect(contents).not.toBeNull();
  const parsed = JSON.parse(contents!) as {
    availableModels: string[];
    modelPicker: { replaceBuiltInOptions: boolean; options: { model: string }[] };
  };
  expect(parsed.modelPicker.replaceBuiltInOptions).toBe(true);
  expect(parsed.availableModels).toContain("claude-opus-5");
  expect(parsed.availableModels.some((model) => model.startsWith("gpt-"))).toBe(false);
  expect(parsed.availableModels.some((model) => model.includes("[1m]"))).toBe(false);
  expect(launcherSettingsContents(registry(), "no-such-launcher")).toBeNull();
});

test("tier slots become Claude Code environment keys with family-correct spellings", () => {
  expect(slotEnvironment(registry(), "claudex")).toEqual({
    ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "gpt-5.6-sol",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.6-luna(low)",
    CLAUDE_CODE_SUBAGENT_MODEL: "gpt-5.6-luna(xhigh)",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "921000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  });
  // claude-native clears every override and lets Claude Code's own defaults stand.
  expect(slotEnvironment(registry(), "claude-native")).toEqual({});
});

test("opencode keeps every unrelated key and takes its windows from the registry", () => {
  const rendered = renderOpencodeConfig(OPENCODE, registry());
  expect(rendered.ok).toBe(true);
  if (!rendered.ok || rendered.value === null) throw new Error("unreachable");
  const parsed = JSON.parse(rendered.value) as Record<string, unknown>;
  expect(parsed["theme"]).toBe("kanagawa");
  const provider = parsed["provider"] as Record<string, Record<string, unknown>>;
  expect(provider["other"]).toEqual({ npm: "keep-me" });
  expect(provider["cliproxyapi"]!["npm"]).toBe("@ai-sdk/openai-compatible");
  const models = provider["cliproxyapi"]!["models"] as Record<string, { limit: { context: number } }>;
  expect(models["kimi-k3"]).toBeUndefined();
  expect(models["gpt-5.6-sol"]!.limit.context).toBe(1050000);
  expect(models["claude-opus-5"]!.limit.context).toBe(1000000);
  // Historical rows keep old transcripts openable and default to 200K.
  expect(models["gpt-5.5"]!.limit.context).toBe(200000);
  expect(opencodeModelMap(registry())["grok-4.6"]!.name).toBe("Grok 4.6");

  const again = renderOpencodeConfig(rendered.value, registry());
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.value).toBe(rendered.value);
});

test("a config with no cliproxyapi provider is skipped, not invented", () => {
  const rendered = renderOpencodeConfig(`{"provider": {"other": {}}}`, registry());
  expect(rendered.ok).toBe(true);
  if (rendered.ok) expect(rendered.value).toBeNull();
});

test("T3 gets the gateway ids it does not already know, in registry order", () => {
  const rendered = renderT3Settings(T3_SETTINGS, registry());
  expect(rendered.ok).toBe(true);
  if (!rendered.ok || rendered.value === null) throw new Error("unreachable");
  const parsed = JSON.parse(rendered.value) as {
    backgroundActivity: boolean;
    providerInstances: Record<string, { driver: string; config?: { customModels?: string[]; binaryPath?: string } }>;
  };
  expect(parsed.backgroundActivity).toBe(true);
  expect(parsed.providerInstances["opencode"]).toEqual({ driver: "opencode" });
  expect(parsed.providerInstances["claudeAgent"]!.config!.binaryPath).toBe("/Users/x/.ccs/bin/claude");
  const custom = parsed.providerInstances["claudeAgent"]!.config!.customModels!;
  expect(custom[0]).toBe("gpt-5.6-sol");
  expect(custom.some((id) => id.startsWith("claude-"))).toBe(false);
  expect(custom).toContain("grok-4.6");

  const again = renderT3Settings(rendered.value, registry());
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.value).toBe(rendered.value);
});

test("T3's model order leads with the registry and keeps hand-added ids after it", () => {
  const rendered = renderT3ClientSettings(T3_CLIENT, registry());
  expect(rendered.ok).toBe(true);
  if (!rendered.ok || rendered.value === null) throw new Error("unreachable");
  const parsed = JSON.parse(rendered.value) as {
    wordWrap: boolean;
    providerModelPreferences: Record<string, { hiddenModels: string[]; modelOrder: string[] }>;
    favorites: { provider: string; model: string }[];
  };
  expect(parsed.wordWrap).toBe(true);
  expect(parsed.providerModelPreferences["claudeAgent"]!.hiddenModels).toEqual([]);
  const order = parsed.providerModelPreferences["claudeAgent"]!.modelOrder;
  expect(order[0]).toBe("claude-fable-5-1");
  expect(order[order.length - 1]).toBe("kimi-k3");
  // Stars are the /model rows: every picker=true registry model, other providers' stars kept.
  expect(parsed.favorites[0]).toEqual({ provider: "opencode", model: "opencode/x-preview" });
  const starred = parsed.favorites.filter((f) => f.provider === "claudeAgent").map((f) => f.model);
  expect(starred).toEqual(registry().model.filter((m) => m.picker && !m.replaced_by).map((m) => m.id));
  expect(starred).not.toContain("kimi-k3");

  const again = renderT3ClientSettings(rendered.value, registry());
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.value).toBe(rendered.value);
});

test("writing the client surfaces is idempotent and skips what this machine lacks", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-model-surfaces-"));
  roots.push(root);
  const paths = {
    opencodeConfig: join(root, "opencode.jsonc"),
    t3Settings: join(root, "settings.json"),
    t3ClientSettings: join(root, "client-settings.json"),
  };
  writeFileSync(paths.opencodeConfig, OPENCODE);
  writeFileSync(paths.t3Settings, T3_SETTINGS);

  const first = writeClientSurfaces(registry(), paths);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.written).toEqual([paths.opencodeConfig, paths.t3Settings]);
  expect(first.value.warnings).toEqual([`skipped ${paths.t3ClientSettings}: no such file on this machine`]);

  const before = readFileSync(paths.opencodeConfig, "utf8");
  const second = writeClientSurfaces(registry(), paths);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.written).toEqual([]);
  expect(readFileSync(paths.opencodeConfig, "utf8")).toBe(before);
});
