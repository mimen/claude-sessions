import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeHostByCanonicalName, loadHostRegistry } from "./registry.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeRegistry(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-hosts-"));
  roots.push(root);
  const path = join(root, "hosts.toml");
  writeFileSync(path, body);
  return path;
}

test("loads typed hosts and only looks up active canonical names", () => {
  const path = writeRegistry(`version = 1

[[host]]
name = "Milads-Mac-mini"
ssh_alias = "mini"
capabilities = ["ssh"]
status = "active"

[[host]]
name = "Milads-M3-2"
ssh_alias = "laptop"
capabilities = ["ssh"]
status = "retired"
`);

  const loaded = loadHostRegistry(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  expect(loaded.value.hosts).toEqual([
    { name: "Milads-Mac-mini", sshAlias: "mini", capabilities: ["ssh"], status: "active" },
    { name: "Milads-M3-2", sshAlias: "laptop", capabilities: ["ssh"], status: "retired" },
  ]);
  expect(activeHostByCanonicalName(loaded.value, "  milads-MAC-MINI ")).toEqual({
    name: "Milads-Mac-mini",
    sshAlias: "mini",
    capabilities: ["ssh"],
    status: "active",
  });
  expect(activeHostByCanonicalName(loaded.value, "Milads-M3-2")).toBeNull();
  expect(activeHostByCanonicalName(loaded.value, "unknown")).toBeNull();
});

test("returns Result errors for unreadable and malformed registry files", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-hosts-"));
  roots.push(root);

  const missing = loadHostRegistry(join(root, "missing.toml"));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("Failed to read host registry");

  const malformed = loadHostRegistry(writeRegistry("version = [\n"));
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.error.message).toContain("Failed to read host registry");
});

test("rejects schema deviations and empty host identifiers", () => {
  const validHost = `[[host]]
name = "Milads-Mac-mini"
ssh_alias = "mini"
capabilities = ["ssh"]
status = "active"`;
  const cases = [
    { body: `version = 2\n\n${validHost}\n`, marker: "version" },
    { body: `version = 1\nunexpected = true\n\n${validHost}\n`, marker: "unexpected" },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "mini"\ncapabilities = ["ssh"]
status = "active"\nnickname = "server"\n`,
      marker: "nickname",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "   "\nssh_alias = "mini"\ncapabilities = ["ssh"]
status = "active"\n`,
      marker: "name",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "   "\ncapabilities = ["ssh"]
status = "active"\n`,
      marker: "ssh_alias",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "-oProxyCommand=bad"\ncapabilities = ["ssh"]
status = "active"\n`,
      marker: "ssh_alias",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "user@mini"\ncapabilities = ["ssh"]
status = "active"\n`,
      marker: "ssh_alias",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "mini:22"\ncapabilities = ["ssh"]
status = "active"\n`,
      marker: "ssh_alias",
    },
    {
      body: `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "mini"\ncapabilities = ["ssh"]
status = "offline"\n`,
      marker: "status",
    },
  ];

  for (const fixture of cases) {
    const loaded = loadHostRegistry(writeRegistry(fixture.body));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain(fixture.marker);
  }
});

test("requires at least one host", () => {
  const loaded = loadHostRegistry(writeRegistry("version = 1\n"));
  expect(loaded.ok).toBe(false);
  if (!loaded.ok) expect(loaded.error.message).toContain("host");
});

test("requires kebab-case capabilities and rejects normalized duplicates", () => {
  const cases = [
    {
      marker: "capabilities",
      host: `[[host]]\nname = "Mini"\nssh_alias = "mini"\nstatus = "active"`,
    },
    {
      marker: "capabilities",
      host: `[[host]]\nname = "Mini"\nssh_alias = "mini"\ncapabilities = []\nstatus = "active"`,
    },
    {
      marker: "capabilities",
      host: `[[host]]\nname = "Mini"\nssh_alias = "mini"\ncapabilities = ["Interactive GUI"]\nstatus = "active"`,
    },
    {
      marker: "contains duplicates",
      host: `[[host]]\nname = "Mini"\nssh_alias = "mini"\ncapabilities = ["ssh", "ssh"]\nstatus = "active"`,
    },
  ];
  for (const fixture of cases) {
    const loaded = loadHostRegistry(writeRegistry(`version = 1\n\n${fixture.host}\n`));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain(fixture.marker);
  }
});

test("rejects normalized canonical-name and ssh-alias duplicates", () => {
  const cases = [
    {
      duplicate: "canonical host name",
      hosts: `[[host]]
name = "Milads-Mac-mini"
ssh_alias = "mini-one"
capabilities = ["ssh"]
status = "active"

[[host]]
name = "  milads-mac-MINI  "
ssh_alias = "mini-two"
capabilities = ["ssh"]
status = "retired"`,
    },
    {
      duplicate: "ssh alias",
      hosts: `[[host]]
name = "Milads-Mac-mini"
ssh_alias = "Mini"
capabilities = ["ssh"]
status = "active"

[[host]]
name = "Milads-M3-2"
ssh_alias = "  mini  "
capabilities = ["ssh"]
status = "retired"`,
    },
  ];

  for (const fixture of cases) {
    const loaded = loadHostRegistry(writeRegistry(`version = 1\n\n${fixture.hosts}\n`));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain(fixture.duplicate);
  }
});
