import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureObservationPartitions,
  findObservationByKey,
  getObservationPartitionLeadMonths,
  insertObservation,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function sha256(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload)).digest();
}

function webhookObservation(idempotencyKey: string, payload: Record<string, unknown> = { event: "messages.received" }) {
  return {
    source: "webhook" as const,
    producer: "ofapi:webhook",
    platform: "onlyfans",
    nativeAccountRef: "acct_test",
    kind: "messages.received",
    payload,
    payloadHash: sha256(payload),
    idempotencyKey,
  };
}

describe("observations insert protocol", () => {
  it("inserts the journal row and the dedup key atomically", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const result = await insertObservation(testDb.db, webhookObservation("evt-1"));
    expect(result.inserted).toBe(true);

    const rows = await testDb.pool.query<{
      id: string;
      source: string;
      producer: string;
      kind: string;
      parse_version: number;
      payload_hash: Buffer;
    }>(
      "select id::text as id, source, producer, kind, parse_version, payload_hash from observations",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: String(result.observationId),
      source: "webhook",
      producer: "ofapi:webhook",
      kind: "messages.received",
      parse_version: 0,
    });
    expect(Buffer.compare(rows.rows[0]!.payload_hash, sha256({ event: "messages.received" }))).toBe(0);

    const keys = await testDb.pool.query<{ observation_id: string; received_at: Date }>(
      "select observation_id::text as observation_id, received_at from observation_keys",
    );
    expect(keys.rows).toHaveLength(1);
    expect(keys.rows[0]!.observation_id).toBe(String(result.observationId));

    // The key's received_at matches the journal row's (same-tx now()) so the
    // key can locate the row inside the partitioned table.
    const found = await findObservationByKey(testDb.db, "webhook", "evt-1");
    expect(found).toMatchObject({ id: result.observationId, kind: "messages.received" });
  });

  it("signals duplicates without writing a second journal row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const first = await insertObservation(testDb.db, webhookObservation("evt-dup"));
    const second = await insertObservation(testDb.db, webhookObservation("evt-dup", { event: "retry-delivery" }));

    expect(first.inserted).toBe(true);
    // PR4: the duplicate path surfaces the EXISTING key's received_at so an
    // immediate projector can stamp partition-exact — never new Date().
    expect(second).toEqual({
      inserted: false,
      observationId: first.observationId,
      receivedAt: first.receivedAt,
    });

    const count = await testDb.pool.query<{ n: string }>("select count(*)::text as n from observations");
    expect(count.rows[0]!.n).toBe("1");
  });

  it("scopes dedup by source: the same key under another source is a new fact", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const webhook = await insertObservation(testDb.db, webhookObservation("shared-key"));
    const pull = await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:fansly:subscribers",
      platform: "fansly",
      accountId: null,
      kind: "subscribers",
      payload: { page: 1 },
      payloadHash: sha256({ page: 1 }),
      idempotencyKey: "shared-key",
    });

    expect(webhook.inserted).toBe(true);
    expect(pull.inserted).toBe(true);
    expect(pull.observationId).not.toBe(webhook.observationId);

    const count = await testDb.pool.query<{ n: string }>("select count(*)::text as n from observations");
    expect(count.rows[0]!.n).toBe("2");
  });

  it("fails loudly when the target partition is missing (never a silent drop)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // 2029 sits in the gap between the pre-created monthlies and 0082's
    // `observations_future` catch-all (FROM '2031-01-01') — still uncovered.
    // (2031 was this drill's date before W8.2; the catch-all absorbs it now —
    // pinned below.)
    await expect(
      insertObservation(testDb.db, {
        ...webhookObservation("evt-far-future"),
        receivedAt: new Date("2029-01-15T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/no partition|Failed query/);

    // The failed journal insert must not leave a dangling key claim — an
    // orphaned claim would make the producer's retry look like a duplicate
    // and lose the fact.
    const rows = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations",
    );
    expect(rows.rows[0]!.n).toBe("0");
    const keys = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observation_keys where idempotency_key = 'evt-far-future'",
    );
    expect(keys.rows[0]!.n).toBe("0");

    // And the retry (with a partition present) succeeds cleanly.
    const retried = await insertObservation(testDb.db, webhookObservation("evt-far-future"));
    expect(retried.inserted).toBe(true);

    // W8.2 (0082): beyond 2031 the future catch-all is the structural
    // backstop — a stray far-future insert degrades to a hot catch-all row,
    // never an ExecFindPartition failure.
    const caught = await insertObservation(testDb.db, {
      ...webhookObservation("evt-catchall-2031"),
      receivedAt: new Date("2031-01-15T00:00:00.000Z"),
    });
    expect(caught.inserted).toBe(true);
    const landed = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations_future",
    );
    expect(landed.rows[0]!.n).toBe("1");
  });
});

describe("observation partition management", () => {
  it("pre-creates months ahead idempotently and reports the lead", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The migration ships partitions for 2026-07..2026-12. From a November
    // vantage the lead is 1 month (December only).
    const november = new Date("2026-11-15T12:00:00.000Z");
    expect(await getObservationPartitionLeadMonths(testDb.db, november)).toBe(1);

    const ensured = await ensureObservationPartitions(testDb.db, { monthsAhead: 3, now: november });
    expect(ensured).toEqual([
      "observations_2026_11",
      "observations_2026_12",
      "observations_2027_01",
      "observations_2027_02",
    ]);
    expect(await getObservationPartitionLeadMonths(testDb.db, november)).toBe(3);

    // Idempotent re-run.
    await ensureObservationPartitions(testDb.db, { monthsAhead: 3, now: november });
    const partition = await testDb.pool.query<{ found: string | null }>(
      "select to_regclass('public.observations_2027_02')::text as found",
    );
    expect(partition.rows[0]!.found).toBe("observations_2027_02");

    // A row lands in the newly created month.
    const result = await insertObservation(testDb.db, {
      ...webhookObservation("evt-2027-01"),
      receivedAt: new Date("2027-01-10T00:00:00.000Z"),
    });
    expect(result.inserted).toBe(true);
    const placed = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations_2027_01",
    );
    expect(placed.rows[0]!.n).toBe("1");
  });
});
