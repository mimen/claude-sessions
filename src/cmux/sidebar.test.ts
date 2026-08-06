import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CCS_WEB_SIDEBAR_SOURCE_PATH,
  ccsWebSidebarTargetPath,
  inspectCcsWebSidebar,
  installCcsSidebar,
  installCcsWebSidebar,
} from "./sidebar.ts";

interface Fixture {
  root: string;
  sourcePath: string;
  targetPath: string;
  backupPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-sidebar-"));
  mkdirSync(join(root, "config"), { recursive: true });
  return {
    root,
    sourcePath: join(root, "source.swift"),
    targetPath: join(root, "config", "ccs.swift"),
    backupPath: join(root, "config", "ccs.swift.backup-test"),
  };
}

describe("installCcsSidebar", () => {
  test("installs the sidebar when the target directory is missing", () => {
    const paths = fixture();
    try {
      const nestedTarget = join(paths.root, "nested", "sidebars", "ccs.swift");
      writeFileSync(paths.sourcePath, "Text(\"versioned\")\n");

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: nestedTarget,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.state).toBe("installed");
      expect(result.value.backupPath).toBeNull();
      expect(readFileSync(nestedTarget, "utf8")).toBe("Text(\"versioned\")\n");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  test("leaves an identical installed sidebar unchanged", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.sourcePath, "Text(\"current\")\n");
      writeFileSync(paths.targetPath, "Text(\"current\")\n");

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.state).toBe("unchanged");
      expect(result.value.backupPath).toBeNull();
      expect(readFileSync(paths.targetPath, "utf8")).toBe("Text(\"current\")\n");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a differing installed sidebar", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.sourcePath, "Text(\"versioned\")\n");
      writeFileSync(paths.targetPath, "Text(\"local\")\n");

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected a conflict result");
      expect(result.error.code).toBe("conflict");
      expect(readFileSync(paths.targetPath, "utf8")).toBe("Text(\"local\")\n");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  test("refuses to replace a dangling symlink", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.sourcePath, "Text(\"versioned\")\n");
      symlinkSync("missing-sidebar.swift", paths.targetPath);

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an unsupported target result");
      expect(result.error.code).toBe("unsupported-target");
      expect(lstatSync(paths.targetPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(paths.targetPath)).toBe("missing-sidebar.swift");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  test("refuses to force-replace a symlink to a regular file", () => {
    const paths = fixture();
    try {
      const linkedTarget = `${paths.targetPath}.linked`;
      writeFileSync(paths.sourcePath, "Text(\"versioned\")\n");
      writeFileSync(linkedTarget, "Text(\"local\")\n");
      symlinkSync(linkedTarget, paths.targetPath);

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
        backupPath: paths.backupPath,
        force: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an unsupported target result");
      expect(result.error.code).toBe("unsupported-target");
      expect(lstatSync(paths.targetPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(linkedTarget, "utf8")).toBe("Text(\"local\")\n");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  test("force preserves the previous file and installs the versioned source", () => {
    const paths = fixture();
    try {
      writeFileSync(paths.sourcePath, "Text(\"versioned\")\n");
      writeFileSync(paths.targetPath, "Text(\"local\")\n");

      const result = installCcsSidebar({
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
        backupPath: paths.backupPath,
        force: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.state).toBe("overwritten");
      expect(result.value.backupPath).toBe(paths.backupPath);
      expect(readFileSync(paths.targetPath, "utf8")).toBe("Text(\"versioned\")\n");
      expect(readFileSync(paths.backupPath, "utf8")).toBe("Text(\"local\")\n");
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});

describe("installCcsWebSidebar", () => {
  test("addresses its own name and leaves an installed Swift sidebar untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-web-sidebar-"));
    try {
      const configuration = join(root, ".config", "cmux", "sidebars");
      mkdirSync(configuration, { recursive: true });
      const swiftTarget = join(configuration, "ccs.swift");
      writeFileSync(swiftTarget, "Text(\"interpreted\")\n");

      const result = installCcsWebSidebar({ targetPath: ccsWebSidebarTargetPath(root) });

      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.state).toBe("installed");
      expect(result.value.targetPath).toBe(join(configuration, "ccs-web.url"));
      // Precedence between the two sidebars is cmux's to decide, so installing one must not
      // touch, back up, or replace the other.
      expect(readFileSync(swiftTarget, "utf8")).toBe("Text(\"interpreted\")\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("installs the versioned loopback URL and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-web-sidebar-"));
    try {
      const targetPath = join(root, "sidebars", "ccs-web.url");
      const first = installCcsWebSidebar({ targetPath });
      expect(first.ok).toBe(true);
      if (!first.ok) throw first.error;
      expect(first.value.state).toBe("installed");
      expect(readFileSync(targetPath, "utf8")).toBe(
        readFileSync(CCS_WEB_SIDEBAR_SOURCE_PATH, "utf8"),
      );
      expect(readFileSync(targetPath, "utf8").trim()).toBe("http://127.0.0.1:8787/");

      const second = installCcsWebSidebar({ targetPath });
      expect(second.ok).toBe(true);
      if (!second.ok) throw second.error;
      expect(second.value.state).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a differing URL without --force and reports an absent one as missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-web-sidebar-"));
    try {
      const targetPath = join(root, "sidebars", "ccs-web.url");
      const missing = inspectCcsWebSidebar({ targetPath });
      expect(missing.ok).toBe(true);
      if (!missing.ok) throw missing.error;
      expect(missing.value.state).toBe("missing");

      mkdirSync(join(root, "sidebars"), { recursive: true });
      writeFileSync(targetPath, "http://127.0.0.1:9999/\n");

      const refused = installCcsWebSidebar({ targetPath });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error("Expected a conflict result");
      expect(refused.error.code).toBe("conflict");
      expect(readFileSync(targetPath, "utf8")).toBe("http://127.0.0.1:9999/\n");

      const inspection = inspectCcsWebSidebar({ targetPath });
      expect(inspection.ok).toBe(true);
      if (!inspection.ok) throw inspection.error;
      expect(inspection.value.state).toBe("different");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
