import { describe, expect, test } from "bun:test";
import { identityDir, type Responsibility } from "./identity-path.ts";

const ROOT = "/home/.ccs";

describe("identityDir (ADR-0030/0041 layout)", () => {
  test("cluster core role (singleton): clusters/<c>/identities/<role>", () => {
    const r: Responsibility = { cluster: "pr-watch", role: "control" };
    expect(identityDir(ROOT, r)).toBe("/home/.ccs/clusters/pr-watch/identities/control");
  });

  test("cluster fleet worker: adds [epic/]work-unit under the role", () => {
    const r: Responsibility = { cluster: "pr-watch", role: "pr-agent", epic: "metered", workUnit: "W-12345678" };
    expect(identityDir(ROOT, r)).toBe(
      "/home/.ccs/clusters/pr-watch/identities/pr-agent/metered/W-12345678",
    );
  });

  test("fleet worker with no epic: work-unit directly under the role", () => {
    const r: Responsibility = { cluster: "pr-watch", role: "pr-agent", workUnit: "W-999" };
    expect(identityDir(ROOT, r)).toBe("/home/.ccs/clusters/pr-watch/identities/pr-agent/W-999");
  });

  test("standalone role (no cluster): roles/<role>/identities/…", () => {
    const r: Responsibility = { role: "solo" };
    expect(identityDir(ROOT, r)).toBe("/home/.ccs/roles/solo/identities/solo");
  });

  test("standalone fleet role: roles/<role>/identities/<work-unit>", () => {
    const r: Responsibility = { role: "widget", workUnit: "job-7" };
    expect(identityDir(ROOT, r)).toBe("/home/.ccs/roles/widget/identities/widget/job-7");
  });

  test("path components are sanitized (no traversal / unsafe chars)", () => {
    const r: Responsibility = { cluster: "pr-watch", role: "pr-agent", workUnit: "../etc/passwd" };
    const p = identityDir(ROOT, r);
    expect(p.startsWith("/home/.ccs/clusters/pr-watch/identities/pr-agent/")).toBe(true);
    expect(p).not.toContain(".."); // traversal neutralized
  });
});
