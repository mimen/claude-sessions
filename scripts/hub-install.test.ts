import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHubTokens, reportBuild } from "./hub-install.ts";

const SHA = "1fc4798aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("token files are written 0600 and a rerun leaves them unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "ccs-home-"));
  const read = (ref: string) => `${ref.includes("Ingest") ? "ingest" : "read"}-secret\n`;
  installHubTokens(home, read);
  installHubTokens(home, read);
  for (const kind of ["read", "ingest"]) {
    const path = join(home, ".config/ccs", `hub-${kind}-token`);
    expect(readFileSync(path, "utf8")).toBe(`${kind}-secret\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
});

test("a failed op read keeps the token files already there", () => {
  const home = mkdtempSync(join(tmpdir(), "ccs-home-"));
  installHubTokens(home, () => "old");
  expect(() => installHubTokens(home, () => { throw new Error("op timed out"); })).toThrow("op timed out");
  expect(readFileSync(join(home, ".config/ccs/hub-read-token"), "utf8")).toBe("old\n");
});

test("the build report posts host, component, and sha with the ingest bearer", async () => {
  const sent: { url: string; auth: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(init.body as string) });
    return new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  expect(await reportBuild(SHA, { host: "laptop", token: "ingest", fetch })).toBe(false);
  expect(sent).toEqual([{
    url: "https://usable-gopher-567.convex.site/ingest/build",
    auth: "Bearer ingest",
    body: { host: "laptop", component: "ccs", sha: SHA, reportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) },
  }]);
});

test("the build report never throws and skips without a host or token", async () => {
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
  expect(await reportBuild(SHA, { host: "m3", token: "t", fetch: boom })).toBe(false);
  expect(await reportBuild(SHA, { host: null, token: "t", fetch: boom })).toBe(false);
  expect(await reportBuild("not-a-sha", { host: "m3", token: "t", fetch: boom })).toBe(false);
});
