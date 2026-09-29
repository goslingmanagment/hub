// §3.2a — the MIXED deliverable + projection-only append.
//
// WP-F0(b) needs one `dm_messages` observation to yield BOTH deliverable news
// (message.received / message.ppv_unlocked) and projection-only commerce
// material (the media plane). Before this mechanism there was no legal path:
//
//   - appendProjectionOnlyDomainEvents throws on the first deliverable type;
//   - a plain deliverable append passes checkpoint = null, so the hidden rows
//     take account_seq values that no checkpoint covers, and
//     validateV2DeliverableReplayBatch reads that gap as a ledger hole and
//     refuses the whole replay batch — every SSE client stuck at that cursor.
//
// So the ORDER is load-bearing, not cosmetic: the v2 validator requires the row
// IMMEDIATELY following a seq gap to be the checkpoint whose hiddenCount equals
// the gap. A deliverable row interleaved between hidden rows splits the gap in
// two and the batch is refused.
//
// Named `.integration` because the append protocol IS the SQL: account_seq
// allocation, the dedup-key companion table and the checkpoint all live in one
// Postgres transaction, and a mock would pin the mock.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendMixedDomainEvents,
  appendProjectionOnlyDomainEvents,
  isProjectionOnlyDomainEventType,
  listEventsSince,
  type DomainEventInput,
} from "@agency_hub_core/db";

import { validateV2DeliverableReplayBatch } from "../apps/runtime/src/services/sse-replay-buffer.ts";

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

const OBSERVATION_ID = 4242;
const RECEIVED_AT = new Date("2026-08-19T10:00:00Z");

function draft(type: string, dedupKey: string): DomainEventInput {
  return {
    type,
    occurredAt: RECEIVED_AT,
    fanIdentityRef: "fan-9001",
    conversationRef: "group-9001",
    messageRef: "msg-9001",
    transactionRef: null,
    data: { probe: dedupKey },
    schemaVersion: 1,
    observationId: OBSERVATION_ID,
    dedupKey,
  };
}

/** The exact shape sync-pull v5 produces for ONE dm_messages observation:
 *  deliverable news first in caller order, then the four hidden types. */
function v5Batch(): DomainEventInput[] {
  return [
    draft("message.received", "msg:received:m1"),
    draft("message.ppv_unlocked", "ppv:fan-9001:media-1:2026-08-19T09:00:00.000Z"),
    draft("message.attachments_observed", "msgatt:v1:11:msg-9001:hash-a"),
    draft("media.observed", "media:v1:11:media-1:hash-b"),
    draft("media.order_observed", "mediaorder:v1:11:media-1:fan-9001:1755595200"),
    draft("message.material_observed", "msg-material:msg-9001:hash-c"),
  ];
}

function checkpoint(dedupKey: string) {
  return { occurredAt: RECEIVED_AT, observationId: OBSERVATION_ID, dedupKey };
}

const ACCOUNT_ID = 11;

async function ledger(db: StartedTestDatabase) {
  return listEventsSince(db.db, { accountId: ACCOUNT_ID, afterSeq: 0, limit: 200 });
}

async function deliverableLedger(db: StartedTestDatabase) {
  return listEventsSince(db.db, {
    accountId: ACCOUNT_ID,
    afterSeq: 0,
    limit: 200,
    excludeProjectionOnly: true,
  });
}

describe("§3.2a mixed domain-event append", () => {
  it("lands both subsets exactly once, deliverables first, checkpoint last", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const batch = v5Batch();
    const result = await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      batch,
      checkpoint("pull:v5:checkpoint:4242"),
    );
    // 2 deliverable + 4 hidden + 1 checkpoint.
    expect(result).toMatchObject({ appended: 7, deduped: 0, highWater: 7 });

    // Per-event outcomes stay in CALLER order even though the write order is
    // deliverables-first — consumers index this array against their drafts.
    // …and the checkpoint, which has no caller slot, is reported last.
    expect(result.events.map((outcome) => outcome.dedupKey))
      .toEqual([...batch.map((input) => input.dedupKey), "pull:v5:checkpoint:4242"]);
    expect(result.events.every((outcome) => outcome.appended)).toBe(true);

    const rows = await ledger(testDb);
    expect(rows.map((row) => row.type)).toEqual([
      "message.received",
      "message.ppv_unlocked",
      "message.attachments_observed",
      "media.observed",
      "media.order_observed",
      "message.material_observed",
      "stream.projection_checkpoint",
    ]);
    expect(rows.map((row) => row.accountSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // The load-bearing property, asserted as a property and not as the literal
    // list above: no deliverable row may appear after a hidden one.
    const material = rows.filter((row) => row.type !== "stream.projection_checkpoint");
    const firstHidden = material.findIndex((row) => isProjectionOnlyDomainEventType(row.type));
    expect(firstHidden).toBeGreaterThan(0);
    expect(material.slice(firstHidden).every((row) =>
      isProjectionOnlyDomainEventType(row.type)
    )).toBe(true);
    // …and the checkpoint is the last row of the batch, immediately after the
    // hidden block, which is exactly what the v2 validator looks for.
    expect(rows[rows.length - 1]!.type).toBe("stream.projection_checkpoint");
    expect(rows[rows.length - 1]!.data).toMatchObject({ hiddenCount: 4 });
  });

  it("counts hiddenCount as the hidden rows APPENDED, not the batch size", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      v5Batch(),
      checkpoint("pull:v5:checkpoint:4242"),
    );

    // A version bump re-reads the same observation and mints EXTRA events. The
    // checkpoint key carries the family version, so it does not collide; the
    // six originals dedupe. hiddenCount must describe the ONE new hidden row.
    const second = await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      [
        ...v5Batch(),
        draft("message.sent", "msg:sent:m2"),
        draft("media.observed", "media:v1:11:media-2:hash-d"),
      ],
      checkpoint("pull:v6:checkpoint:4242"),
    );
    expect(second).toMatchObject({ appended: 3, deduped: 6, highWater: 10 });

    const rows = await ledger(testDb);
    const checkpoints = rows.filter((row) => row.type === "stream.projection_checkpoint");
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]!.data).toMatchObject({ hiddenCount: 4 });
    // NOT 6 (the hidden types in the batch) and NOT 2 (the rows appended).
    expect(checkpoints[1]!.data).toMatchObject({ hiddenCount: 1 });

    // Order survives the second batch: msg:sent (deliverable) then the new
    // media.observed (hidden) then the checkpoint.
    expect(rows.slice(7).map((row) => row.type)).toEqual([
      "message.sent",
      "media.observed",
      "stream.projection_checkpoint",
    ]);
  });

  it("produces a ledger validateV2DeliverableReplayBatch accepts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      v5Batch(),
      checkpoint("pull:v5:checkpoint:4242"),
    );
    await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      [
        ...v5Batch(),
        draft("message.sent", "msg:sent:m2"),
        draft("media.observed", "media:v1:11:media-2:hash-d"),
      ],
      checkpoint("pull:v6:checkpoint:4242"),
    );

    const visible = await deliverableLedger(testDb);
    // The hidden rows are withheld; the gaps they leave are exactly the ones
    // the following checkpoints authorize.
    expect(visible.map((row) => row.accountSeq)).toEqual([1, 2, 7, 8, 10]);
    const verdict = validateV2DeliverableReplayBatch({
      rows: visible.map((row) => ({
        accountSeq: row.accountSeq,
        type: row.type,
        data: row.data,
      })),
      afterSeq: 0,
      throughSeq: 10,
      limit: 200,
    });
    expect(verdict).toEqual({ ok: true, nextSeq: 10, done: true });
  });

  it("appends nothing on a full-dedup replay and mints no second checkpoint", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      v5Batch(),
      checkpoint("pull:v5:checkpoint:4242"),
    );
    const replay = await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      v5Batch(),
      checkpoint("pull:v5:checkpoint:4242"),
    );
    // hiddenAppended === 0 ⇒ the checkpoint is skipped (today's rule), so a
    // replay cannot collide with the checkpoint it already claimed.
    expect(replay).toMatchObject({ appended: 0, deduped: 6, highWater: 7 });
    expect((await ledger(testDb)).map((row) => row.accountSeq))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("refuses a mixed batch that carries no checkpoint", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await expect(appendMixedDomainEvents(testDb.db, ACCOUNT_ID, v5Batch(), null))
      .rejects.toThrow(/without a checkpoint/i);
    expect(await ledger(testDb)).toHaveLength(0);
  });

  it("accepts an all-deliverable batch with a checkpoint and mints no checkpoint row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The steady state for a dm_messages page with no sale material at all:
    // `mixed: true` is declared per FAMILY, so the checkpoint is offered on
    // every batch and must simply go unused when nothing hidden was appended.
    const result = await appendMixedDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      [draft("message.received", "msg:received:plain")],
      checkpoint("pull:v5:checkpoint:4242"),
    );
    expect(result).toMatchObject({ appended: 1, deduped: 0, highWater: 1 });
    expect((await ledger(testDb)).map((row) => row.type)).toEqual(["message.received"]);
  });

  it("leaves the pure projection-only path unchanged", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // §3.2a step 3 claims the hiddenAppended change is a no-op for this path
    // "by construction". Pinned rather than asserted in prose.
    const hidden = [
      draft("media.observed", "media:v1:11:media-1:hash-b"),
      draft("media.order_observed", "mediaorder:v1:11:media-1:fan-9001:1755595200"),
    ];
    const first = await appendProjectionOnlyDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      hidden,
      checkpoint("pull:v5:checkpoint:4242"),
    );
    expect(first).toMatchObject({ appended: 3, deduped: 0, highWater: 3 });
    const rows = await ledger(testDb);
    expect(rows[2]!.data).toMatchObject({ hiddenCount: 2 });

    // …and it still refuses a deliverable type outright.
    await expect(appendProjectionOnlyDomainEvents(
      testDb.db,
      ACCOUNT_ID,
      [draft("message.received", "msg:received:illegal")],
      checkpoint("pull:v5:checkpoint:other"),
    )).rejects.toThrow();
  });
});
