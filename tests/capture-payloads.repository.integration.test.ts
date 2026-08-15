import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeCaptureJson,
  getPayloadObject,
  putPayloadObject,
} from "@agency_hub_core/db";
import type { CapturePayloadLane } from "@agency_hub_core/db";

// Direct module import on purpose: the body reader is deliberately NOT on the
// package barrel (tests/capture-payload-barrel.test.ts pins that), because an
// object id is an address, not an authorization. Runtime callers reach bodies
// through the envelope seam; this test is inside the store's own boundary.
import { loadPayloadBody } from "../packages/db/src/repositories/capture-payloads.ts";

import type * as capturePayloadCodec from "../packages/db/src/capture-payload-codec.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The collision path cannot be reached with real sha256, so the digest is the
// one thing this suite is allowed to lie about. Everything else — the identity
// tuple, the full-content comparison, the ordinal allocation — runs for real.
const digestControl = vi.hoisted(() => ({ forced: null as Buffer | null }));

vi.mock("../packages/db/src/capture-payload-codec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof capturePayloadCodec>();
  return {
    ...actual,
    digestCapturePayload: (input: Parameters<typeof actual.digestCapturePayload>[0]) =>
      digestControl.forced ?? actual.digestCapturePayload(input),
  };
});

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  digestControl.forced = null;
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const AUGUST = new Date("2026-08-15T12:00:00.000Z");
const SEPTEMBER = new Date("2026-09-01T00:30:00.000Z");

function jsonPut(overrides: {
  json: unknown;
  captureInstant?: Date;
  lane?: CapturePayloadLane;
  platformAccountId?: number | null;
}) {
  return {
    representation: "canonical_json" as const,
    json: overrides.json,
    captureInstant: overrides.captureInstant ?? AUGUST,
    lane: overrides.lane ?? ("platform_capture" as const),
    // `?? ` would swallow an explicit null, which is exactly the case the
    // NULLS NOT DISTINCT test is about.
    platformAccountId: overrides.platformAccountId === undefined ? 4242 : overrides.platformAccountId,
  };
}

async function countObjects(db: StartedTestDatabase) {
  const rows = await db.pool.query<{ n: string }>(
    "select count(*)::text as n from capture_payload_objects",
  );
  return Number(rows.rows[0]?.n ?? "0");
}

describe("capture payload objects — roundtrip", () => {
  it("stores and returns a canonical JSON body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const body = { b: 2, a: { z: 1, y: [1, 2] } };
    const put = await putPayloadObject(testDb.db, jsonPut({ json: body }));

    expect(put.created).toBe(true);
    expect(put.bucketMonth).toBe("2026-08-01");
    expect(put.collisionOrdinal).toBe(0);
    expect(put.representation).toBe("canonical_json");
    expect(put.codecVersion).toBe(1);
    expect(put.logicalBytes).toBe(canonicalizeCaptureJson(body).length);
    expect(put.accessClass).toBe("ordinary_capture");
    expect(put.erasureDomain).toBe("fan_subject");

    const object = await getPayloadObject(testDb.db, put);
    expect(object).toMatchObject({
      bucketMonth: "2026-08-01",
      objectId: put.objectId,
      platformAccountId: 4242,
      accessClass: "ordinary_capture",
      erasureDomain: "fan_subject",
      representation: "canonical_json",
      codecVersion: 1,
      collisionOrdinal: 0,
      storageTier: "hot",
    });
    expect(Buffer.compare(object!.contentSha256, put.contentSha256)).toBe(0);
    expect(object!.firstSeenAt.toISOString()).toBe(AUGUST.toISOString());

    const loaded = await loadPayloadBody(testDb.db, put);
    expect(loaded).toEqual({ representation: "canonical_json", json: body });
  });

  it("stores exact wire octets verbatim, without JSON reserialization", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Whitespace and key order that a JSON round trip would destroy.
    const wire = Buffer.from('{ "b" : 2,\n  "a": 1 }', "utf8");
    const put = await putPayloadObject(testDb.db, {
      representation: "exact_bytes",
      canonicalBytes: wire,
      captureInstant: AUGUST,
      lane: "platform_capture",
      platformAccountId: 4242,
      contentType: "application/json",
    });

    expect(put.created).toBe(true);
    expect(put.codecVersion).toBe(0);
    expect(put.logicalBytes).toBe(wire.length);

    const object = await getPayloadObject(testDb.db, put);
    expect(object).toMatchObject({ representation: "exact_bytes", contentType: "application/json" });

    const loaded = await loadPayloadBody(testDb.db, put);
    expect(loaded?.representation).toBe("exact_bytes");
    expect(Buffer.compare(
      (loaded as { representation: "exact_bytes"; bytes: Buffer }).bytes,
      wire,
    )).toBe(0);
  });

  it("never mixes the two representations of the same logical content", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const asJson = await putPayloadObject(testDb.db, jsonPut({ json: { a: 1 } }));
    const asBytes = await putPayloadObject(testDb.db, {
      representation: "exact_bytes",
      canonicalBytes: Buffer.from('{"a":1}', "utf8"),
      captureInstant: AUGUST,
      lane: "platform_capture",
      platformAccountId: 4242,
    });

    expect(asBytes.objectId).not.toBe(asJson.objectId);
    expect(await countObjects(testDb)).toBe(2);
  });
});

describe("capture payload objects — dedup identity", () => {
  it("collapses identical content in the same month and scope onto one object", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const first = await putPayloadObject(testDb.db, jsonPut({ json: { b: 2, a: 1 } }));
    // Different key order on the wire — the codec makes it the same content.
    const second = await putPayloadObject(testDb.db, jsonPut({ json: { a: 1, b: 2 } }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.objectId).toBe(first.objectId);
    expect(await countObjects(testDb)).toBe(1);

    const bodies = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from capture_json_hot_bodies",
    );
    expect(bodies.rows[0]!.n).toBe("1");
  });

  it("keeps the same digest in a different scope on separate objects", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const body = { note: "identical bytes" };
    const ordinary = await putPayloadObject(testDb.db, jsonPut({ json: body }));
    // restricted_ai must NEVER coalesce with ordinary capture, however equal
    // the bytes are — a shared body row would hand restricted material to an
    // ordinary reader.
    const restricted = await putPayloadObject(testDb.db, jsonPut({ json: body, lane: "ai_generation" }));
    // Different erasure domain: a different sweep is allowed to rewrite it.
    const accountState = await putPayloadObject(
      testDb.db,
      jsonPut({ json: body, lane: "platform_account_state" }),
    );
    // Different account.
    const otherAccount = await putPayloadObject(
      testDb.db,
      jsonPut({ json: body, platformAccountId: 99 }),
    );

    const ids = new Set([ordinary, restricted, accountState, otherAccount].map((row) => row.objectId));
    expect(ids.size).toBe(4);
    expect(await countObjects(testDb)).toBe(4);

    const digests = new Set(
      [ordinary, restricted, accountState, otherAccount].map((row) => row.contentSha256.toString("hex")),
    );
    expect(digests.size).toBe(1); // same digest, four scopes, four objects

    expect((await getPayloadObject(testDb.db, restricted))?.accessClass).toBe("restricted_ai");
  });

  it("re-creates the object in a new month — a closed month is ref-closed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const august = await putPayloadObject(testDb.db, jsonPut({ json: { a: 1 } }));
    const september = await putPayloadObject(
      testDb.db,
      jsonPut({ json: { a: 1 }, captureInstant: SEPTEMBER }),
    );

    expect(august.bucketMonth).toBe("2026-08-01");
    expect(september.bucketMonth).toBe("2026-09-01");
    expect(september.created).toBe(true);
    expect(september.objectId).not.toBe(august.objectId);
    expect(await countObjects(testDb)).toBe(2);
  });

  it("dedups accountless capture too (NULLS NOT DISTINCT)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Ingest and auth audit genuinely capture with no mapped account. Under
    // ordinary null semantics every one of these rows would be its own object.
    const body = { event: "unmapped" };
    const first = await putPayloadObject(testDb.db, jsonPut({ json: body, platformAccountId: null }));
    const second = await putPayloadObject(testDb.db, jsonPut({ json: body, platformAccountId: null }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.objectId).toBe(first.objectId);

    const mapped = await putPayloadObject(testDb.db, jsonPut({ json: body, platformAccountId: 4242 }));
    expect(mapped.created).toBe(true);
    expect(mapped.objectId).not.toBe(first.objectId);

    expect(await countObjects(testDb)).toBe(2);
    expect((await getPayloadObject(testDb.db, first))?.platformAccountId).toBeNull();
  });
});

describe("capture payload objects — collisions", () => {
  it("gives a differing body its own ordinal instead of coalescing on the hash", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Same forced digest, same canonical length, different content: the exact
    // shape the identity tuple cannot distinguish on its own.
    digestControl.forced = Buffer.alloc(32, 0xab);

    const first = await putPayloadObject(testDb.db, jsonPut({ json: { k: "aaa" } }));
    const second = await putPayloadObject(testDb.db, jsonPut({ json: { k: "bbb" } }));

    // Neither capture was rolled back and neither was coalesced.
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.collisionOrdinal).toBe(0);
    expect(second.collisionOrdinal).toBe(1);
    expect(second.objectId).not.toBe(first.objectId);
    expect(first.contentSha256.toString("hex")).toBe(second.contentSha256.toString("hex"));

    // Both bodies survive and are individually retrievable.
    expect(await loadPayloadBody(testDb.db, first)).toEqual({
      representation: "canonical_json",
      json: { k: "aaa" },
    });
    expect(await loadPayloadBody(testDb.db, second)).toEqual({
      representation: "canonical_json",
      json: { k: "bbb" },
    });

    // A third put of the FIRST body still finds ordinal 0 — the collision does
    // not break dedup for content that really is equal.
    const repeat = await putPayloadObject(testDb.db, jsonPut({ json: { k: "aaa" } }));
    expect(repeat.created).toBe(false);
    expect(repeat.objectId).toBe(first.objectId);
    expect(await countObjects(testDb)).toBe(2);
  });
});

describe("capture payload objects — transaction composition and partitions", () => {
  it("composes into a caller's transaction instead of committing on its own", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const db = testDb.db;
    await expect(db.transaction(async (tx) => {
      const inner = tx as unknown as typeof db;
      const first = await putPayloadObject(inner, jsonPut({ json: { a: 1 } }));
      const second = await putPayloadObject(inner, jsonPut({ json: { a: 1 } }));
      expect(second.objectId).toBe(first.objectId);
      throw new Error("caller aborts");
    })).rejects.toThrow(/caller aborts/);

    // The caller's rollback took the catalog row, its body and its location
    // with it: no half-written object survives a failed capture transaction.
    expect(await countObjects(testDb)).toBe(0);
    const bodies = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from capture_json_hot_bodies",
    );
    expect(bodies.rows[0]!.n).toBe("0");
  });

  it("rejects a location that cannot say where the body is", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const put = await putPayloadObject(testDb.db, jsonPut({ json: { a: 1 } }));
    const where = "where bucket_month = $1::date and object_id = $2";
    const key = [put.bucketMonth, put.objectId];

    // The writer's own row is the hot shape: no locators.
    const written = await testDb.pool.query<{
      storage_tier: string;
      segment_id: string | null;
      row_locator: string | null;
    }>(
      `select storage_tier, segment_id::text as segment_id, row_locator::text as row_locator
       from capture_payload_locations ${where}`,
      key,
    );
    expect(written.rows[0]).toEqual({ storage_tier: "hot", segment_id: null, row_locator: null });

    // A 'cold' row with no locators is a body the system believes it moved and
    // cannot find — silent loss wearing the shape of a valid row.
    await expect(testDb.pool.query(
      `update capture_payload_locations set storage_tier = 'cold' ${where}`,
      key,
    )).rejects.toThrow(/capture_payload_locations_locator_check/);

    // Half a locator is no locator.
    await expect(testDb.pool.query(
      `update capture_payload_locations set storage_tier = 'cold', segment_id = 7 ${where}`,
      key,
    )).rejects.toThrow(/capture_payload_locations_locator_check/);

    // And 'hot' with locators is two contradictory answers to "where is it".
    await expect(testDb.pool.query(
      `update capture_payload_locations set segment_id = 7, row_locator = 9 ${where}`,
      key,
    )).rejects.toThrow(/capture_payload_locations_locator_check/);

    // The complete cold shape is the only one that passes.
    await testDb.pool.query(
      `update capture_payload_locations
          set storage_tier = 'cold', segment_id = 7, row_locator = 9 ${where}`,
      key,
    );
    expect((await getPayloadObject(testDb.db, put))?.storageTier).toBe("cold");
  });

  it("fails loudly when the bucket month has no partition, and leaves nothing behind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // 2027-03 sits in the gap between the pre-created monthlies (…2027-02) and
    // the 2031 catch-all. A capture there must fail, never land elsewhere.
    await expect(putPayloadObject(
      testDb.db,
      jsonPut({ json: { a: 1 }, captureInstant: new Date("2027-03-05T00:00:00.000Z") }),
    )).rejects.toThrow(/no partition|Failed query/);

    expect(await countObjects(testDb)).toBe(0);

    // Beyond 2031 the catch-all is the structural backstop (0082 precedent).
    const caught = await putPayloadObject(
      testDb.db,
      jsonPut({ json: { a: 1 }, captureInstant: new Date("2031-05-10T00:00:00.000Z") }),
    );
    expect(caught.bucketMonth).toBe("2031-05-01");
    const landed = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from capture_payload_objects_future",
    );
    expect(landed.rows[0]!.n).toBe("1");
    expect(await loadPayloadBody(testDb.db, caught)).toEqual({
      representation: "canonical_json",
      json: { a: 1 },
    });
  });
});
