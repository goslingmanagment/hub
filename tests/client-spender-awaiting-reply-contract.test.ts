import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_CURSOR_REFUSAL_REASONS,
  CLIENT_HUB_CAPABILITY_NAMES,
  CLIENT_SPENDER_AWAITING_REPLY_DEFAULT_LIMIT,
  CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT,
  CLIENT_SPENDER_AWAITING_REPLY_READ_STATES,
  CLIENT_TOKEN_PROFILES,
  clientSpenderAwaitingReplyQuerySchema,
  clientSpenderAwaitingReplyResponseSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import { SPENDER_AWAITING_REPLY_MAX_LIMIT, type SpenderAwaitingReplyItem } from "@agency_hub_core/db";
import { encryptJson, SPENDER_AWAITING_REPLY_READ_STATES } from "@agency_hub_core/shared";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { CLIENT_FEATURE_REQUIREMENTS, evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import {
  encodeSignedCursor,
  SIGNED_CURSOR_MAX_LENGTH,
  SignedCursorInvalidError,
  type SignedCursorKeyRing,
  type SignedCursorScope,
} from "../apps/runtime/src/services/signed-cursor.ts";
import {
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN,
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE,
  CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS,
  decodeSpenderAwaitingReplyCursor,
  encodeSpenderAwaitingReplyCursor,
  toClientSpenderAwaitingReplyItem,
  type SpenderAwaitingReplyCursorState,
} from "../apps/runtime/src/services/spender-awaiting-reply.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";
import {
  frozenClientSpenderAwaitingReplyQuerySchema,
  frozenClientSpenderAwaitingReplySchema,
} from "./helpers/client-frozen-spender-awaiting-reply.ts";

// chat-extension H-8c: the wire shape of the awaiting-reply queue
// (`clientSpenderAwaitingReply`). The chat extension froze this route in its
// contracts (packages/contracts/src/hub/spenders.ts: QueueQuerySchema,
// QueuePageSchema) before the hub shipped it, so the samples below are the
// client's own, and the hub must take every query the client can build and
// answer in a body the client parses. The behavior is
// tests/client-spender-awaiting-reply.integration.test.ts.

/** The client's fixture of a valid answer (its packages/contracts/test/fixtures/hub.ts). */
function clientSample(): Record<string, unknown> {
  return {
    items: [{
      fanRef: "9000000002",
      username: "fan_two",
      displayName: null,
      lifetimeGrossMills: 900_000,
      lastFanMessageAt: "2026-10-03T12:05:00.000Z",
      lastModelMessageAt: "2026-10-03T12:00:00.000Z",
      unreadCount: null,
      readState: "unknown",
    }],
    total: 3,
    loaded: 1,
    unknown: 1,
    nextCursor: "cur-queue-2",
    asOf: "2026-10-03T12:00:00.000Z",
  };
}

function sampleItem(): Record<string, unknown> {
  return (clientSample().items as Array<Record<string, unknown>>)[0]!;
}

function withItem(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...clientSample(), items: [{ ...sampleItem(), ...patch }] };
}

/** A row as the repository reads it. */
function repositoryRow(patch: Partial<SpenderAwaitingReplyItem> = {}): SpenderAwaitingReplyItem {
  return {
    fanId: 41,
    fanRef: "518588958",
    username: "fan_two",
    displayName: "Fan Two",
    lifetimeGrossMills: 9_007_199_254_740_000n,
    lastFanMessageAt: new Date("2026-10-03T08:00:00.123Z"),
    lastModelMessageAt: new Date("2026-10-02T08:00:00.000Z"),
    unreadCount: 2,
    readState: "unread",
    position: { lifetimeGrossMills: 9_007_199_254_740_000n, lastFanMessageAtMicros: 1_759_478_400_123_456n, fanId: 41 },
    ...patch,
  };
}

describe("client awaiting-reply contract (H-8c)", () => {
  it("parses the client's own samples: a page with a cursor, and the empty last page", () => {
    expect(clientSpenderAwaitingReplyResponseSchema.parse(clientSample())).toEqual(clientSample());
    const empty = { ...clientSample(), items: [], nextCursor: null };
    expect(clientSpenderAwaitingReplyResponseSchema.parse(empty)).toEqual(empty);
    // And the client takes them from the hub's schema unchanged.
    expect(frozenClientSpenderAwaitingReplySchema.parse(clientSample())).toEqual(clientSample());
  });

  it("refuses what the client refuses: a fan id that is not a platform number", () => {
    // The client's own invalid sample; a body the hub's schema let through and
    // the client's did not would lose the client the whole page.
    for (const fanRef of ["fan_two", "", "0", "012", "1".repeat(31), " 12", "12a"]) {
      expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ fanRef })).success, fanRef).toBe(false);
      expect(frozenClientSpenderAwaitingReplySchema.safeParse(withItem({ fanRef })).success, fanRef).toBe(false);
    }
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ fanRef: "1".repeat(30) })).success).toBe(true);
  });

  it("keeps the read state open: an unknown one never fails the parse", () => {
    const body = withItem({ readState: "some_future_state" });
    expect(clientSpenderAwaitingReplyResponseSchema.parse(body)).toEqual(body);
    expect(frozenClientSpenderAwaitingReplySchema.parse(body)).toEqual(body);
    expect(CLIENT_SPENDER_AWAITING_REPLY_READ_STATES).toEqual(["unread", "read", "unknown"]);
  });

  it("strips a key it does not know instead of refusing the answer", () => {
    const parsed = clientSpenderAwaitingReplyResponseSchema.parse({
      ...withItem({ futureField: 1 }),
      futureCount: 1,
    });
    expect(parsed).not.toHaveProperty("futureCount");
    expect(parsed.items[0]).not.toHaveProperty("futureField");
  });

  it("takes money only as whole mills, counts never negative, and an unknown unread count as null", () => {
    for (const lifetimeGrossMills of [1.5, "900000", null]) {
      expect(
        clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ lifetimeGrossMills })).success,
        String(lifetimeGrossMills),
      ).toBe(false);
    }
    for (const key of ["total", "loaded", "unknown"]) {
      expect(clientSpenderAwaitingReplyResponseSchema.safeParse({ ...clientSample(), [key]: -1 }).success, key).toBe(false);
      expect(clientSpenderAwaitingReplyResponseSchema.safeParse({ ...clientSample(), [key]: 1.5 }).success, key).toBe(false);
    }
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ unreadCount: -1 })).success).toBe(false);
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ unreadCount: null })).success).toBe(true);
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ unreadCount: 0 })).success).toBe(true);
    // The fan's last message is what puts the row in the queue: never null. Ours may never have been sent.
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ lastFanMessageAt: null })).success).toBe(false);
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse(withItem({ lastModelMessageAt: null })).success).toBe(true);
    // A cursor is 1 to 2048 characters, or null at the end of the walk.
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse({ ...clientSample(), nextCursor: "" }).success).toBe(false);
    expect(clientSpenderAwaitingReplyResponseSchema.safeParse({ ...clientSample(), nextCursor: "c".repeat(2049) }).success)
      .toBe(false);
  });

  it("serializes a repository row into an item both the hub's and the client's schema take", () => {
    const item = toClientSpenderAwaitingReplyItem(repositoryRow());
    expect(item).toEqual({
      fanRef: "518588958",
      username: "fan_two",
      displayName: "Fan Two",
      // Mills cross as an exact integer up to the safe range.
      lifetimeGrossMills: 9_007_199_254_740_000,
      lastFanMessageAt: "2026-10-03T08:00:00.123Z",
      lastModelMessageAt: "2026-10-02T08:00:00.000Z",
      unreadCount: 2,
      readState: "unread",
    });
    // The hub's own ids and the keyset position stay in the hub.
    expect(item).not.toHaveProperty("fanId");
    expect(item).not.toHaveProperty("position");

    // The page never wrote, and the read state is unknown: nulls, never 0 or an invented time.
    const unknown = toClientSpenderAwaitingReplyItem(repositoryRow({
      username: null, displayName: null, lastModelMessageAt: null, unreadCount: null, readState: "unknown",
    }));
    expect(unknown).toMatchObject({
      username: null, displayName: null, lastModelMessageAt: null, unreadCount: null, readState: "unknown",
    });

    for (const served of [item, unknown]) {
      const body = { ...clientSample(), items: [served] };
      expect(clientSpenderAwaitingReplyResponseSchema.parse(body)).toEqual(body);
      expect(frozenClientSpenderAwaitingReplySchema.parse(body)).toEqual(body);
    }
  });

  it("does not serialize a row an installed client would refuse", () => {
    // Not a platform numeric id.
    for (const fanRef of ["of-user-x", "0123", "", "12 ", "1".repeat(31)]) {
      expect(toClientSpenderAwaitingReplyItem(repositoryRow({ fanRef })), fanRef).toBeNull();
    }
    // An instant the client's pattern does not take (a year past 9999), or no instant at all.
    const farFuture = new Date(Date.UTC(10_000, 0, 1));
    expect(farFuture.toISOString().startsWith("+010000")).toBe(true);
    expect(toClientSpenderAwaitingReplyItem(repositoryRow({ lastFanMessageAt: farFuture }))).toBeNull();
    expect(toClientSpenderAwaitingReplyItem(repositoryRow({ lastModelMessageAt: farFuture }))).toBeNull();
    expect(toClientSpenderAwaitingReplyItem(repositoryRow({ lastFanMessageAt: new Date(Number.NaN) }))).toBeNull();
    // The widest id the client takes is served.
    expect(toClientSpenderAwaitingReplyItem(repositoryRow({ fanRef: "9".repeat(30) }))?.fanRef).toBe("9".repeat(30));
  });

  it("takes every query the client builds: no cursor, a cursor, 1 to 100 rows", () => {
    // Query strings arrive as text.
    expect(clientSpenderAwaitingReplyQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(clientSpenderAwaitingReplyQuerySchema.parse({ cursor: "cur-queue-2", limit: "100" }))
      .toEqual({ cursor: "cur-queue-2", limit: 100 });
    expect(clientSpenderAwaitingReplyQuerySchema.parse({ limit: "1" })).toEqual({ limit: 1 });
    expect(CLIENT_SPENDER_AWAITING_REPLY_DEFAULT_LIMIT).toBe(50);
    expect(CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT).toBe(100);

    // The client's own bounds are the hub's: what one takes the other takes.
    for (const limit of [1, 50, 100]) {
      expect(frozenClientSpenderAwaitingReplyQuerySchema.safeParse({ limit }).success, String(limit)).toBe(true);
      expect(clientSpenderAwaitingReplyQuerySchema.safeParse({ limit: String(limit) }).success, String(limit)).toBe(true);
    }
    for (const cursor of ["c", "c".repeat(SIGNED_CURSOR_MAX_LENGTH)]) {
      expect(frozenClientSpenderAwaitingReplyQuerySchema.safeParse({ cursor }).success).toBe(true);
      expect(clientSpenderAwaitingReplyQuerySchema.safeParse({ cursor }).success).toBe(true);
    }
  });

  it("refuses a query that is not that: rows out of range, an empty or oversized cursor, an unknown key", () => {
    const refused: Array<Record<string, unknown>> = [
      { limit: "0" },
      { limit: "101" },
      { limit: "-1" },
      { limit: "1.5" },
      { limit: "ten" },
      { limit: "" },
      { cursor: "" },
      { cursor: "c".repeat(SIGNED_CURSOR_MAX_LENGTH + 1) },
      // The page is in the path. A page in the query would not be scope-checked,
      // so the strict query refuses it instead of ignoring it.
      { pageLabel: "lora-of" },
      { asOf: "2026-10-03T12:00:00.000Z" },
      { offset: "50" },
    ];
    for (const query of refused) {
      expect(clientSpenderAwaitingReplyQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("declares the route as a page-scoped device-token GET with the page in the path", () => {
    const route = routeSchemas.clientSpenderAwaitingReply as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      querystring?: unknown;
      params?: { safeParse(value: unknown): { success: boolean } };
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBeUndefined();
    expect(route.querystring).toBe(clientSpenderAwaitingReplyQuerySchema);
    expect(route.params?.safeParse({ pageLabel: "lora-of" }).success).toBe(true);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(kernelOperations.clientSpenderAwaitingReply).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/spenders/awaiting-reply",
    });
  });

  it("is on the narrow token's list and served as awaiting-reply-v1, which completes the stats feature", () => {
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientSpenderAwaitingReply");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("awaiting-reply-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("awaiting-reply-v1");
    // Everything the `stats` flag needs is served: the owner's switches decide from here on.
    for (const capability of CLIENT_FEATURE_REQUIREMENTS.stats.capabilities) {
      expect(SERVED_CLIENT_CAPABILITIES, capability).toContain(capability);
    }

    const page = { label: "lora-of", platform: "onlyfans" as const, platformAccountId: "100000001" };
    const on = { enabled: true, features: { "*": { stats: true } }, hostBindings: {} };
    expect(evaluateClientFeature({ settings: on, page, flag: "stats", served: SERVED_CLIENT_CAPABILITIES }))
      .toEqual({ available: true });
    // Serving the capability switches nothing on: at rest the feature is off.
    expect(evaluateClientFeature({
      settings: { enabled: false, features: {}, hostBindings: {} }, page, flag: "stats", served: SERVED_CLIENT_CAPABILITIES,
    })).toEqual({ available: false, reason: "disabled" });
    expect(evaluateClientFeature({
      settings: { ...on, features: {} }, page, flag: "stats", served: SERVED_CLIENT_CAPABILITIES,
    })).toEqual({ available: false, reason: "flag_off" });
    // The queue alone is not the feature either.
    expect(evaluateClientFeature({
      settings: on, page, flag: "stats", served: SERVED_CLIENT_CAPABILITIES.filter((name) => name !== "spenders-stats-v1"),
    })).toEqual({ available: false, reason: "hub_not_ready" });
  });

  it("reads one row past a page, so its largest page fits what the repository serves", () => {
    expect(CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT + 1).toBeLessThanOrEqual(SPENDER_AWAITING_REPLY_MAX_LIMIT);
  });

  it("names its cursor's domain and seal by route and version, and keeps a cursor good for an hour", () => {
    // Changing either name ends every walk under way: a deliberate act, pinned here.
    expect(CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN).toBe("agency-hub:client-awaiting-reply-cursor:v1");
    expect(CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE).toBe("agency-hub:client-awaiting-reply-cursor-seal:v1");
    expect(CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS).toBe(60 * 60_000);
  });

  describe("the cursor", () => {
    const NOW = new Date("2026-10-03T12:00:00.000Z");
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    const keyOne = Buffer.alloc(32, 7);
    const keyTwo = Buffer.alloc(32, 9);
    const ring: SignedCursorKeyRing = { key: keyOne, keyVersion: 1, keysByVersion: new Map([[1, keyOne]]) };
    const scope = { pageId: 8, userId: 41 };
    const state: SpenderAwaitingReplyCursorState = {
      after: { gross: "9007199254740993", at: "1759478400123456", fan: 314159 },
      loaded: 150,
    };
    const subkeyOf = (rootKey: Buffer, purpose: string) => createHmac("sha256", rootKey).update(purpose, "utf8").digest();
    /** Signs `signed` where the route's sealed state goes, with the route's domain. */
    const signWith = (signed: unknown, keys: SignedCursorKeyRing = ring) => encodeSignedCursor(
      { domain: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN, state: z.unknown() },
      { scope, state: signed, now: NOW },
      keys,
    );
    const refusal = (
      cursor: string,
      expected: { scope: SignedCursorScope; now: Date } = { scope, now: NOW },
      keys: Pick<SignedCursorKeyRing, "keysByVersion"> = ring,
    ) => {
      try {
        decodeSpenderAwaitingReplyCursor(keys, cursor, expected);
      } catch (error) {
        expect(error).toBeInstanceOf(SignedCursorInvalidError);
        return (error as SignedCursorInvalidError).reason;
      }
      throw new Error("the cursor was taken");
    };

    it("carries a walk's place and count back exactly, bigints included", () => {
      const cursor = encodeSpenderAwaitingReplyCursor(ring, { scope, state, now: NOW });
      expect(decodeSpenderAwaitingReplyCursor(ring, cursor, { scope, now: NOW })).toEqual(state);
      // A cursor fits the contract's cursor field with room to spare.
      expect(cursor.length).toBeLessThan(SIGNED_CURSOR_MAX_LENGTH / 2);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is sealed: its holder reads an AES-GCM envelope and nothing of the walk", () => {
      const cursor = encodeSpenderAwaitingReplyCursor(ring, { scope, state, now: NOW });
      const text = Buffer.from(cursor, "base64url").toString("utf8");
      const envelope = JSON.parse(text) as { payload: { st: Record<string, unknown> } };
      expect(Object.keys(envelope.payload.st).sort()).toEqual(["alg", "ciphertext", "iv", "keyVersion", "tag"]);
      const sealedBytes = Buffer.from(String(envelope.payload.st.ciphertext), "base64").toString("latin1");
      for (const secret of [
        ...["after", "gross", "at", "fan", "loaded", "pageId", "userId"].map((name) => JSON.stringify(name)),
        state.after.gross,
        state.after.at,
        String(state.after.fan),
      ]) {
        expect(text, secret).not.toContain(secret);
        expect(sealedBytes, secret).not.toContain(secret);
      }
      // One place, two tokens: the seal is not a fingerprint of the position.
      expect(encodeSpenderAwaitingReplyCursor(ring, { scope, state, now: NOW })).not.toBe(cursor);
    });

    it("is good for an hour after it was issued, for the page and the person it was issued for", () => {
      const cursor = encodeSpenderAwaitingReplyCursor(ring, { scope, state, now: NOW });
      const hour = CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS;
      expect(decodeSpenderAwaitingReplyCursor(ring, cursor, { scope, now: later(hour) })).toEqual(state);
      expect(refusal(cursor, { scope, now: later(hour + 1) })).toBe("expired");
      // The hour counts from the cursor's own issue, so the cursor of a later
      // page of the same walk is good again: the hour bounds a gap, not a walk.
      const next = encodeSpenderAwaitingReplyCursor(ring, { scope, state: { ...state, loaded: 250 }, now: later(hour) });
      expect(decodeSpenderAwaitingReplyCursor(ring, next, { scope, now: later(2 * hour) }).loaded).toBe(250);
      expect(refusal(next, { scope, now: later(2 * hour + 1) })).toBe("expired");

      for (const other of [{ ...scope, pageId: 9 }, { ...scope, userId: 42 }, { pageId: 8 }, { ...scope, fanRef: "1" }]) {
        expect(refusal(cursor, { scope: other, now: NOW }), JSON.stringify(other)).toBe("signature");
      }
    });

    it("refuses a state that is not sealed as the route seals it, though this hub signed it", () => {
      const sealKey = subkeyOf(keyOne, CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE);
      // The construction the tests below vary is the route's own.
      expect(decodeSpenderAwaitingReplyCursor(ring, signWith(encryptJson(state, sealKey, 1)), { scope, now: NOW }))
        .toEqual(state);

      const sealed = encryptJson(state, sealKey, 1);
      const cases: Array<[string, unknown]> = [
        ["the state in the clear", state],
        ["sealed with the ring's own key", encryptJson(state, keyOne, 1)],
        ["sealed as another route seals", encryptJson(state, subkeyOf(keyOne, "agency-hub:client-feed-cursor-seal:v1"), 1)],
        ["a seal with one byte changed", { ...sealed, ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}` }],
        ["a seal with a key too many", { ...sealed, note: "x" }],
        ["a seal of another state", encryptJson({ ...state, offset: 5 }, sealKey, 1)],
        ["a seal of a position that is not a number", encryptJson({ ...state, after: { ...state.after, gross: "abc" } }, sealKey, 1)],
        ["a seal of a position past a bigint", encryptJson({ ...state, after: { ...state.after, at: "1".repeat(20) } }, sealKey, 1)],
        ["a seal of text", encryptJson("next", sealKey, 1)],
      ];
      for (const [label, signed] of cases) {
        expect(refusal(signWith(signed)), label).toBe("payload");
      }
      expect(refusal(signWith(encryptJson(state, sealKey, 99)))).toBe("unknown_key_version");
    });

    it("outlives a key rotation while the old key stays in the ring, and no longer", () => {
      const cursor = encodeSpenderAwaitingReplyCursor(ring, { scope, state, now: NOW });
      const rotated: SignedCursorKeyRing = { key: keyTwo, keyVersion: 2, keysByVersion: new Map([[1, keyOne], [2, keyTwo]]) };
      expect(decodeSpenderAwaitingReplyCursor(rotated, cursor, { scope, now: NOW })).toEqual(state);
      // A cursor issued after the rotation is signed and sealed with the new key.
      const fresh = encodeSpenderAwaitingReplyCursor(rotated, { scope, state, now: NOW });
      expect(decodeSpenderAwaitingReplyCursor(rotated, fresh, { scope, now: NOW })).toEqual(state);
      expect(refusal(fresh)).toBe("unknown_key_version");
      // The old key leaves the ring: the old cursor stops opening.
      expect(refusal(cursor, { scope, now: NOW }, { keysByVersion: new Map([[2, keyTwo]]) })).toBe("unknown_key_version");
      // Another deployment's key under the same version number is not ours.
      expect(refusal(cursor, { scope, now: NOW }, { keysByVersion: new Map([[1, keyTwo]]) })).toBe("signature");
    });

    it("does not issue a cursor for a state that is not the route's", () => {
      const broken = { ...state, after: { ...state.after, fan: 0 } };
      expect(() => encodeSpenderAwaitingReplyCursor(ring, { scope, state: broken, now: NOW })).toThrow();
    });
  });

  it("re-exports the known values from the generated SDK, equal to the definitions the rows follow", () => {
    for (const name of [
      "CLIENT_CURSOR_REFUSAL_REASONS",
      "CLIENT_SPENDER_AWAITING_REPLY_DEFAULT_LIMIT",
      "CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT",
      "CLIENT_SPENDER_AWAITING_REPLY_READ_STATES",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
    // The contract cannot import the definitions (they are not vendored into the
    // client SDK), so it restates the read states; this holds the two together.
    expect(CLIENT_SPENDER_AWAITING_REPLY_READ_STATES).toEqual([...SPENDER_AWAITING_REPLY_READ_STATES]);
    expect(CLIENT_CURSOR_REFUSAL_REASONS).toEqual(["cursor_invalid"]);
  });
});
