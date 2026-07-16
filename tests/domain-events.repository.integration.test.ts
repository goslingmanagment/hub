import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  appendProjectionOnlyDomainEvents,
  ensureDomainEventPartitions,
  getAccountHighWater,
  getDomainEventPartitionLeadMonths,
  listEventsSince,
  listDomainEventContiguousReplayEnds,
  listObservationsForReplay,
  markObservationParsed,
  insertObservation,
  type DomainEventInput,
} from "@agency_hub_core/db";
import { createHash } from "node:crypto";

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

function event(input: Partial<DomainEventInput> & { dedupKey: string }): DomainEventInput {
  return {
    type: "message.received",
    occurredAt: new Date("2026-06-15T12:00:00Z"),
    fanIdentityRef: "fan-1",
    conversationRef: "conv-1",
    messageRef: input.dedupKey,
    transactionRef: null,
    data: { text: "hi" },
    schemaVersion: 1,
    observationId: 1,
    ...input,
  };
}

describe("domain events append protocol (Stage 8)", () => {
  it("appends with gapless per-account sequences and dedupes on the key companion", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const first = await appendDomainEvents(testDb.db, 7, [
      event({ dedupKey: "msg:received:m1" }),
      event({ dedupKey: "msg:received:m2" }),
    ]);
    expect(first).toMatchObject({ appended: 2, deduped: 0, highWater: 2 });

    // The same facts again — from any producer — append nothing. Wave 2:
    // the per-event outcome resolves a DEDUPED key to the EXISTING event id
    // (the corrections reconciler links supersedes through this).
    const second = await appendDomainEvents(testDb.db, 7, [
      event({ dedupKey: "msg:received:m2" }),
      event({ dedupKey: "msg:received:m3" }),
    ]);
    expect(second).toMatchObject({ appended: 1, deduped: 1, highWater: 3 });
    expect(second.events[0]).toMatchObject({
      dedupKey: "msg:received:m2",
      appended: false,
      eventId: first.events[1]!.eventId,
    });
    expect(second.events[1]!.appended).toBe(true);

    expect(await getAccountHighWater(testDb.db, 7)).toBe(3);
    const rows = await listEventsSince(testDb.db, { accountId: 7, afterSeq: 0 });
    expect(rows.map((row) => row.accountSeq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.dedupKey)).toEqual([
      "msg:received:m1",
      "msg:received:m2",
      "msg:received:m3",
    ]);
    const boundedReplay = await listEventsSince(testDb.db, {
      accountId: 7,
      afterSeq: 0,
      throughSeq: first.highWater,
    });
    expect(boundedReplay.map((row) => row.accountSeq)).toEqual([1, 2]);

    // Another account's sequence is independent.
    const other = await appendDomainEvents(testDb.db, 8, [event({ dedupKey: "msg:received:m1" })]);
    expect(other).toMatchObject({ appended: 1, deduped: 0, highWater: 1 });
  });

  it("keeps account_seq gapless 1..K under concurrent appenders", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // 8 parallel appenders × 5 events each, with overlapping dedup keys so
    // dedups interleave with appends — seq must come out a permutation-free
    // 1..K where K = distinct keys.
    const batches = Array.from({ length: 8 }, (_, b) =>
      Array.from({ length: 5 }, (_, i) => event({
        dedupKey: `msg:received:concurrent-${(b * 3 + i) % 20}`,
      })));
    await Promise.all(batches.map((batch) => appendDomainEvents(testDb!.db, 42, batch)));

    const rows = await listEventsSince(testDb.db, { accountId: 42, afterSeq: 0, limit: 100 });
    const distinctKeys = new Set(batches.flat().map((eventInput) => eventInput.dedupKey));
    expect(rows).toHaveLength(distinctKeys.size);
    expect(rows.map((row) => row.accountSeq)).toEqual(
      Array.from({ length: distinctKeys.size }, (_, i) => i + 1),
    );
    expect(await getAccountHighWater(testDb.db, 42)).toBe(distinctKeys.size);
  });

  it("atomically checkpoints projection-only rows and filters them from v2 replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const material = [
      event({ dedupKey: "msg-material:m1:a", type: "message.material_observed" }),
      event({ dedupKey: "msg-material:m2:b", type: "message.material_observed" }),
      event({ dedupKey: "coverage:chat-1", type: "capture.coverage_observed" }),
    ];
    const first = await appendProjectionOnlyDomainEvents(testDb.db, 17, material, {
      occurredAt: new Date("2026-06-15T12:01:00Z"),
      observationId: 91,
      dedupKey: "projection-checkpoint:91",
    });
    expect(first).toMatchObject({ appended: 4, deduped: 0, highWater: 4 });

    const visible = await listEventsSince(testDb.db, {
      accountId: 17,
      afterSeq: 0,
      throughSeq: 4,
      excludeProjectionOnly: true,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      accountSeq: 4,
      type: "stream.projection_checkpoint",
      data: { hiddenCount: 3 },
    });
    const ends = await listDomainEventContiguousReplayEnds(testDb.db, [{
      accountId: 17,
      afterSeq: 0,
      throughSeq: 4,
    }], { excludeProjectionOnly: true });
    expect(ends.get(17)).toBe(4);

    const replay = await appendProjectionOnlyDomainEvents(testDb.db, 17, material, {
      occurredAt: new Date("2026-06-15T12:01:00Z"),
      observationId: 91,
      dedupKey: "projection-checkpoint:91",
    });
    expect(replay).toMatchObject({ appended: 0, deduped: 3, highWater: 4 });
  });

  it("routes historical occurred_at into the 2024/pre-2024 partitions", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const result = await appendDomainEvents(testDb.db, 5, [
      event({ dedupKey: "txn:ancient", type: "transaction.posted", occurredAt: new Date("2023-05-01T00:00:00Z") }),
      event({ dedupKey: "txn:backfill-2024", type: "transaction.posted", occurredAt: new Date("2024-02-10T00:00:00Z") }),
      // 0077 regression: corrected Fansly backscroll timestamps land in the
      // yearly 2025 catch-all — before it, this insert failed 23514 on prod
      // (tiering had detached every 0057 monthly in the 2024–2025 range).
      event({ dedupKey: "msg:backscroll-2025", type: "message.sent", occurredAt: new Date("2025-12-19T18:40:24Z") }),
    ]);
    expect(result.appended).toBe(3);

    const placed = await testDb.pool.query<{ tableoid: string; dedup_key: string }>(
      "select tableoid::regclass::text as tableoid, dedup_key from domain_events where account_id = 5 order by account_seq",
    );
    expect(placed.rows[0]?.tableoid).toBe("domain_events_pre_2024");
    expect(placed.rows[1]?.tableoid).toBe("domain_events_2024");
    expect(placed.rows[2]?.tableoid).toBe("domain_events_2025");
  });

  it("pre-creates partitions ahead and reports the lead", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-11-15T00:00:00Z");
    const ensured = await ensureDomainEventPartitions(testDb.db, { monthsAhead: 3, now });
    expect(ensured).toEqual([
      "domain_events_2026_11",
      "domain_events_2026_12",
      "domain_events_2027_01",
      "domain_events_2027_02",
    ]);
    expect(await getDomainEventPartitionLeadMonths(testDb.db, now)).toBeGreaterThanOrEqual(3);
  });

  it("lists observations for replay by parse version and stamps forward-only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const payload = { event: "messages.received", id: "m-replay" };
    const inserted = await insertObservation(testDb.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: 7,
      kind: "messages.received",
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: "evt-replay-1",
    });
    expect(inserted.inserted).toBe(true);

    const pending = await listObservationsForReplay(testDb.db, {
      belowParseVersion: 1,
      kinds: ["messages.received"],
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(inserted.observationId);

    await markObservationParsed(testDb.db, {
      observationId: pending[0]!.id,
      receivedAt: pending[0]!.receivedAt,
      parseVersion: 1,
    });
    expect(await listObservationsForReplay(testDb.db, {
      belowParseVersion: 1,
      kinds: ["messages.received"],
    })).toHaveLength(0);

    // Forward-only: an older-version stamp never regresses.
    await markObservationParsed(testDb.db, {
      observationId: pending[0]!.id,
      receivedAt: pending[0]!.receivedAt,
      parseVersion: 0,
    });
    const still = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where id = $1",
      [pending[0]!.id],
    );
    expect(still.rows[0]?.parse_version).toBe(1);
  });
});
