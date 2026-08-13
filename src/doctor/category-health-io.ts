/**
 * IO for `ccs doctor categories`: reads the registries, the deployed services, and shells
 * out to the vault-side checker for the surfaces this kernel deliberately cannot reach.
 *
 * The split exists for one reason. Todoist and Google Calendar need `op` and `gog`
 * credentials, and putting external-service credentials inside the session kernel would
 * widen its blast radius for a diagnostic. So ccs owns the contract, location and
 * deployment checks, and delegates the rest to a script in the vault that already has
 * those credential paths. One command to the caller, two implementations underneath.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { loadCategoryRegistry } from "../categories/registry.ts";
import { loadLocationRegistry } from "../locations/registry.ts";
import { CATEGORY_REGISTRY_PATH, LOCATION_REGISTRY_PATH } from "../paths.ts";
import {
  buildCategoryHealthReport,
  checkDeployments,
  checkLocationMarkers,
  checkLocationSlugs,
  finding,
} from "./category-health.ts";
import type {
  CategoryArea,
  CategoryFinding,
  CategoryHealthReport,
  DeploymentState,
  LocationMarker,
} from "./category-health.ts";

/** Services whose code implements a category surface, and the host that serves each. */
const WATCHED_DEPLOYMENTS: readonly { name: string; host: string; path: string }[] = [
  { name: "mindmap-visualizer", host: "Milads-Mac-mini", path: "~/Programming/Repos/mindmap-visualizer" },
];

const VAULT_DOCTOR = "Documents/milad-vault/ClaudeConfig/categories/doctor.py";

interface VaultFinding {
  readonly area: string;
  readonly detail: string;
  readonly repairable: boolean;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * How far a deployed checkout trails its origin default branch.
 *
 * The host is authoritative, never inferred from whether the path happens to exist here.
 * A developer checkout of the same repo sits at the same path on this laptop, usually on a
 * feature branch and legitimately behind — reporting that as a deployment fault would be a
 * false alarm every time, while the actual serving host went unchecked.
 */
function readDeployment(entry: { name: string; host: string; path: string }): DeploymentState {
  const local = entry.path.replace("~", homedir());
  if (entry.host !== "" && entry.host !== hostname().replace(/\.local$/, "")) {
    try {
      const script =
        `cd ${entry.path} && git fetch -q origin 2>/dev/null; ` +
        `git rev-list --count HEAD..origin/$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | ` +
        `sed 's|origin/||' || echo main) 2>/dev/null`;
      const output = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", entry.host, script], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const behind = Number.parseInt(output, 10);
      return Number.isNaN(behind)
        ? { name: entry.name, host: entry.host, behind: null, error: "could not read revision" }
        : { name: entry.name, host: entry.host, behind, error: null };
    } catch (error) {
      return {
        name: entry.name,
        host: entry.host,
        behind: null,
        error: error instanceof Error ? `unreachable: ${error.message}` : "unreachable",
      };
    }
  }
  git(local, ["fetch", "-q", "origin"]);
  const head = git(local, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) ?? "origin/master";
  const behind = git(local, ["rev-list", "--count", `HEAD..${head}`]);
  return behind === null
    ? { name: entry.name, host: "local", behind: null, error: "not a git checkout" }
    : { name: entry.name, host: "local", behind: Number.parseInt(behind, 10), error: null };
}

/** Reduce the location registry to the marker view, reading the raw TOML for the flags. */
function readLocationMarkers(): LocationMarker[] {
  const path = LOCATION_REGISTRY_PATH();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("[[location]]")
    .slice(1)
    .map((block) => {
      const key = /key = "([^"]+)"/.exec(block)?.[1] ?? "(unnamed)";
      const status = /status = "([^"]+)"/.exec(block)?.[1] ?? "active";
      const category = /^category = "([^"]+)"/m.exec(block)?.[1] ?? null;
      const neutral = /^category_neutral = true/m.test(block);
      return { key, status, category, hasCategory: category !== null || neutral };
    });
}

/** Run the vault-side checker. A missing or failing script is unreachable, not clean. */
function runVaultDoctor(deep: boolean): { findings: CategoryFinding[]; unreachable: string[] } {
  const script = join(homedir(), VAULT_DOCTOR);
  if (!existsSync(script)) return { findings: [], unreachable: ["vault/todoist/calendar"] };
  try {
    const output = execFileSync("python3", [script, "--json", ...(deep ? ["--deep"] : [])], {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as { findings: VaultFinding[]; errors: string[] };
    const findings = parsed.findings.map((item) =>
      finding(`${item.area}.drift`, item.area as CategoryArea, "drift", item.detail, {
        repairable: item.repairable,
      }),
    );
    return { findings, unreachable: parsed.errors ?? [] };
  } catch (error) {
    // A non-zero exit means drift was found and printed, so parse stdout before giving up.
    const stdout = (error as { stdout?: Buffer | string }).stdout;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout.toString()) as { findings: VaultFinding[]; errors: string[] };
        return {
          findings: parsed.findings.map((item) =>
            finding(`${item.area}.drift`, item.area as CategoryArea, "drift", item.detail, {
              repairable: item.repairable,
            }),
          ),
          unreachable: parsed.errors ?? [],
        };
      } catch {
        /* fall through to unreachable */
      }
    }
    return { findings: [], unreachable: ["vault/todoist/calendar"] };
  }
}

export function collectCategoryHealth(options: { deep?: boolean } = {}): CategoryHealthReport {
  const findings: CategoryFinding[] = [];
  const unreachable: string[] = [];

  const registry = loadCategoryRegistry(CATEGORY_REGISTRY_PATH());
  if (!registry.ok) {
    return buildCategoryHealthReport(
      [finding("contract.registry", "contract", "drift", registry.error.message, {
        remedy: "fix ClaudeConfig/categories/registry.json",
      })],
      ["locations", "vault/todoist/calendar", "deployment"],
    );
  }
  const slugs = new Set(registry.value.categories.map((category) => category.slug));

  const locations = loadLocationRegistry(LOCATION_REGISTRY_PATH());
  if (!locations.ok) {
    findings.push(finding("locations.unreadable", "locations", "warn", locations.error.message));
  } else {
    const markers = readLocationMarkers();
    findings.push(...checkLocationMarkers(markers));
    findings.push(...checkLocationSlugs(markers, slugs));
  }

  const vault = runVaultDoctor(options.deep ?? false);
  findings.push(...vault.findings);
  unreachable.push(...vault.unreachable);

  findings.push(...checkDeployments(WATCHED_DEPLOYMENTS.map(readDeployment)));

  return buildCategoryHealthReport(findings, unreachable);
}
