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
        expect(decoded.scope).toBeNull();
        expect(decoded.recovery).toBeNull();
        expect([...decoded.watermarks.entries()].sort((a, b) => a[0] - b[0]))
          .toEqual([...watermarks.entries()].sort((a, b) => a[0] - b[0]));
      }
    }
  });

  it("round-trips the full granted-scope binding", () => {
    const encoded = encodeDomainEventCursor(new Map([[7, 12], [8, 2]]), {
      scope: "granted",
    });
    const decoded = decodeDomainEventCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.scope).toBe("granted");
      expect(decoded.recovery).toBeNull();
      expect([...decoded.watermarks.entries()]).toEqual([[7, 12], [8, 2]]);
    }
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toMatchObject({
      v: 3,
      s: "granted",
    });
  });

  it("round-trips a bounded state-snapshot recovery marker", () => {
    const encoded = encodeDomainEventCursor(new Map([[7, 12]]), {
      scope: "granted",
      recovery: {
        kind: "snapshot",
        erasureEpoch: 17,
        base: new Map([[7, 10]]),
        targets: new Map([[7, 14]]),
        retainedCounts: new Map([[7, 3]]),
      },
    });
    const decoded = decodeDomainEventCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.scope).toBe("granted");
      expect(decoded.recovery).toEqual({
        kind: "snapshot",
        erasureEpoch: 17,
        base: new Map([[7, 10]]),
        targets: new Map([[7, 14]]),
        retainedCounts: new Map([[7, 3]]),
      });
      expect([...decoded.watermarks.entries()]).toEqual([[7, 12]]);
    }
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toMatchObject({
      v: 4,
      s: "granted",
      r: "snapshot",
      e: 17,
      b: { "7": 10 },
      t: { "7": 14 },
      c: { "7": 3 },
    });
  });

  it("encoding is deterministic regardless of insertion order", () => {
    const a = encodeDomainEventCursor(new Map([[1, 5], [2, 9]]));
    const b = encodeDomainEventCursor(new Map([[2, 9], [1, 5]]));
    expect(a).toBe(b);
  });

  it("rejects unknown versions and malformed input", () => {
    const v5 = Buffer.from(JSON.stringify({ v: 5, w: { "1": 5 } })).toString("base64url");
    expect(decodeDomainEventCursor(v5)).toEqual({ ok: false, reason: "unknown_version" });

    const noW = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
    expect(decodeDomainEventCursor(noW)).toEqual({ ok: false, reason: "missing_watermarks" });

    const badAccount = Buffer.from(JSON.stringify({ v: 2, w: { "not-a-number": 1 } })).toString("base64url");
    expect(decodeDomainEventCursor(badAccount)).toEqual({ ok: false, reason: "invalid_account_id" });

    const badSeq = Buffer.from(JSON.stringify({ v: 2, w: { "1": -4 } })).toString("base64url");
    expect(decodeDomainEventCursor(badSeq)).toEqual({ ok: false, reason: "invalid_watermark" });

    const badScope = Buffer.from(JSON.stringify({ v: 2, w: { "1": 4 }, s: "all" })).toString("base64url");
    expect(decodeDomainEventCursor(badScope)).toEqual({ ok: false, reason: "invalid_scope" });

    const missingV3Scope = Buffer.from(JSON.stringify({ v: 3, w: { "1": 4 } })).toString("base64url");
    expect(decodeDomainEventCursor(missingV3Scope)).toEqual({ ok: false, reason: "invalid_scope" });

    const missingV4Recovery = Buffer.from(JSON.stringify({ v: 4, w: { "1": 4 } })).toString("base64url");
    expect(decodeDomainEventCursor(missingV4Recovery)).toEqual({ ok: false, reason: "invalid_recovery" });

    expect(decodeDomainEventCursor("!!!not-base64url!!!").ok).toBe(false);
    expect(decodeDomainEventCursor(Buffer.from("plain text").toString("base64url")).ok).toBe(false);
    expect(decodeDomainEventCursor(Buffer.from("[1,2]").toString("base64url")).ok).toBe(false);
  });
});
