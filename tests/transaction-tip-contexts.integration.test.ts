import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  insertErasureLog,
  insertObservation,
  insertRawPayload,
} from "@agency_hub_core/db";

import { materializeFanslyDmTipContexts } from
  "../apps/runtime/src/sync/fansly/lib/tip-contexts.ts";
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
