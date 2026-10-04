import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { decodeAgentCursor, encodeAgentCursor } from "../apps/runtime/src/modules/agent-read/index.ts";
import {
  canonicalJson,
  decodeSignedCursor,
  encodeSignedCursor,
  SIGNED_CURSOR_MAX_LENGTH,
  signedCursorKeyRing,
  SignedCursorInvalidError,
  type SignedCursorKeyRing,
  type SignedCursorRefusal,
  type SignedCursorSpec,
} from "../apps/runtime/src/services/signed-cursor.ts";

// The shared signed-cursor core (H-9b): the chat-extension feed, awaiting-reply
// queue and "new subscribers" list sign their cursors with it, and the Agent
// Read Plane's envelope now lives in it too.

const KEY_V1 = Buffer.alloc(32, 7);
const KEY_V2 = Buffer.alloc(32, 8);
const FOREIGN_KEY = Buffer.alloc(32, 9);

const ring: SignedCursorKeyRing = { key: KEY_V1, keyVersion: 1, keysByVersion: new Map([[1, KEY_V1]]) };

const feedState = z.object({
  before: z.object({ at: z.string().nullable(), ref: z.string() }).strict(),
  snapshot: z.object({ archiveMaxId: z.number().int(), dmMaxId: z.number().int() }).strict(),
}).strict();
type FeedState = z.infer<typeof feedState>;

const spec: SignedCursorSpec<FeedState> = {
  domain: "agency-hub:test-feed-cursor:v1",
  state: feedState,
  ttlMs: 10 * 60_000,
};

const scope = { pageId: 8, fanRef: "518588958", userId: 77, archiveGeneration: 3 };
const state: FeedState = {
  before: { at: "2026-07-01T10:00:00.123456Z", ref: "1001" },
  snapshot: { archiveMaxId: 900, dmMaxId: 400 },
};
const now = new Date("2026-10-03T12:00:00.000Z");

function refusal(run: () => unknown): SignedCursorRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SignedCursorInvalidError);
    // One message for every refusal: the reason is for tests and internal logs.
    expect((error as Error).message).toBe("cursor is not valid for this request");
    return (error as SignedCursorInvalidError).reason;
  }
  throw new Error("expected the cursor to be refused");
}

function envelopeOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
}

function reencode(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

describe("signed cursor core: scoped cursors", () => {
  it("round-trips the state for the scope it was minted for", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    expect(decodeSignedCursor(spec, token, { scope, now }, ring)).toEqual(state);
    // Scope key order is irrelevant: the binding is canonical.
    const reordered = { archiveGeneration: 3, userId: 77, fanRef: "518588958", pageId: 8 };
    expect(decodeSignedCursor(spec, token, { scope: reordered, now }, ring)).toEqual(state);
  });

  it("is opaque on the wire and never carries the scope it is bound to", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(SIGNED_CURSOR_MAX_LENGTH);
    const json = Buffer.from(token, "base64url").toString("utf8");
    expect(json).not.toContain("518588958");
    expect(json).not.toContain("userId");
    expect(json).not.toContain("archiveGeneration");
    expect(Object.keys(envelopeOf(token)).sort()).toEqual(["format", "keyVersion", "mac", "payload"]);
  });

  it("refuses a tampered state", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    const envelope = envelopeOf(token) as { payload: { st: FeedState } };
    envelope.payload.st.before.ref = "999";
    expect(refusal(() => decodeSignedCursor(spec, reencode(envelope), { scope, now }, ring))).toBe("signature");
  });

  it("refuses a tampered issue time (an attempt to outlive the lifetime)", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    const envelope = envelopeOf(token) as { payload: { iat: number } };
    envelope.payload.iat += 60 * 60_000;
    expect(refusal(() => decodeSignedCursor(spec, reencode(envelope), { scope, now }, ring))).toBe("signature");
  });

  it("refuses a cursor signed with a key outside the ring", () => {
    const forged = encodeSignedCursor(spec, { scope, state, now }, {
      key: FOREIGN_KEY,
      keyVersion: 1,
      keysByVersion: new Map([[1, FOREIGN_KEY]]),
    });
    expect(refusal(() => decodeSignedCursor(spec, forged, { scope, now }, ring))).toBe("signature");
  });

  it.each([
    ["another fan", { ...scope, fanRef: "514788334" }],
    ["another page", { ...scope, pageId: 9 }],
    ["another user", { ...scope, userId: 78 }],
    ["another archive generation", { ...scope, archiveGeneration: 4 }],
    ["a narrower scope", { pageId: 8, fanRef: "518588958", userId: 77 }],
    ["a wider scope", { ...scope, windowHours: 48 }],
    ["a type change", { ...scope, userId: "77" }],
  ])("refuses a foreign scope: %s", (_name, foreign) => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    expect(refusal(() => decodeSignedCursor(spec, token, { scope: foreign, now }, ring))).toBe("signature");
  });

  it("refuses another route's cursor even with the same state shape and scope", () => {
    const other: SignedCursorSpec<FeedState> = { ...spec, domain: "agency-hub:test-queue-cursor:v1" };
    const token = encodeSignedCursor(other, { scope, state, now }, ring);
    expect(refusal(() => decodeSignedCursor(spec, token, { scope, now }, ring))).toBe("signature");
  });

  it("expires after its lifetime, not before", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    const atLimit = new Date(now.getTime() + 10 * 60_000);
    expect(decodeSignedCursor(spec, token, { scope, now: atLimit }, ring)).toEqual(state);
    const expired = new Date(now.getTime() + 10 * 60_000 + 1);
    expect(refusal(() => decodeSignedCursor(spec, token, { scope, now: expired }, ring))).toBe("expired");
  });

  it("has no clock when the spec sets no lifetime", () => {
    const timeless: SignedCursorSpec<FeedState> = { domain: spec.domain, state: feedState };
    const token = encodeSignedCursor(timeless, { scope, state, now }, ring);
    const muchLater = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
    expect(decodeSignedCursor(timeless, token, { scope, now: muchLater }, ring)).toEqual(state);
  });

  it("refuses a cursor issued in the future beyond clock skew", () => {
    const token = encodeSignedCursor(spec, { scope, state, now: new Date(now.getTime() + 6 * 60_000) }, ring);
    expect(refusal(() => decodeSignedCursor(spec, token, { scope, now }, ring))).toBe("payload");
    const skewed = encodeSignedCursor(spec, { scope, state, now: new Date(now.getTime() + 60_000) }, ring);
    expect(decodeSignedCursor(spec, skewed, { scope, now }, ring)).toEqual(state);
  });

  it("decodes across a key rotation while the old version stays in the ring", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    const rotated: SignedCursorKeyRing = {
      key: KEY_V2,
      keyVersion: 2,
      keysByVersion: new Map([[1, KEY_V1], [2, KEY_V2]]),
    };
    expect(decodeSignedCursor(spec, token, { scope, now }, rotated)).toEqual(state);
    const fresh = encodeSignedCursor(spec, { scope, state, now }, rotated);
    expect(envelopeOf(fresh).keyVersion).toBe(2);
    const retired: SignedCursorKeyRing = { key: KEY_V2, keyVersion: 2, keysByVersion: new Map([[2, KEY_V2]]) };
    expect(refusal(() => decodeSignedCursor(spec, token, { scope, now }, retired))).toBe("unknown_key_version");
  });

  it("refuses a state its decoder would rewrite", () => {
    // Signed by a looser schema: valid MAC, but a decoder that strips the extra
    // key would serve a state the cursor never carried.
    const loose: SignedCursorSpec<Record<string, unknown>> = {
      domain: spec.domain,
      state: z.object({ before: z.unknown(), snapshot: z.unknown() }).passthrough(),
    };
    const token = encodeSignedCursor(loose, { scope, state: { ...state, extra: 1 }, now }, ring);
    const stripping: SignedCursorSpec<FeedState> = {
      domain: spec.domain,
      state: z.object({
        before: z.object({ at: z.string().nullable(), ref: z.string() }),
        snapshot: z.object({ archiveMaxId: z.number(), dmMaxId: z.number() }),
      }) as unknown as z.ZodType<FeedState>,
    };
    expect(refusal(() => decodeSignedCursor(stripping, token, { scope, now }, ring))).toBe("payload");
    expect(refusal(() => decodeSignedCursor(spec, token, { scope, now }, ring))).toBe("payload");
  });

  it("refuses garbage, empty, oversized, padded and non-canonical input", () => {
    const token = encodeSignedCursor(spec, { scope, state, now }, ring);
    const decode = (text: string) => () => decodeSignedCursor(spec, text, { scope, now }, ring);
    expect(refusal(decode(""))).toBe("malformed");
    expect(refusal(decode("not base64!!"))).toBe("malformed");
    expect(refusal(decode("a".repeat(SIGNED_CURSOR_MAX_LENGTH + 1)))).toBe("malformed");
    expect(refusal(decode(`${token}=`))).toBe("malformed");
    expect(refusal(decode(Buffer.from('{"nope":1}', "utf8").toString("base64url")))).toBe("malformed");
    // Same JSON, keys out of order: one cursor has exactly one valid spelling.
    const envelope = envelopeOf(token);
    const shuffled = Buffer.from(JSON.stringify({
      payload: envelope.payload, mac: envelope.mac, keyVersion: envelope.keyVersion, format: envelope.format,
    }), "utf8").toString("base64url");
    expect(refusal(decode(shuffled))).toBe("malformed");
  });

  it("refuses to mint a cursor the wire cannot carry", () => {
    const big: SignedCursorSpec<{ blob: string }> = {
      domain: spec.domain,
      state: z.object({ blob: z.string() }).strict(),
    };
    expect(() => encodeSignedCursor(big, { scope, state: { blob: "x".repeat(2000) }, now }, ring))
      .toThrow(/over 2048/);
  });

  it("builds its key ring from the deployment's encryption ring", () => {
    const keys = new Map([[1, KEY_V1], [2, KEY_V2]]);
    const fromConfig = signedCursorKeyRing({ encryptionKey: KEY_V2, encryptionKeyVersion: 2, encryptionKeysByVersion: keys });
    expect(fromConfig.keyVersion).toBe(2);
    expect(fromConfig.key.equals(KEY_V2)).toBe(true);
    expect([...fromConfig.keysByVersion.keys()]).toEqual([1, 2]);
  });
});

describe("signed cursor core: the agent envelope is unchanged", () => {
  const agentRing = { key: KEY_V1, keyVersion: 2, keysByVersion: new Map([[2, KEY_V1]]) };
  const agentPayload = {
    operation: "agentThreadMessages",
    resource: "conversation:4:555001",
    keyId: 42,
    pageIds: [5, 4],
    params: { from: "2026-01-08T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z", limit: 50, direction: undefined },
    archiveGeneration: 3,
    sourceHighWaters: { message_archive: "912" },
    seqHighWater: { "4": 1200 },
    keyset: { sortValue: "2026-01-19T00:00:00.000Z", key: "912" },
    issuedAt: "2026-10-03T12:00:00.000Z",
  };
  // Minted by the agent cursor code BEFORE its envelope moved into the core.
  const GOLDEN = "eyJmb3JtYXQiOjEsImtleVZlcnNpb24iOjIsIm1hYyI6InBoRDV3MUUxaGVQZEg1bVhZYXAwcnBDUlZPMW9QTno1TEg5QUZGSjBmR0EiLCJwYXlsb2FkIjp7ImFyY2hpdmVHZW5lcmF0aW9uIjozLCJpc3N1ZWRBdCI6IjIwMjYtMTAtMDNUMTI6MDA6MDAuMDAwWiIsImtleUlkIjo0Miwia2V5c2V0Ijp7ImtleSI6IjkxMiIsInNvcnRWYWx1ZSI6IjIwMjYtMDEtMTlUMDA6MDA6MDAuMDAwWiJ9LCJvcGVyYXRpb24iOiJhZ2VudFRocmVhZE1lc3NhZ2VzIiwicGFnZUlkcyI6WzUsNF0sInBhcmFtcyI6eyJmcm9tIjoiMjAyNi0wMS0wOFQwMDowMDowMC4wMDBaIiwibGltaXQiOjUwLCJ0byI6IjIwMjYtMDEtMjBUMDA6MDA6MDAuMDAwWiJ9LCJwYXJhbXNIYXNoIjoiMTYyNmE2MDFjZjlmYTllOTg3NmE5NWU2NGEzODcxZDY4OGMzMTIyNzkzZDkxMTM1MTk3NGJhN2RhNDA4NTYzZSIsInJlc291cmNlIjoiY29udmVyc2F0aW9uOjQ6NTU1MDAxIiwic2VxSGlnaFdhdGVyIjp7IjQiOjEyMDB9LCJzb3VyY2VIaWdoV2F0ZXJzIjp7Im1lc3NhZ2VfYXJjaGl2ZSI6IjkxMiJ9LCJ2ZXJzaW9uIjoxfX0";

  it("mints the same bytes and decodes them", () => {
    expect(encodeAgentCursor(agentPayload, agentRing)).toBe(GOLDEN);
    expect(decodeAgentCursor(GOLDEN, {
      operation: "agentThreadMessages",
      resource: "conversation:4:555001",
      keyId: 42,
      pageIds: [4, 5],
      archiveGeneration: 3,
    }, agentRing).keyset).toEqual({ sortValue: "2026-01-19T00:00:00.000Z", key: "912" });
  });

  it("an agent cursor is never a scoped cursor, and the reverse", () => {
    const agentSpec: SignedCursorSpec<unknown> = { domain: "agency-hub:agent-read-cursor:v1", state: z.unknown() };
    expect(refusal(() => decodeSignedCursor(agentSpec, GOLDEN, { scope: {}, now }, agentRing))).toBe("signature");
    const scoped = encodeSignedCursor(spec, { scope, state, now }, agentRing);
    expect(() => decodeAgentCursor(scoped, {
      operation: "agentThreadMessages", resource: "conversation:4:555001", keyId: 42, pageIds: [4, 5], archiveGeneration: 3,
    }, agentRing)).toThrow("cursor is not valid for this request");
  });
});
