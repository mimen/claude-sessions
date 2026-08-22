import { expect, test } from "bun:test";
import { parseGrokResetGrants } from "./grok.ts";

/** Actual GetRemainingResets response shape captured from grok.com, with token anonymized. */
test("decodes a redeemable Grok usage reset and its expiry", () => {
  // gRPC-Web data frame: response field 10 → grant; grant field 10 token,
  // field 20 available timestamp, field 30 expiry timestamp.
  const hex =
    "0000000023" +
    "5221" +
    "520d72657365745f66697874757265" +
    "a20106089c80f3d306" +
    "f20106089cbd96d506" +
    "800000000f677270632d7374617475733a300d0a";
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  const grants = parseGrokResetGrants(bytes);
  expect(grants).toHaveLength(1);
  expect(grants[0]?.token).toBe("reset_fixture");
  expect(grants[0]?.availableAt).toBe("2026-08-12T18:49:00.000Z");
  expect(grants[0]?.expiresAt).toBe("2026-09-12T18:49:00.000Z");
});

test("returns no grants for malformed frames without throwing", () => {
  expect(parseGrokResetGrants(new Uint8Array())).toEqual([]);
  expect(parseGrokResetGrants(new Uint8Array([0, 0, 0, 0, 0]))).toEqual([]);
  // Declares a one-byte payload containing an unterminated varint.
  expect(parseGrokResetGrants(new Uint8Array([0, 0, 0, 0, 1, 0x80]))).toEqual([]);
  // Declares a payload longer than the actual frame.
  expect(parseGrokResetGrants(new Uint8Array([0, 0, 0, 0, 20, 0x52]))).toEqual([]);
  // Trailer frame (MSB set) is not a data frame.
  expect(parseGrokResetGrants(new Uint8Array([0x80, 0, 0, 0, 1, 0]))).toEqual([]);
});
