import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnrichmentLocations, locationKeySet, renderLocationCatalogue } from "./locations.ts";

const REGISTRY = `
version = 1
default_host = "Milads-Mac-mini"

[[location]]
key = "repos-ccs"
name = "CCS"
aliases = ["claude-sessions", "ccs"]
cwd = "~/Programming/Repos/claude-sessions"
kind = "repo"
eligible_hosts = ["Milads-M3-2"]
preferred_host = "Milads-M3-2"
status = "active"

[[location]]
key = "old-thing"
name = "Retired"
aliases = []
cwd = "~/old"
kind = "repo"
eligible_hosts = ["Milads-M3-2"]
preferred_host = "Milads-M3-2"
status = "retired"
`;

function withRegistry<T>(contents: string | null, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ccs-locations-"));
  const path = join(dir, "locations.toml");
  if (contents !== null) writeFileSync(path, contents);
  try {
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadEnrichmentLocations", () => {
  test("loads active locations and drops retired ones", () => {
    withRegistry(REGISTRY, (path) => {
      const locations = loadEnrichmentLocations(path);
      expect(locations.map((l) => l.key)).toEqual(["repos-ccs"]);
      expect(locations[0]?.aliases).toEqual(["claude-sessions", "ccs"]);
    });
  });

  test("a missing registry is empty, not an error", () => {
    // The router that owns this file may not have shipped to a given machine yet. Enrichment is
    // still worth running there — it just falls back to free-text cwd suggestions.
    expect(loadEnrichmentLocations("/nonexistent/locations.toml")).toEqual([]);
  });

  test("malformed TOML degrades to empty rather than throwing mid-sweep", () => {
    withRegistry("this is not [ valid toml", (path) => {
      expect(loadEnrichmentLocations(path)).toEqual([]);
    });
  });

  test("tolerates registry fields this module does not care about", () => {
    // The session router owns this file's shape and will keep adding fields (host eligibility,
    // harness defaults). Reading it strictly would make each of those a breaking change here.
    withRegistry(REGISTRY + `
[[location]]
key = "future"
name = "Future"
aliases = []
cwd = "~/future"
kind = "repo"
eligible_hosts = ["Milads-M3-2"]
preferred_host = "Milads-M3-2"
status = "active"
some_field_invented_later = "whatever"
`, (path) => {
      expect(loadEnrichmentLocations(path).map((l) => l.key)).toEqual(["repos-ccs", "future"]);
    });
  });
});

describe("locationKeySet", () => {
  test("collects the keys a model is allowed to name", () => {
    withRegistry(REGISTRY, (path) => {
      const keys = locationKeySet(loadEnrichmentLocations(path));
      expect(keys.has("repos-ccs")).toBe(true);
      expect(keys.has("old-thing")).toBe(false);
    });
  });
});

describe("renderLocationCatalogue", () => {
  test("renders one compact line per location with its aliases", () => {
    withRegistry(REGISTRY, (path) => {
      const rendered = renderLocationCatalogue(loadEnrichmentLocations(path));
      expect(rendered).toContain("repos-ccs");
      expect(rendered).toContain("~/Programming/Repos/claude-sessions");
      expect(rendered).toContain("also: claude-sessions, ccs");
      expect(rendered.split("\n")).toHaveLength(1);
    });
  });

  test("says so plainly when there is no registry", () => {
    expect(renderLocationCatalogue([])).toBe("(no location registry on this machine)");
  });
});
