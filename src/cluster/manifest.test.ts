import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSemVer,
  compareSemVer,
  parseCcsRequirement,
  readClusterManifest,
  gateCcsRequirement,
  type ClusterManifest,
} from "./manifest.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a cluster.toml into a throwaway config root; return the root. */
function writeCluster(cluster: string, toml: string): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-manifest-"));
  tmps.push(root);
  const dir = join(root, "clusters", cluster);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cluster.toml"), toml);
  return root;
}

test("parseSemVer parses a triple and tolerates a leading v/=", () => {
  expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(parseSemVer("v0.64.17")).toEqual({ major: 0, minor: 64, patch: 17 });
  expect(parseSemVer("nope")).toBeNull();
});

test("compareSemVer orders by major then minor then patch", () => {
  expect(compareSemVer({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 9, patch: 9 })).toBeGreaterThan(0);
  expect(compareSemVer({ major: 0, minor: 1, patch: 0 }, { major: 0, minor: 1, patch: 0 })).toBe(0);
  expect(compareSemVer({ major: 0, minor: 1, patch: 2 }, { major: 0, minor: 1, patch: 5 })).toBeLessThan(0);
});

test("parseCcsRequirement accepts >=X.Y.Z and rejects other shapes", () => {
  expect(parseCcsRequirement(">=0.1.0")).toEqual({ min: { major: 0, minor: 1, patch: 0 } });
  expect(parseCcsRequirement(">= 1.2.3")).toEqual({ min: { major: 1, minor: 2, patch: 3 } });
  expect(parseCcsRequirement("^1.0.0")).toBeNull();
  expect(parseCcsRequirement("1.0.0")).toBeNull();
});

test("readClusterManifest resolves engine/sense to absolute paths under the cluster dir", () => {
  const root = writeCluster(
    "pr-watch",
    'name = "pr-watch"\nengine = "engine"\nsense = "engine/scripts/sense.sh"\nversion = 3\nrequires_ccs = ">=0.1.0"\ngrouping_type = "epic"\n',
  );
  const res = readClusterManifest("pr-watch", root);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const m = res.value;
  expect(m.name).toBe("pr-watch");
  expect(m.engineDir).toBe(join(root, "clusters", "pr-watch", "engine"));
  expect(m.sensePath).toBe(join(root, "clusters", "pr-watch", "engine", "scripts", "sense.sh"));
  expect(m.version).toBe("3"); // a numeric version normalizes to a string
  expect(m.requiresCcs).toBe(">=0.1.0");
  expect(m.groupingType).toBe("epic"); // ADR-0070 declared grouping type
});

test("grouping_type defaults to 'epic' when a manifest doesn't declare it", () => {
  const root = writeCluster("legacy", 'name = "legacy"\n');
  const res = readClusterManifest("legacy", root);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.groupingType).toBe("epic");
});

test("readClusterManifest errs on a missing manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-manifest-"));
  tmps.push(root);
  const res = readClusterManifest("ghost", root);
  expect(res.ok).toBe(false);
});

test("readClusterManifest errs on malformed toml", () => {
  const root = writeCluster("broken", "name = \nthis is not toml [[[");
  const res = readClusterManifest("broken", root);
  expect(res.ok).toBe(false);
});

test("readClusterManifest errs when required 'name' is missing", () => {
  const root = writeCluster("noname", 'engine = "engine"\n');
  const res = readClusterManifest("noname", root);
  expect(res.ok).toBe(false);
});

test("a manifest with no engine/version/requires_ccs parses with nulls (legacy cluster)", () => {
  const root = writeCluster("legacy", 'name = "legacy"\n');
  const res = readClusterManifest("legacy", root);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.engineDir).toBeNull();
  expect(res.value.version).toBeNull();
  expect(res.value.requiresCcs).toBeNull();
});

const manifest = (over: Partial<ClusterManifest> = {}): ClusterManifest => ({
  name: "c", engineDir: null, sensePath: null, boardPath: null, version: null, requiresCcs: null, groupingType: "epic", ...over,
});

test("gate: no requirement → ok", () => {
  expect(gateCcsRequirement(manifest(), { major: 0, minor: 1, patch: 0 }).status).toBe("ok");
});

test("gate: running >= required → ok", () => {
  const v = gateCcsRequirement(manifest({ requiresCcs: ">=0.1.0" }), { major: 0, minor: 1, patch: 0 });
  expect(v.status).toBe("ok");
  const v2 = gateCcsRequirement(manifest({ requiresCcs: ">=0.1.0" }), { major: 0, minor: 2, patch: 5 });
  expect(v2.status).toBe("ok");
});

test("gate: minor/patch shortfall (same major) → warn, not refuse", () => {
  const v = gateCcsRequirement(manifest({ name: "pr-watch", requiresCcs: ">=0.3.0" }), { major: 0, minor: 1, patch: 0 });
  expect(v.status).toBe("warn");
  if (v.status !== "warn") return;
  expect(v.message).toContain("minor gap");
});

test("gate: major-version shortfall → refuse", () => {
  const v = gateCcsRequirement(manifest({ name: "pr-watch", requiresCcs: ">=1.0.0" }), { major: 0, minor: 9, patch: 9 });
  expect(v.status).toBe("refuse");
  if (v.status !== "refuse") return;
  expect(v.message).toContain("major-version gap");
});

test("gate: malformed requirement → warn (never blocks)", () => {
  const v = gateCcsRequirement(manifest({ name: "c", requiresCcs: "^1.0.0" }), { major: 0, minor: 1, patch: 0 });
  expect(v.status).toBe("warn");
  if (v.status !== "warn") return;
  expect(v.message).toContain("unrecognized");
});
