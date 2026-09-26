import { describe, expect, it } from "vitest";

import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
} from "@agency_hub_core/contracts";

import { decodePreH3DomainEventCursor } from "./fixtures/legacy-v2-consumers/cursor-pre-h3.ts";

function wire(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

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
        expect(decoded.platform).toBeNull();
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
    const v7 = Buffer.from(JSON.stringify({ v: 7, w: { "1": 5 }, p: "onlyfans" })).toString("base64url");
    expect(decodeDomainEventCursor(v7)).toEqual({ ok: false, reason: "unknown_version" });

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

describe("domain event cursor platform binding (H3)", () => {
  const recovery = {
    kind: "snapshot" as const,
    erasureEpoch: 17,
    base: new Map([[7, 10]]),
    targets: new Map([[7, 14]]),
    retainedCounts: new Map([[7, 3]]),
  };

  it("mints v5 for a platform-bound cursor, with or without the grant scope", () => {
    for (const scope of [undefined, "granted" as const]) {
      const encoded = encodeDomainEventCursor(new Map([[7, 12]]), {
        ...(scope === undefined ? {} : { scope }),
        platform: "onlyfans",
      });
      expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
        v: 5,
        w: { "7": 12 },
        ...(scope === undefined ? {} : { s: scope }),
        p: "onlyfans",
      });
      const decoded = decodeDomainEventCursor(encoded);
      expect(decoded).toEqual({
        ok: true,
        watermarks: new Map([[7, 12]]),
        scope: scope ?? null,
        recovery: null,
        platform: "onlyfans",
      });
    }
  });

  it("mints v6 for a platform-bound snapshot-recovery cursor", () => {
    const encoded = encodeDomainEventCursor(new Map([[7, 12]]), {
      scope: "granted",
      recovery,
      platform: "fansly",
    });
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toMatchObject({
      v: 6,
      s: "granted",
      p: "fansly",
      r: "snapshot",
    });
    const decoded = decodeDomainEventCursor(encoded);
    expect(decoded.ok && decoded.platform).toBe("fansly");
    expect(decoded.ok && decoded.recovery).toEqual(recovery);
  });

  it("keeps unbound cursors byte-identical to the pre-H3 encoding (v2/v3/v4)", () => {
    expect(JSON.parse(Buffer.from(encodeDomainEventCursor(new Map([[7, 1]])), "base64url").toString()))
      .toEqual({ v: 2, w: { "7": 1 } });
    expect(JSON.parse(Buffer.from(
      encodeDomainEventCursor(new Map([[7, 1]]), { scope: "granted" }),
      "base64url",
    ).toString())).toEqual({ v: 3, w: { "7": 1 }, s: "granted" });
    expect(JSON.parse(Buffer.from(
      encodeDomainEventCursor(new Map([[7, 12]]), { recovery }),
      "base64url",
    ).toString())).toMatchObject({ v: 4, r: "snapshot" });
  });

  it("rejects a missing, unknown or misplaced platform", () => {
    expect(decodeDomainEventCursor(wire({ v: 5, w: { "1": 4 } })))
      .toEqual({ ok: false, reason: "invalid_platform" });
    expect(decodeDomainEventCursor(wire({ v: 5, w: { "1": 4 }, p: "myspace" })))
      .toEqual({ ok: false, reason: "invalid_platform" });
    // A `p` on an old version would be silently ignored by an old Core.
    for (const v of [2, 3, 4]) {
      expect(decodeDomainEventCursor(wire({ v, w: { "1": 4 }, s: v === 2 ? undefined : "granted", p: "onlyfans" })))
        .toEqual({ ok: false, reason: "invalid_platform" });
    }
    expect(decodeDomainEventCursor(wire({ v: 5, w: { "1": 4 }, p: "onlyfans", r: "snapshot" })))
      .toEqual({ ok: false, reason: "invalid_recovery" });
    expect(decodeDomainEventCursor(wire({ v: 6, w: { "1": 4 }, p: "onlyfans" })))
      .toEqual({ ok: false, reason: "invalid_recovery" });
    expect(decodeDomainEventCursor(wire({ v: 5, w: { "1": 4 }, s: "all", p: "onlyfans" })))
      .toEqual({ ok: false, reason: "invalid_scope" });
  });

  it("fails closed on the pre-H3 decoder (rollback safety): every bound cursor is unknown_version", () => {
    const bound = [
      encodeDomainEventCursor(new Map([[7, 12]]), { platform: "onlyfans" }),
      encodeDomainEventCursor(new Map([[7, 12]]), { scope: "granted", platform: "onlyfans" }),
      encodeDomainEventCursor(new Map([[7, 12]]), { scope: "granted", recovery, platform: "onlyfans" }),
      encodeDomainEventCursor(new Map([[7, 12]]), { recovery, platform: "fansly" }),
    ];
    for (const cursor of bound) {
      expect(decodePreH3DomainEventCursor(cursor)).toEqual({ ok: false, reason: "unknown_version" });
    }
    // ...while every unbound cursor the new encoder mints still decodes there.
    for (const cursor of [
      encodeDomainEventCursor(new Map([[7, 12]])),
      encodeDomainEventCursor(new Map([[7, 12]]), { scope: "granted" }),
      encodeDomainEventCursor(new Map([[7, 12]]), { scope: "granted", recovery }),
    ]) {
      expect(decodePreH3DomainEventCursor(cursor).ok).toBe(true);
    }
  });
});
