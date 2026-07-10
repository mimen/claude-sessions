import { expect, test } from "bun:test";
import {
  openCatalogue,
  upsertRole,
  getRoleDef,
  allRoles,
  rolesForCluster,
  deleteRole,
} from "./db.ts";

const NOW = "2026-07-09T00:00:00Z";

test("upsertRole creates a role def and getRoleDef round-trips", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, {
    role: "control",
    cluster: "pr-watch",
    kind: "loop",
    homeDir: "~/.claude/roles/pr-watch/control",
    resumeCommand: "/loop 15m /pr-watch-control",
    now: NOW,
  });
  const r = getRoleDef(db, "control");
  expect(r).not.toBeNull();
  expect(r!.cluster).toBe("pr-watch");
  expect(r!.kind).toBe("loop");
  expect(r!.homeDir).toBe("~/.claude/roles/pr-watch/control");
  expect(r!.resumeCommand).toBe("/loop 15m /pr-watch-control");
});

test("upsert is idempotent — second write updates in place, no duplicate", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, { role: "scout", cluster: "pr-watch", kind: "loop", now: NOW });
  upsertRole(db, { role: "scout", cluster: "pr-watch", kind: "loop", resumeCommand: "/loop 30m /pr-watch-scout", now: NOW });
  expect(allRoles(db).size).toBe(1);
  expect(getRoleDef(db, "scout")!.resumeCommand).toBe("/loop 30m /pr-watch-scout");
});

test("a role can stand alone (no cluster) — cluster is optional (ADR-0022)", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, { role: "one-off", kind: "session", now: NOW });
  expect(getRoleDef(db, "one-off")!.cluster).toBeNull();
});

test("rolesForCluster returns only that cluster's roles", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, { role: "control", cluster: "pr-watch", kind: "loop", now: NOW });
  upsertRole(db, { role: "pr-agent", cluster: "pr-watch", kind: "session", now: NOW });
  upsertRole(db, { role: "solo", kind: "session", now: NOW });
  const names = rolesForCluster(db, "pr-watch").map((r) => r.role).sort();
  expect(names).toEqual(["control", "pr-agent"]);
});

test("deleteRole removes a role def (for materialization prune, ADR-0034)", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, { role: "gone", cluster: "pr-watch", kind: "loop", now: NOW });
  deleteRole(db, "gone");
  expect(getRoleDef(db, "gone")).toBeNull();
});

test("skills/commands/hooks materialization lists round-trip (JSON columns)", () => {
  const db = openCatalogue(":memory:");
  upsertRole(db, {
    role: "control",
    cluster: "pr-watch",
    kind: "loop",
    skills: ["pr-watch-control"],
    commands: ["pr-watch-control"],
    hooks: ["session-start", "stop"],
    now: NOW,
  });
  const r = getRoleDef(db, "control")!;
  expect(r.skills).toEqual(["pr-watch-control"]);
  expect(r.commands).toEqual(["pr-watch-control"]);
  expect(r.hooks).toEqual(["session-start", "stop"]);
});
