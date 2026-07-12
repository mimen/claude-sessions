import { describe, expect, test } from "bun:test";

/**
 * Test the version comparison logic at critical boundaries (0.64.0 hook-store minimum,
 * 1.0.0 untested major version). Since cmuxVersion() shells out to `cmux --version`,
 * we test the PARSING edge cases and document the version-guard contract from liveBridge.
 *
 * NOTE: liveBridge's version-guard logic is integration-tested via resume flows, but
 * the pure version-comparison semantics (0.64.0 boundary, 1.0.0 warning) can be tested
 * in isolation by checking the version parsing edge cases and documenting the contract.
 */

interface CmuxVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The version-guard logic from liveBridge.ts (extracted for unit testing):
 * - If major=0 and minor < 64 → readable=false (hook store predates 0.64.0).
 * - If major >= 1 → warn about untested major version (but don't fail closed).
 */
function versionGuardReadable(
  version: CmuxVersion | null,
  treeOk: boolean,
  storeOk: boolean,
): boolean {
  let readable = treeOk && storeOk;
  if (version) {
    if (version.major === 0 && version.minor < 64) {
      readable = false; // predates hook store
    }
  }
  return readable;
}

function versionGuardWarning(version: CmuxVersion | null): string | null {
  if (!version) return null;
  if (version.major === 0 && version.minor < 64) {
    return `cmux ${version.major}.${version.minor}.${version.patch} predates the hook store (0.64.0) — liveness unreadable`;
  }
  if (version.major >= 1) {
    return `cmux ${version.major}.${version.minor}.${version.patch} is an untested major version (built for 0.64.x)`;
  }
  return null;
}

describe("version-guard logic (extracted from liveBridge)", () => {
  test("0.63.x predates hook store → readable=false", () => {
    const version = { major: 0, minor: 63, patch: 99 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(false);

    const warning = versionGuardWarning(version);
    expect(warning).toContain("predates the hook store");
  });

  test("0.64.0 is the hook-store minimum → readable=true (if tree+store ok)", () => {
    const version = { major: 0, minor: 64, patch: 0 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(true);

    const warning = versionGuardWarning(version);
    expect(warning).toBeNull(); // no warning at 0.64.0
  });

  test("0.64.17 (current known-good) → readable=true, no warning", () => {
    const version = { major: 0, minor: 64, patch: 17 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(true);

    const warning = versionGuardWarning(version);
    expect(warning).toBeNull();
  });

  test("0.99.x (late 0.x) → readable=true, no warning", () => {
    const version = { major: 0, minor: 99, patch: 0 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(true);

    const warning = versionGuardWarning(version);
    expect(warning).toBeNull();
  });

  test("1.0.0 → readable=true but warns about untested major version", () => {
    const version = { major: 1, minor: 0, patch: 0 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(true); // doesn't fail closed, just warns

    const warning = versionGuardWarning(version);
    expect(warning).toContain("untested major version");
    expect(warning).toContain("built for 0.64.x");
  });

  test("2.5.3 → readable=true but warns about untested major version", () => {
    const version = { major: 2, minor: 5, patch: 3 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(true);

    const warning = versionGuardWarning(version);
    expect(warning).toContain("untested major version");
  });

  test("null version (cmux absent) → readable depends only on tree+store", () => {
    const readable1 = versionGuardReadable(null, true, true);
    expect(readable1).toBe(true); // both ok → readable

    const readable2 = versionGuardReadable(null, false, true);
    expect(readable2).toBe(false); // tree failed → unreadable

    const warning = versionGuardWarning(null);
    expect(warning).toBeNull(); // no warning for absent cmux
  });

  test("tree or store failure → readable=false regardless of version", () => {
    const version = { major: 0, minor: 64, patch: 17 };

    const readable1 = versionGuardReadable(version, false, true);
    expect(readable1).toBe(false); // tree failed

    const readable2 = versionGuardReadable(version, true, false);
    expect(readable2).toBe(false); // store failed

    const readable3 = versionGuardReadable(version, false, false);
    expect(readable3).toBe(false); // both failed
  });

  test("0.63.x with tree ok and store ok still fails closed due to version", () => {
    const version = { major: 0, minor: 50, patch: 0 };
    const readable = versionGuardReadable(version, true, true);
    expect(readable).toBe(false); // version guard overrides tree+store success
  });
});

describe("version parsing edge cases (contract for cmuxVersion)", () => {
  test("version string with prefix (e.g. 'v0.64.17') should match \\d+\\.\\d+\\.\\d+", () => {
    // The cmuxVersion() regex is /(\d+)\.(\d+)\.(\d+)/ which matches anywhere in the string,
    // so "v0.64.17" or "cmux version 0.64.17" both parse correctly.
    const regex = /(\d+)\.(\d+)\.(\d+)/;

    const match1 = "v0.64.17".match(regex);
    expect(match1).not.toBeNull();
    expect(match1?.[1]).toBe("0");
    expect(match1?.[2]).toBe("64");
    expect(match1?.[3]).toBe("17");

    const match2 = "cmux version 0.64.17".match(regex);
    expect(match2).not.toBeNull();
    expect(match2?.[1]).toBe("0");
    expect(match2?.[2]).toBe("64");
  });

  test("version string without semantic version → null (unparseable)", () => {
    const regex = /(\d+)\.(\d+)\.(\d+)/;

    const match1 = "unknown".match(regex);
    expect(match1).toBeNull();

    const match2 = "0.64".match(regex); // missing patch
    expect(match2).toBeNull();

    const match3 = "1.x.0".match(regex); // non-numeric minor
    expect(match3).toBeNull();
  });

  test("multi-digit version components parse correctly", () => {
    const regex = /(\d+)\.(\d+)\.(\d+)/;

    const match = "12.345.6789".match(regex);
    expect(match).not.toBeNull();
    expect(parseInt(match?.[1]!, 10)).toBe(12);
    expect(parseInt(match?.[2]!, 10)).toBe(345);
    expect(parseInt(match?.[3]!, 10)).toBe(6789);
  });

  test("leading zeros are parsed as base-10 (not octal)", () => {
    const regex = /(\d+)\.(\d+)\.(\d+)/;

    const match = "0.064.017".match(regex);
    expect(match).not.toBeNull();
    expect(parseInt(match?.[1]!, 10)).toBe(0);
    expect(parseInt(match?.[2]!, 10)).toBe(64); // "064" as decimal is 64, not octal
    expect(parseInt(match?.[3]!, 10)).toBe(17);
  });

  test("version at exactly 0.64.0 boundary", () => {
    const version = { major: 0, minor: 64, patch: 0 };
    // This is the MINIMUM acceptable version (hook store introduced at 0.64.0)
    expect(version.major).toBe(0);
    expect(version.minor).toBe(64);

    const guardFails = version.major === 0 && version.minor < 64;
    expect(guardFails).toBe(false); // 64 is NOT < 64, so guard passes
  });

  test("version at exactly 1.0.0 boundary", () => {
    const version = { major: 1, minor: 0, patch: 0 };
    // This triggers the "untested major version" warning but doesn't fail closed
    expect(version.major).toBeGreaterThanOrEqual(1);

    const warning = versionGuardWarning(version);
    expect(warning).not.toBeNull();
  });
});
