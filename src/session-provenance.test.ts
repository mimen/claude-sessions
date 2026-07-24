import { describe, expect, test } from "bun:test";
import { resolveDelegateCreator, resolveNewSessionCreator } from "./session-provenance.ts";

const PARENT = "11111111-1111-4111-8111-111111111111";

describe("session creator provenance", () => {
  test("plain top-level session defaults to human", () => {
    expect(resolveNewSessionCreator({}, undefined)).toEqual({ ok: true, value: { kind: "human", ref: null } });
  });

  test("new session inside an agent records the launching session", () => {
    expect(resolveNewSessionCreator({ CLAUDE_CODE_SESSION_ID: PARENT }, undefined)).toEqual({
      ok: true,
      value: { kind: "agent", ref: PARENT },
    });
  });

  test("automation requires and preserves a stable creator ref", () => {
    expect(resolveNewSessionCreator({ CCS_CREATOR_KIND: "automation" }, undefined).ok).toBe(false);
    expect(resolveNewSessionCreator({
      CCS_CREATOR_KIND: "automation",
      CCS_CREATOR_REF: "imsg-server",
    }, undefined)).toEqual({
      ok: true,
      value: { kind: "automation", ref: "imsg-server" },
    });
  });

  test("delegation defaults to agent and keeps parent separate from automation creator", () => {
    expect(resolveDelegateCreator({}, PARENT)).toEqual({
      ok: true,
      value: { kind: "agent", ref: PARENT },
    });
    expect(resolveDelegateCreator({
      CCS_CREATOR_KIND: "automation",
      CCS_CREATOR_REF: "imsg-server",
    }, PARENT)).toEqual({
      ok: true,
      value: { kind: "automation", ref: "imsg-server" },
    });
  });

  test("invalid or human delegation declarations fail before reservation", () => {
    expect(resolveDelegateCreator({ CCS_CREATOR_KIND: "robot" }, PARENT).ok).toBe(false);
    expect(resolveDelegateCreator({ CCS_CREATOR_KIND: "human" }, PARENT).ok).toBe(false);
  });
});
