import { describe, expect, it } from "vitest";

import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
} from "@agency_hub_core/contracts";

describe("domain event cursor codec (Stage 21)", () => {
  it("round-trips watermark maps, key order irrelevant", () => {
    const maps: Array<Map<number, number>> = [
      new Map(),
      new Map([[1, 0]]),
      new Map([[7, 123], [3, 0], [42, 999_999]]),
    ];
    for (const watermarks of maps) {
      const encoded = encodeDomainEventCursor(watermarks);
      const decoded = decodeDomainEventCursor(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect([...decoded.watermarks.entries()].sort((a, b) => a[0] - b[0]))
          .toEqual([...watermarks.entries()].sort((a, b) => a[0] - b[0]));
      }
    }
  });

  it("encoding is deterministic regardless of insertion order", () => {
    const a = encodeDomainEventCursor(new Map([[1, 5], [2, 9]]));
    const b = encodeDomainEventCursor(new Map([[2, 9], [1, 5]]));
    expect(a).toBe(b);
  });

  it("rejects unknown versions and malformed input", () => {
    const v3 = Buffer.from(JSON.stringify({ v: 3, w: { "1": 5 } })).toString("base64url");
    expect(decodeDomainEventCursor(v3)).toEqual({ ok: false, reason: "unknown_version" });

    const noW = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
    expect(decodeDomainEventCursor(noW)).toEqual({ ok: false, reason: "missing_watermarks" });

    const badAccount = Buffer.from(JSON.stringify({ v: 2, w: { "not-a-number": 1 } })).toString("base64url");
    expect(decodeDomainEventCursor(badAccount)).toEqual({ ok: false, reason: "invalid_account_id" });

    const badSeq = Buffer.from(JSON.stringify({ v: 2, w: { "1": -4 } })).toString("base64url");
    expect(decodeDomainEventCursor(badSeq)).toEqual({ ok: false, reason: "invalid_watermark" });

    expect(decodeDomainEventCursor("!!!not-base64url!!!").ok).toBe(false);
    expect(decodeDomainEventCursor(Buffer.from("plain text").toString("base64url")).ok).toBe(false);
    expect(decodeDomainEventCursor(Buffer.from("[1,2]").toString("base64url")).ok).toBe(false);
  });
});
