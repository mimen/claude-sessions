import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const commandsDir = join(import.meta.dir, "..", "plugins", "ccs", "commands");

function command(name: string): string {
  return readFileSync(join(commandsDir, `${name}.md`), "utf8");
}

describe("ccs workspace-closing slash commands", () => {
  test("complete records lifecycle before closing the workspace as its final action", () => {
    const source = command("complete");
    const completeAt = source.indexOf("ccs session complete .");
    const preflightAt = source.indexOf("ccs close-current-workspace\n");
    const closeAt = source.indexOf("ccs close-current-workspace --do");

    expect(completeAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeGreaterThan(completeAt);
    expect(closeAt).toBeGreaterThan(preflightAt);
    expect(source.slice(closeAt)).toContain("Do not invoke another tool");
  });

  test("standalone close command requires preflight before mutation", () => {
    const source = command("close-workspace");
    const preflightAt = source.indexOf("ccs close-current-workspace\n");
    const closeAt = source.indexOf("ccs close-current-workspace --do");

    expect(preflightAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(preflightAt);
    expect(source).toContain("only live surface");
  });
});
