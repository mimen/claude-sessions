import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowlist,
  birthModelIds,
  claudeCodeDeclaration,
  colorOf,
  enrichModel,
  familyOf,
  isMarkerLauncher,
  launcherNames,
  loadModelRegistry,
  pickerRows,
  priceFor,
  shortOf,
  slots,
  type ModelRegistry,
} from "./registry.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "models.toml");

function fixture(): ModelRegistry {
  const loaded = loadModelRegistry(FIXTURE);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

function loadInline(text: string): ReturnType<typeof loadModelRegistry> {
  const path = join(mkdtempSync(join(tmpdir(), "ccs-models-")), "models.toml");
  writeFileSync(path, text);
  return loadModelRegistry(path);
}

const MINIMAL = `
version = 1

[[family]]
name = "gpt-5.6"
window = 921000
accounting = "envelope"
prefixes = ["gpt-5.6-"]

[[model]]
id = "gpt-5.6-sol"
family = "gpt-5.6"
provider = "codex"
launchers = ["claudex"]
label = "Sol 5.6"
short = "Sol"
color = "#4fb3a9"
birth = true
picker = true

[slots.claudex]
max_context = 921000
`;

test("the shipped registry loads and names its launchers", () => {
  const registry = fixture();
  expect(launcherNames(registry)).toEqual(["claudex", "claude-native"]);
  expect(enrichModel(registry)).toBe("gpt-5.6-sol(medium)");
  expect(slots(registry, "claudex")?.max_context).toBe(921000);
  expect(slots(registry, "claude-native")).toBeNull();
  expect(isMarkerLauncher(registry, "claudex")).toBe(true);
  expect(isMarkerLauncher(registry, "claude-native")).toBe(false);
});

test("Claude 5 rows carry the marker on claudex and stay bare on claude-native", () => {
  const registry = fixture();
  expect(claudeCodeDeclaration(registry, "claude-opus-5", "claudex")).toBe("claude-opus-5[1m]");
  expect(claudeCodeDeclaration(registry, "claude-opus-5", "claude-native")).toBe("claude-opus-5");
  expect(claudeCodeDeclaration(registry, "claude-haiku-4-5-20251001", "claudex"))
    .toBe("claude-haiku-4-5-20251001");
  // The effort suffix is a caller-side seam and survives canonicalization untouched.
  expect(claudeCodeDeclaration(registry, "gpt-5.6-luna(low)", "claudex")).toBe("gpt-5.6-luna(low)");
  expect(claudeCodeDeclaration(registry, "claude-opus-5[1m][1m]", "claudex")).toBe("claude-opus-5[1m]");
});

test("GPT picker rows carry no behavesAs and a behaves_as family carries its donor", () => {
  const registry = fixture();
  const rows = pickerRows(registry, "claudex");
  const gpt = rows.filter((row) => row.model.startsWith("gpt-"));
  expect(gpt.length).toBeGreaterThan(0);
  for (const row of gpt) expect(row.behavesAs).toBeUndefined();
  for (const row of rows.filter((entry) => entry.model.startsWith("glm-"))) {
    expect(row.behavesAs).toBeUndefined();
  }
  const grok = rows.find((row) => row.model === "grok-4.6");
  expect(grok?.behavesAs).toBe("claude-sonnet-5");
});

test("a launcher's picker and allowlist carry only the models that launcher hosts", () => {
  const registry = fixture();
  expect(allowlist(registry, "claude-native")).toEqual([
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ]);
  expect(pickerRows(registry, "claude-native").map((row) => row.model)).toEqual([
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
  ]);
  // A compatibility row declares no launchers, so it is never generated into an active surface.
  expect(allowlist(registry, "claudex")).not.toContain("claude-fable-5");
  expect(birthModelIds(registry)).toContain("claude-fable-5");
});

test("prices, colours and short names resolve exactly then by longest prefix", () => {
  const registry = fixture();
  expect(priceFor(registry, "claude-opus-5")).toEqual({ input: 5, output: 25 });
  expect(priceFor(registry, "claude-sonnet-5", "2026-01-01T00:00:00Z")).toEqual({ input: 2, output: 10 });
  expect(priceFor(registry, "claude-sonnet-5", "2026-09-02T00:00:00Z")).toEqual({ input: 3, output: 15 });
  expect(priceFor(registry, "claude-3-5-haiku-20241022")).toEqual({ input: 0.8, output: 4 });
  expect(priceFor(registry, "no-such-model")).toBeNull();
  expect(colorOf(registry, "gpt-5.6-terra")).toBe("#3d8f87");
  expect(shortOf(registry, "claude-opus-4-8")).toBe("Opus");
  expect(shortOf(registry, "no-such-model")).toBeNull();
  expect(familyOf(registry, "grok-4.5")?.name).toBe("grok");
});

test("an envelope family that sets behaves_as fails validation", () => {
  const invalid = loadInline(MINIMAL.replace(
    'accounting = "envelope"',
    'accounting = "envelope"\nbehaves_as = "claude-sonnet-5"',
  ));
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.message).toContain("drops the row to the donor's window");
});

test("structural mistakes in the registry are loud", () => {
  expect(loadInline(MINIMAL).ok).toBe(true);

  const unknownFamily = loadInline(MINIMAL.replace('family = "gpt-5.6"\nprovider', 'family = "nope"\nprovider'));
  expect(unknownFamily.ok).toBe(false);
  if (!unknownFamily.ok) expect(unknownFamily.error.message).toContain('unknown family "nope"');

  const wrongPrefix = loadInline(MINIMAL.replace('id = "gpt-5.6-sol"', 'id = "grok-4.6"'));
  expect(wrongPrefix.ok).toBe(false);
  if (!wrongPrefix.ok) expect(wrongPrefix.error.message).toContain("matches none of family");

  const duplicate = loadInline(`${MINIMAL}\n[[historical]]\nid = "gpt-5.6-sol"\n`);
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.error.message).toContain("duplicate model id");

  const danglingReplacement = loadInline(MINIMAL.replace(
    'birth = true\npicker = true',
    'birth = true\npicker = true\nreplaced_by = "gpt-5.6-ghost"',
  ));
  expect(danglingReplacement.ok).toBe(false);
  if (!danglingReplacement.ok) expect(danglingReplacement.error.message).toContain("replaced_by unknown model");

  const missingMarker = loadInline(MINIMAL.replace('accounting = "envelope"', 'accounting = "marker"'));
  expect(missingMarker.ok).toBe(false);
  if (!missingMarker.ok) expect(missingMarker.error.message).toContain('without a "marker"');

  const futureVersion = loadInline(MINIMAL.replace("version = 1", "version = 2"));
  expect(futureVersion.ok).toBe(false);
  if (!futureVersion.ok) expect(futureVersion.error.message).toContain("upgrade ccs");
});

test("a missing registry is an error, not an empty fleet", () => {
  const missing = loadModelRegistry(join(tmpdir(), "ccs-no-such-models.toml"));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("failed to read model registry");
});
