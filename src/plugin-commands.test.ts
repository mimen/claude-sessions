import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "plugins", "ccs");
const commandsDir = join(pluginDir, "commands");

function command(name: string): string {
  return readFileSync(join(commandsDir, `${name}.md`), "utf8");
}

function executableCcsLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ccs "));
}

describe("ccs workspace-closing slash commands", () => {
  test("complete has one foreground finish-current call as its final action", () => {
    const source = command("complete");

    expect(executableCcsLines(source)).toEqual(["ccs finish-current complete --do"]);
    expect(source).toContain("only tool call and final action");
    expect(source).not.toContain("ccs whoami");
    expect(source).not.toContain("ccs session .");
    expect(source).not.toContain("ccs rename");
    expect(source).not.toContain("claude-actions");
  });

  test("archive has one foreground finish-current call and no action-link flow", () => {
    const source = command("archive");

    expect(executableCcsLines(source)).toEqual(["ccs finish-current archive --do"]);
    expect(source).toContain("only tool call and final action");
    expect(source).not.toContain("ccs whoami");
    expect(source).not.toContain("ccs session .");
    expect(source).not.toContain("ccs rename");
    expect(source).not.toContain("claude-actions");
  });

  test("standalone close command requires preflight before mutation", () => {
    const source = command("close-workspace");
    const preflightAt = source.indexOf("ccs close-current-workspace\n");
    const closeAt = source.indexOf("ccs close-current-workspace --do");

    expect(preflightAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(preflightAt);
    expect(source).toContain("only live surface");
  });

  test("plugin minor version is bumped", () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe("0.4.0");
  });
});
