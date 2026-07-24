import { describe, expect, test } from "bun:test";
import {
  getRow,
  openCatalogue,
  setCreatorKind,
  setCreatorRef,
  setForkedFromSessionId,
  setLaunchChannel,
} from "./db.ts";

describe("catalogue session provenance", () => {
  test("persists typed creator, launch, and fork fields", () => {
    const db = openCatalogue(":memory:");
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const now = "2026-07-22T19:25:38.000Z";
    try {
      setCreatorKind(db, sessionId, "automation", now);
      setCreatorRef(db, sessionId, "imsg-server", now);
      setLaunchChannel(db, sessionId, "ccs_delegate", now);
      setForkedFromSessionId(db, sessionId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", now);

      expect(getRow(db, sessionId)).toMatchObject({
        creatorKind: "automation",
        creatorRef: "imsg-server",
        launchChannel: "ccs_delegate",
        forkedFromSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });
    } finally {
      db.close();
    }
  });

  test("legacy rows remain honestly null", () => {
    const db = openCatalogue(":memory:");
    try {
      db.query("INSERT INTO catalogue (session_id) VALUES ('legacy')").run();
      expect(getRow(db, "legacy")).toMatchObject({
        creatorKind: null,
        creatorRef: null,
        launchChannel: null,
        forkedFromSessionId: null,
      });
    } finally {
      db.close();
    }
  });
});
