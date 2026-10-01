import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  insertErasureLog,
  insertObservation,
  insertRawPayload,
  listTransactionTipContextRawPayloadsAfterId,
  readTransactionTipContextRawPayloadHighWater,
} from "@agency_hub_core/db";

import { materializeFanslyDmTipContexts } from
  "../apps/runtime/src/services/sync/fansly-tip-contexts.ts";
import {
  runTransactionTipContextsBackfill,
  TransactionTipContextsBackfillError,
} from "../apps/runtime/src/services/transaction-tip-contexts-backfill.ts";
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
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

async function seedPage(label: string) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  return page;
}

async function captureDmRaw(input: {
  accountId: number;
  groupId?: string;
  responsePayload: unknown;
}) {
  return insertRawPayload(testDb!.db, {
    platformAccountId: input.accountId,
    endpoint: "dm_messages",
    requestParams: input.groupId === undefined ? {} : { groupId: input.groupId },
    responsePayload: input.responsePayload,
    mapperVersion: "test",
    payloadKind: "dm_messages",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

describe("transaction tip context materialization", () => {
  it("joins by exact tip id, preserves sparse knowledge, and survives raw cleanup", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-materialize");
    const firstRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        tips: [{
          id: "tip-1",
          amount: 250_000,
          message: "For your level up",
          senderId: "fan-1",
          createdAt: 1_770_000_000,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-1" },
      responsePayload: {
        tips: [{
          id: "tip-1",
          amount: 250_000,
          message: "For your level up",
          senderId: "fan-1",
          createdAt: 1_770_000_000,
        }],
      },
      sourceRawPayloadId: firstRaw.id,
      capturedAt: firstRaw.capturedAt,
    })).toMatchObject({ upserted: 1, unchanged: 0 });

    const sparseRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        tips: [{
          id: "tip-1",
          amount: 300_000,
          message: null,
          senderId: "fan-1",
          receiverId: "creator-1",
          createdAt: 1_770_000_100,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-1" },
      responsePayload: {
        tips: [{
          id: "tip-1",
          amount: 300_000,
          message: null,
          senderId: "fan-1",
          receiverId: "creator-1",
          createdAt: 1_770_000_100,
        }],
      },
      sourceRawPayloadId: sparseRaw.id,
      capturedAt: sparseRaw.capturedAt,
    })).toMatchObject({ upserted: 1, unchanged: 0 });

    const conflictRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-conflict",
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "wrong conversation",
          senderId: "fan-1",
          createdAt: 1_770_000_200,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-conflict" },
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "wrong conversation",
          senderId: "fan-1",
          createdAt: 1_770_000_200,
        }],
      },
      sourceRawPayloadId: conflictRaw.id,
      capturedAt: conflictRaw.capturedAt,
    })).toMatchObject({ upserted: 0, unchanged: 0, conversationConflicts: 1 });

    // A later contradictory non-empty note is evidence of drift, not license
    // to rewrite first evidence or move that evidence's exact raw lineage.
    const divergentRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "later different note",
          senderId: "fan-1",
          createdAt: 1_770_000_300,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-1" },
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "later different note",
          senderId: "fan-1",
          createdAt: 1_770_000_300,
        }],
      },
      sourceRawPayloadId: divergentRaw.id,
      capturedAt: divergentRaw.capturedAt,
    })).toMatchObject({ upserted: 0, unchanged: 1, conversationConflicts: 0 });

    const row = await testDb.pool.query<{
      platform: string;
      platform_tip_id: string;
      captured_conversation_ref: string;
      tip_message_text: string | null;
      tip_amount_mills: string | null;
      occurred_at: Date | null;
      sender_platform_user_id: string | null;
      receiver_platform_user_id: string | null;
      source_raw_payload_id: string | null;
      captured_at: Date;
      tip_message_source_raw_payload_id: string | null;
      tip_message_captured_at: Date | null;
      note_source_message: string | null;
      provenance: string;
    }>(
      `select platform, platform_tip_id, captured_conversation_ref,
              tip_message_text, tip_amount_mills::text, occurred_at,
              sender_platform_user_id, receiver_platform_user_id,
              t.source_raw_payload_id::text, t.captured_at,
              t.tip_message_source_raw_payload_id::text,
              t.tip_message_captured_at,
              note_raw.response_payload #>> '{tips,0,message}' as note_source_message,
              t.provenance
         from transaction_tip_contexts t
         left join sync_raw_payloads note_raw
           on note_raw.id = t.tip_message_source_raw_payload_id
        where t.account_id = $1 and t.platform_tip_id = 'tip-1'`,
      [page.id],
    );
    expect(row.rows[0]).toMatchObject({
      platform: "fansly",
      platform_tip_id: "tip-1",
      captured_conversation_ref: "group-1",
      tip_message_text: "For your level up",
      tip_amount_mills: "250000",
      sender_platform_user_id: "fan-1",
      receiver_platform_user_id: "creator-1",
      source_raw_payload_id: String(firstRaw.id),
      tip_message_source_raw_payload_id: String(firstRaw.id),
      note_source_message: "For your level up",
      provenance: "fansly_dm_tip_sidecar",
    });
    expect(row.rows[0]!.occurred_at?.toISOString()).toBe("2026-02-02T02:40:00.000Z");
    expect(row.rows[0]!.captured_at.toISOString()).toBe(firstRaw.capturedAt.toISOString());
    expect(row.rows[0]!.tip_message_captured_at?.toISOString()).toBe(
      firstRaw.capturedAt.toISOString(),
    );

    // The retained material remains usable if an operator later expires its
    // source raw row; nullable SET NULL lineage cannot wedge cleanup.
    await testDb.pool.query("delete from sync_raw_payloads where id = $1", [firstRaw.id]);
    const afterRawDelete = await testDb.pool.query<{
      source_raw_payload_id: string | null;
      tip_message_source_raw_payload_id: string | null;
      tip_message_text: string | null;
      captured_at: Date;
      tip_message_captured_at: Date | null;
      provenance: string;
    }>(
      `select source_raw_payload_id::text,
              tip_message_source_raw_payload_id::text,
              tip_message_text, captured_at, tip_message_captured_at, provenance
         from transaction_tip_contexts where account_id = $1 and platform_tip_id = 'tip-1'`,
      [page.id],
    );
    expect(afterRawDelete.rows[0]).toMatchObject({
      source_raw_payload_id: null,
      tip_message_source_raw_payload_id: null,
      tip_message_text: "For your level up",
      provenance: "fansly_dm_tip_sidecar",
    });
    expect(afterRawDelete.rows[0]!.captured_at.toISOString()).toBe(
      firstRaw.capturedAt.toISOString(),
    );
    expect(afterRawDelete.rows[0]!.tip_message_captured_at?.toISOString()).toBe(
      firstRaw.capturedAt.toISOString(),
    );

    const relinkRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "For your level up",
          senderId: "fan-1",
          createdAt: 1_770_000_400,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-1" },
      responsePayload: {
        tips: [{
          id: "tip-1",
          message: "For your level up",
          senderId: "fan-1",
          createdAt: 1_770_000_400,
        }],
      },
      sourceRawPayloadId: relinkRaw.id,
      capturedAt: relinkRaw.capturedAt,
    })).toMatchObject({ upserted: 1, unchanged: 0 });
    const relinked = await testDb.pool.query<{
      source_raw_payload_id: string | null;
      tip_message_source_raw_payload_id: string | null;
      captured_at: Date;
      tip_message_captured_at: Date | null;
    }>(
      `select source_raw_payload_id::text,
              tip_message_source_raw_payload_id::text,
              captured_at, tip_message_captured_at
         from transaction_tip_contexts where account_id = $1 and platform_tip_id = 'tip-1'`,
      [page.id],
    );
    expect(relinked.rows[0]!.source_raw_payload_id).toBe(String(relinkRaw.id));
    expect(relinked.rows[0]!.tip_message_source_raw_payload_id).toBe(String(relinkRaw.id));
    expect(relinked.rows[0]!.captured_at.toISOString()).toBe(relinkRaw.capturedAt.toISOString());
    expect(relinked.rows[0]!.tip_message_captured_at?.toISOString()).toBe(
      relinkRaw.capturedAt.toISOString(),
    );
  });

  it("tracks a later selected note independently from identity and sparse enrichment", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-split-lineage");
    const identityRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-split-lineage",
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: null,
          senderId: "fan-split",
          createdAt: 1_770_000_000,
        }],
      },
    });
    await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-split-lineage" },
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: null,
          senderId: "fan-split",
          createdAt: 1_770_000_000,
        }],
      },
      sourceRawPayloadId: identityRaw.id,
      capturedAt: identityRaw.capturedAt,
    });

    const noteRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-split-lineage",
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: "selected later note",
          senderId: "fan-split",
          createdAt: 1_770_000_100,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-split-lineage" },
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: "selected later note",
          senderId: "fan-split",
          createdAt: 1_770_000_100,
        }],
      },
      sourceRawPayloadId: noteRaw.id,
      capturedAt: noteRaw.capturedAt,
    })).toMatchObject({ upserted: 1 });

    const sparseRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-split-lineage",
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: null,
          amount: 25_000,
          senderId: "fan-split",
          receiverId: "creator-split",
          createdAt: 1_770_000_200,
        }],
      },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-split-lineage" },
      responsePayload: {
        tips: [{
          id: "tip-split-lineage",
          message: null,
          amount: 25_000,
          senderId: "fan-split",
          receiverId: "creator-split",
          createdAt: 1_770_000_200,
        }],
      },
      sourceRawPayloadId: sparseRaw.id,
      capturedAt: sparseRaw.capturedAt,
    })).toMatchObject({ upserted: 1 });

    const served = await testDb.pool.query<{
      source_raw_payload_id: string | null;
      tip_message_source_raw_payload_id: string | null;
      tip_message_text: string | null;
      tip_amount_mills: string | null;
      receiver_platform_user_id: string | null;
      note_source_message: string | null;
    }>(
      `select t.source_raw_payload_id::text,
              t.tip_message_source_raw_payload_id::text,
              t.tip_message_text,
              t.tip_amount_mills::text,
              t.receiver_platform_user_id,
              note_raw.response_payload #>> '{tips,0,message}' as note_source_message
         from transaction_tip_contexts t
         left join sync_raw_payloads note_raw
           on note_raw.id = t.tip_message_source_raw_payload_id
        where t.account_id = $1 and t.platform_tip_id = 'tip-split-lineage'`,
      [page.id],
    );
    expect(served.rows[0]).toEqual({
      source_raw_payload_id: String(identityRaw.id),
      tip_message_source_raw_payload_id: String(noteRaw.id),
      tip_message_text: "selected later note",
      tip_amount_mills: "25000",
      receiver_platform_user_id: "creator-split",
      note_source_message: "selected later note",
    });
  });

  it("keyset-backfills valid siblings idempotently and reports parse debt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-backfill");
    await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: { messages: [] },
    });
    await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        tips: [
          {
            id: "tip-valid",
            message: "exact note",
            amount: 10_000,
            senderId: "fan-1",
            createdAt: 1_770_000_000,
          },
          null,
        ],
      },
    });
    await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: { tips: { drift: true } },
    });

    const first = await runTransactionTipContextsBackfill(appStub(), {
      accountId: page.id,
      batchSize: 1,
    });
    expect(first).toMatchObject({
      batches: 3,
      rawPayloadsScanned: 3,
      absentSidecars: 1,
      invalidSidecars: 1,
      tipItemsSeen: 2,
      contextsParsed: 1,
      rejectedItems: 1,
      contextsUpserted: 1,
      contextsUnchanged: 0,
      conversationConflicts: 0,
      contextsErasureFenced: 0,
    });

    const second = await runTransactionTipContextsBackfill(appStub(), {
      accountId: page.id,
      batchSize: 2,
    });
    expect(second).toMatchObject({
      batches: 2,
      rawPayloadsScanned: 3,
      contextsUpserted: 0,
      contextsUnchanged: 1,
      conversationConflicts: 0,
    });
    const rows = await testDb.pool.query(
      "select platform_tip_id, tip_message_text from transaction_tip_contexts",
    );
    expect(rows.rows).toEqual([{ platform_tip_id: "tip-valid", tip_message_text: "exact note" }]);
  });

  it("projects only the tips sidecar while scanning retained DM raw", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-projection");
    const raw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-1",
      responsePayload: {
        messages: [{ id: "heavy-message", media: "x".repeat(100_000) }],
        tips: [{
          id: "tip-projected",
          message: "exact note",
          senderId: "fan-1",
          createdAt: 1_770_000_000,
        }],
        unrelatedEnvelopeMember: "must not cross the backfill boundary",
      },
    });

    const rows = await listTransactionTipContextRawPayloadsAfterId(testDb.db, {
      afterId: raw.id - 1,
      throughId: raw.id,
      accountId: page.id,
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responsePayload).toEqual({
      tips: [{
        id: "tip-projected",
        message: "exact note",
        senderId: "fan-1",
        createdAt: 1_770_000_000,
      }],
    });
  });

  it("freezes a raw high-water so capture during replay waits for the next run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-high-water");
    const seedRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-before-high-water",
      responsePayload: {
        tips: [{
          id: "tip-before-high-water",
          message: "first generation",
          senderId: "fan-before",
          createdAt: 1_770_000_000,
        }],
      },
    });
    expect(await readTransactionTipContextRawPayloadHighWater(testDb.db, {
      accountId: page.id,
    })).toBe(seedRaw.id);

    // Deterministically inject a new retained raw row from the first context
    // insert. It therefore lands after runTransaction... has read its high-water
    // but before the service asks for the next keyset page.
    await testDb.pool.query(`
      create function test_inject_tip_context_raw_after_high_water()
      returns trigger language plpgsql as $$
      begin
        insert into sync_raw_payloads (
          page_id, endpoint, request_params, response_payload,
          mapper_version, payload_kind, retain_until
        ) values (
          new.account_id,
          'dm_messages',
          jsonb_build_object('groupId', 'group-after-high-water'),
          jsonb_build_object('tips', jsonb_build_array(jsonb_build_object(
            'id', 'tip-after-high-water',
            'message', 'next generation',
            'senderId', 'fan-after',
            'createdAt', 1770000001
          ))),
          'test',
          'dm_messages',
          now() + interval '100 years'
        );
        return new;
      end $$;
      create trigger test_inject_tip_context_raw_after_high_water
      after insert on transaction_tip_contexts
      for each row
      when (new.platform_tip_id = 'tip-before-high-water')
      execute function test_inject_tip_context_raw_after_high_water()
    `);
    try {
      const first = await runTransactionTipContextsBackfill(appStub(), {
        accountId: page.id,
        batchSize: 1,
      });
      expect(first).toMatchObject({
        rawHighWaterId: seedRaw.id,
        lastRawPayloadId: seedRaw.id,
        rawPayloadsScanned: 1,
        contextsUpserted: 1,
      });
      const lateRaw = await testDb.pool.query<{ id: string }>(
        `select id::text from sync_raw_payloads
          where page_id = $1
            and request_params->>'groupId' = 'group-after-high-water'`,
        [page.id],
      );
      expect(Number(lateRaw.rows[0]!.id)).toBeGreaterThan(first.rawHighWaterId);
      expect(await testDb.pool.query(
        `select 1 from transaction_tip_contexts
          where account_id = $1 and platform_tip_id = 'tip-after-high-water'`,
        [page.id],
      ).then((result) => result.rowCount)).toBe(0);

      const second = await runTransactionTipContextsBackfill(appStub(), {
        accountId: page.id,
        batchSize: 2,
      });
      expect(second).toMatchObject({
        rawHighWaterId: Number(lateRaw.rows[0]!.id),
        rawPayloadsScanned: 2,
        contextsUpserted: 1,
        contextsUnchanged: 1,
      });
    } finally {
      await testDb.pool.query(
        "drop trigger if exists test_inject_tip_context_raw_after_high_water "
        + "on transaction_tip_contexts",
      );
      await testDb.pool.query(
        "drop function if exists test_inject_tip_context_raw_after_high_water()",
      );
    }
  });

  it("stops before advancing a deferred raw and succeeds after the erasure lock releases", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-deferred");
    const raw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-deferred",
      responsePayload: {
        tips: [{
          id: "tip-deferred",
          message: "must remain retryable",
          senderId: "fan-deferred",
          createdAt: 1_770_000_000,
        }],
      },
    });

    const erasureClient = await testDb.pool.connect();
    try {
      await erasureClient.query("begin");
      await erasureClient.query(
        "select pg_advisory_xact_lock($1, $2)",
        [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, page.id],
      );
      const failed = await runTransactionTipContextsBackfill(appStub(), {
        accountId: page.id,
        batchSize: 1,
      }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(TransactionTipContextsBackfillError);
      expect(failed).toMatchObject({
        message: "Transaction tip context backfill failed",
        reason: "writer_deferred",
        rawPayloadId: raw.id,
        batchIndex: 0,
        batchCount: 1,
      });
      expect(await testDb.pool.query(
        "select 1 from transaction_tip_contexts where account_id = $1",
        [page.id],
      ).then((result) => result.rowCount)).toBe(0);
    } finally {
      await erasureClient.query("rollback").catch(() => undefined);
      erasureClient.release();
    }

    const retry = await runTransactionTipContextsBackfill(appStub(), {
      accountId: page.id,
      batchSize: 1,
    });
    expect(retry).toMatchObject({
      lastRawPayloadId: raw.id,
      rawPayloadsScanned: 1,
      contextsUpserted: 1,
    });
  });

  it("treats pre-erasure raw as terminally fenced while admitting newer material", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-erasure-fence");
    const operator = await testDb.pool.query<{ id: string }>(
      `insert into users (username, role)
       values ('tip-context-erasure-owner', 'owner')
       returning id::text`,
    );
    const oldCapturedAt = new Date("2025-01-02T00:00:00.000Z");
    const oldRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-erased",
      responsePayload: {
        tips: [{
          id: "tip-before-erasure",
          message: "must never resurrect",
          senderId: "fan-erased",
          createdAt: "2025-01-01T00:00:00.000Z",
        }],
      },
    });
    await testDb.pool.query(
      "update sync_raw_payloads set captured_at = $1 where id = $2",
      [oldCapturedAt, oldRaw.id],
    );
    await insertErasureLog(testDb.db, {
      scopeType: "fan",
      scopeRef: "fan:fansly:fan-erased",
      initiatedBy: Number(operator.rows[0]!.id),
      dryRun: false,
      plan: { resolvedPageIds: [page.id] },
    });

    const direct = await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-erased" },
      responsePayload: {
        tips: [{
          id: "tip-before-erasure",
          message: "must never resurrect",
          senderId: "fan-erased",
          createdAt: "2025-01-01T00:00:00.000Z",
        }],
      },
      sourceRawPayloadId: oldRaw.id,
      capturedAt: oldCapturedAt,
    });
    expect(direct).toMatchObject({ upserted: 0, erasureFenced: 1, deferredWrites: 0 });

    const replay = await runTransactionTipContextsBackfill(appStub(), {
      accountId: page.id,
      batchSize: 1,
    });
    expect(replay).toMatchObject({
      lastRawPayloadId: oldRaw.id,
      rawPayloadsScanned: 1,
      contextsUpserted: 0,
      contextsErasureFenced: 1,
    });
    expect(await testDb.pool.query(
      "select 1 from transaction_tip_contexts where account_id = $1",
      [page.id],
    ).then((result) => result.rowCount)).toBe(0);

    const newCapturedAt = new Date("2125-01-02T00:00:00.000Z");
    const newRaw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-erased",
      responsePayload: {
        tips: [{
          id: "tip-after-erasure",
          message: "genuinely new material",
          senderId: "fan-erased",
          createdAt: "2125-01-01T00:00:00.000Z",
        }],
      },
    });
    await testDb.pool.query(
      "update sync_raw_payloads set captured_at = $1 where id = $2",
      [newCapturedAt, newRaw.id],
    );
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-erased" },
      responsePayload: {
        tips: [{
          id: "tip-after-erasure",
          message: "genuinely new material",
          senderId: "fan-erased",
          createdAt: "2125-01-01T00:00:00.000Z",
        }],
      },
      sourceRawPayloadId: newRaw.id,
      capturedAt: newCapturedAt,
    })).toMatchObject({ upserted: 1, erasureFenced: 0 });
  });

  // 0230 (Fansly Sync Engine design §2.4): the engine journals observations
  // only, so its tip contexts carry observation lineage; raw lineage and the
  // legacy writers behave exactly as above.
  async function captureDmObservation(accountId: number, tips: unknown[]) {
    const observation = await insertObservation(testDb!.db, {
      source: "pull",
      producer: "fansly-sync:dm-messages",
      platform: "fansly",
      accountId,
      kind: "dm_messages",
      payload: { messages: [], tips },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: `tip-context-observation:${accountId}:${JSON.stringify(tips)}`,
    });
    return {
      lineage: {
        kind: "observation" as const,
        sourceObservationId: observation.observationId,
        sourceObservationReceivedAt: observation.receivedAt,
      },
      capturedAt: observation.receivedAt,
    };
  }

  async function lineageOf(accountId: number, tipId: string) {
    const result = await testDb!.pool.query<{
      source_raw_payload_id: string | null;
      source_observation_id: string | null;
      source_observation_received_at: Date | null;
      tip_message_source_raw_payload_id: string | null;
      tip_message_source_observation_id: string | null;
      tip_message_source_observation_received_at: Date | null;
      tip_message_text: string | null;
      tip_amount_mills: string | null;
      captured_at: Date;
    }>(
      `select source_raw_payload_id::text, source_observation_id::text, source_observation_received_at,
              tip_message_source_raw_payload_id::text, tip_message_source_observation_id::text,
              tip_message_source_observation_received_at, tip_message_text, tip_amount_mills::text, captured_at
         from transaction_tip_contexts where account_id = $1 and platform_tip_id = $2`,
      [accountId, tipId],
    );
    return result.rows[0]!;
  }

  it("records observation lineage for the engine and keeps it against later raw captures", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-observation-lineage");
    const tip = { id: "tip-obs", amount: 50_000, message: "from the engine", senderId: "fan-obs", createdAt: 1_770_000_000 };
    const first = await captureDmObservation(page.id, [tip]);
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-obs" },
      responsePayload: { tips: [tip] },
      ...first,
    })).toMatchObject({ upserted: 1 });
    expect(await lineageOf(page.id, "tip-obs")).toMatchObject({
      source_raw_payload_id: null,
      tip_message_source_raw_payload_id: null,
      source_observation_id: String(first.lineage.sourceObservationId),
      source_observation_received_at: first.lineage.sourceObservationReceivedAt,
      tip_message_source_observation_id: String(first.lineage.sourceObservationId),
      tip_message_source_observation_received_at: first.lineage.sourceObservationReceivedAt,
      tip_message_text: "from the engine",
      captured_at: first.capturedAt,
    });

    // A later legacy raw capture of the same tip enriches but never relinks:
    // the row has a lineage, of the other kind.
    const raw = await captureDmRaw({
      accountId: page.id,
      groupId: "group-obs",
      responsePayload: { tips: [{ ...tip, receiverId: "creator-obs" }] },
    });
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-obs" },
      responsePayload: { tips: [{ ...tip, receiverId: "creator-obs" }] },
      sourceRawPayloadId: raw.id,
      capturedAt: raw.capturedAt,
    })).toMatchObject({ upserted: 1 });
    expect(await lineageOf(page.id, "tip-obs")).toMatchObject({
      source_raw_payload_id: null,
      source_observation_id: String(first.lineage.sourceObservationId),
      tip_message_source_raw_payload_id: null,
      tip_message_source_observation_id: String(first.lineage.sourceObservationId),
      captured_at: first.capturedAt,
    });

    // An identical observation capture later is unchanged, not a relink.
    const again = await captureDmObservation(page.id, [{ ...tip, receiverId: "creator-obs" }]);
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-obs" },
      responsePayload: { tips: [{ ...tip, receiverId: "creator-obs" }] },
      ...again,
    })).toMatchObject({ upserted: 0, unchanged: 1 });
    expect((await lineageOf(page.id, "tip-obs")).source_observation_id).toBe(String(first.lineage.sourceObservationId));
  });

  it("relinks a row whose raw lineage was deleted to the engine's observation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-observation-relink");
    const tip = { id: "tip-relink", message: "same note", senderId: "fan-relink", createdAt: 1_770_000_000 };
    const raw = await captureDmRaw({ accountId: page.id, groupId: "group-relink", responsePayload: { tips: [tip] } });
    await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-relink" },
      responsePayload: { tips: [tip] },
      sourceRawPayloadId: raw.id,
      capturedAt: raw.capturedAt,
    });
    await testDb.pool.query("delete from sync_raw_payloads where id = $1", [raw.id]);

    const engine = await captureDmObservation(page.id, [tip]);
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-relink" },
      responsePayload: { tips: [tip] },
      ...engine,
    })).toMatchObject({ upserted: 1 });
    expect(await lineageOf(page.id, "tip-relink")).toMatchObject({
      source_raw_payload_id: null,
      source_observation_id: String(engine.lineage.sourceObservationId),
      tip_message_source_raw_payload_id: null,
      tip_message_source_observation_id: String(engine.lineage.sourceObservationId),
      captured_at: engine.capturedAt,
    });
  });

  it("moves note lineage to the observation whose note wins, leaving identity on raw", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-observation-note");
    const bare = { id: "tip-note", message: null, senderId: "fan-note", createdAt: 1_770_000_000 };
    const raw = await captureDmRaw({ accountId: page.id, groupId: "group-note", responsePayload: { tips: [bare] } });
    await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-note" },
      responsePayload: { tips: [bare] },
      sourceRawPayloadId: raw.id,
      capturedAt: raw.capturedAt,
    });
    const noted = { ...bare, message: "note seen by the engine" };
    const engine = await captureDmObservation(page.id, [noted]);
    expect(await materializeFanslyDmTipContexts(testDb.db, {
      accountId: page.id,
      requestParams: { groupId: "group-note" },
      responsePayload: { tips: [noted] },
      ...engine,
    })).toMatchObject({ upserted: 1 });
    expect(await lineageOf(page.id, "tip-note")).toMatchObject({
      source_raw_payload_id: String(raw.id),
      source_observation_id: null,
      tip_message_text: "note seen by the engine",
      tip_message_source_raw_payload_id: null,
      tip_message_source_observation_id: String(engine.lineage.sourceObservationId),
      captured_at: raw.capturedAt,
    });
  });

  it("composes into the engine's transaction and refuses a half observation address", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("tip-context-observation-tx");
    const tip = { id: "tip-tx", message: "rolled back", senderId: "fan-tx", createdAt: 1_770_000_000 };
    const engine = await captureDmObservation(page.id, [tip]);
    await expect(testDb.db.transaction(async (tx) => {
      expect(await materializeFanslyDmTipContexts(tx as never, {
        accountId: page.id,
        requestParams: { groupId: "group-tx" },
        responsePayload: { tips: [tip] },
        ...engine,
      })).toMatchObject({ upserted: 1 });
      throw new Error("apply rolled back");
    })).rejects.toThrow("apply rolled back");
    expect(await testDb.pool.query(
      "select 1 from transaction_tip_contexts where account_id = $1", [page.id],
    ).then((result) => result.rowCount)).toBe(0);

    await expect(testDb.pool.query(
      `insert into transaction_tip_contexts (account_id, platform, platform_tip_id, captured_conversation_ref,
         occurred_at, sender_platform_user_id, captured_at, provenance, source_observation_id)
       values ($1, 'fansly', 'tip-half', 'group-tx', now(), 'fan-tx', now(), 'fansly_dm_tip_sidecar', 1)`,
      [page.id],
    )).rejects.toThrow(/transaction_tip_contexts_obs_lineage_check/);
  });
});
