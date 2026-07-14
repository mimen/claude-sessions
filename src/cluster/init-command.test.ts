import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterInitCommand } from "./init-command.ts";

function withTempRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-init-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("clusterInitCommand", () => {
  test("scaffolds cluster.toml + CHANGELOG + one role", () => {
    withTempRoot((root) => {
      const rc = clusterInitCommand(["hello", "--config-root", root]);
      expect(rc).toBe(0);
      const dir = join(root, "clusters", "hello");
      expect(existsSync(join(dir, "cluster.toml"))).toBe(true);
      expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(true);
      expect(existsSync(join(dir, "roles", "loop", ".claude", "skills", "loop", "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "roles", "loop", ".ccs-hooks"))).toBe(true);

      const toml = readFileSync(join(dir, "cluster.toml"), "utf8");
      expect(toml).toContain('name = "hello"');
      expect(toml).toContain('requires_ccs = ">=0.1.0"');

      const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
      expect(changelog).toContain("hello — CHANGELOG");
      expect(changelog).toMatch(/## v1 — \d{4}-\d{2}-\d{2}/);
    });
  });

  test("honors --role for the scaffolded role slug", () => {
    withTempRoot((root) => {
      const rc = clusterInitCommand(["myc", "--role", "concierge", "--config-root", root]);
      expect(rc).toBe(0);
      const skill = join(root, "clusters", "myc", "roles", "concierge", ".claude", "skills", "concierge", "SKILL.md");
      expect(existsSync(skill)).toBe(true);
    });
  });

  test("refuses if the cluster dir already exists", () => {
    withTempRoot((root) => {
      expect(clusterInitCommand(["twice", "--config-root", root])).toBe(0);
      expect(clusterInitCommand(["twice", "--config-root", root])).toBe(2);
    });
  });

  test("rejects an invalid slug", () => {
    withTempRoot((root) => {
      expect(clusterInitCommand(["Bad Name", "--config-root", root])).toBe(1);
      expect(clusterInitCommand(["-badstart", "--config-root", root])).toBe(1);
    });
  });

  test("errors on a missing name", () => {
    expect(clusterInitCommand([])).toBe(1);
  });
});
