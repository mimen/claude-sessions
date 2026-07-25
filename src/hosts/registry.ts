import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Result, err, ok } from "../result.ts";

export type HostStatus = "active" | "retired";

export interface HostRegistryEntry {
  readonly name: string;
  readonly sshAlias: string;
  readonly capabilities: readonly string[];
  readonly status: HostStatus;
}

export interface HostRegistry {
  readonly version: 1;
  readonly hosts: readonly HostRegistryEntry[];
}

const CapabilitySchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9-]*$/,
  "capabilities must use kebab-case characters: a-z, 0-9, -",
);

const RawHostSchema = z.object({
  name: z.string().trim().min(1),
  ssh_alias: z.string().trim().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "ssh_alias must be a safe SSH alias using only letters, digits, period, underscore, and hyphen",
  ),
  capabilities: z.array(CapabilitySchema).min(1),
  status: z.enum(["active", "retired"]),
}).strict();

const RawHostRegistrySchema = z.object({
  version: z.literal(1),
  host: z.array(RawHostSchema).min(1),
}).strict();

type RawHost = z.infer<typeof RawHostSchema>;

function toHostEntry(raw: RawHost): HostRegistryEntry {
  return {
    name: raw.name,
    sshAlias: raw.ssh_alias,
    capabilities: raw.capabilities,
    status: raw.status,
  };
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function validateHostRegistry(registry: HostRegistry): Result<void> {
  const canonicalNames = new Map<string, string>();
  const sshAliases = new Map<string, string>();

  for (const host of registry.hosts) {
    const normalizedName = normalizeIdentifier(host.name);
    const priorName = canonicalNames.get(normalizedName);
    if (priorName) {
      return err(new Error(
        `duplicate canonical host name "${host.name}" conflicts with "${priorName}"`,
      ));
    }
    canonicalNames.set(normalizedName, host.name);

    const normalizedAlias = normalizeIdentifier(host.sshAlias);
    const priorAlias = sshAliases.get(normalizedAlias);
    if (priorAlias) {
      return err(new Error(
        `duplicate ssh alias "${host.sshAlias}" conflicts with "${priorAlias}"`,
      ));
    }
    sshAliases.set(normalizedAlias, host.sshAlias);

    const capabilities = host.capabilities.map(normalizeIdentifier);
    if (new Set(capabilities).size !== capabilities.length) {
      return err(new Error(`host "${host.name}" capabilities contains duplicates`));
    }
  }

  return ok(undefined);
}

export function loadHostRegistry(path: string): Result<HostRegistry> {
  try {
    const raw = parseToml(readFileSync(path, "utf8"));
    const parsed = RawHostRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      return err(new Error(`Invalid host registry at ${path}:\n${z.prettifyError(parsed.error)}`));
    }
    const registry: HostRegistry = {
      version: parsed.data.version,
      hosts: parsed.data.host.map(toHostEntry),
    };
    const validation = validateHostRegistry(registry);
    if (!validation.ok) return validation;
    return ok(registry);
  } catch (error) {
    return err(new Error(`Failed to read host registry at ${path}: ${(error as Error).message}`));
  }
}

export function activeHostByCanonicalName(
  registry: HostRegistry,
  canonicalName: string,
): HostRegistryEntry | null {
  const normalizedName = normalizeIdentifier(canonicalName);
  if (!normalizedName) return null;
  return registry.hosts.find((host) =>
    host.status === "active" && normalizeIdentifier(host.name) === normalizedName
  ) ?? null;
}
