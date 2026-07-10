import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
} from "@agency_hub_core/db";

import { runDmCorrectionsFingerprintBackfill } from "../apps/runtime/src/services/dm-corrections-backfill.ts";
import { runDmCorrectionsReconcile } from "../apps/runtime/src/services/dm-corrections-reconciler.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Wave 2 preamble (tabletop S7): the fingerprint backfill MUST close
// already-in-ledger history so enabling the reconciler afterwards appends
// NOTHING redundant — the exact hazard preamble 1 names. REST-only rows are
// the measured initial-drain bound; stubs stay outside the signal.

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

const ACCT = "acct_bf";
const FAN = "777400777";

function appStub(reconcile = false) {
  return {
    db: testDb!.db,
    config: { ofapiDmCorrectionsReconcileEnabled: reconcile },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

describe("corrections fingerprint backfill (Wave 2 preamble)", () => {
  it("closes already-evented history, measures the REST-only drain bound, skips stubs — and the reconciler then appends only the drain", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "bf", name: "bf" });
    const page = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "bf-page" });
    await setPageOfapiAccountId(testDb.db, { pageId: page!.id, ofapiAccountId: ACCT });
    const pageId = page!.id;

    // (a) A webhook-era row WITH its ledger event (pre-Wave-2 history).
    await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "9001",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-01T09:00:00Z"),
      textPlain: "webhook history",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "bf-wh-9001",
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-01T09:00:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    const evented = await appendDomainEvents(testDb.db, pageId, [{
      type: "message.received",
      occurredAt: new Date("2026-07-01T09:00:00Z"),
      fanIdentityRef: FAN,
      conversationRef: FAN,
      messageRef: "9001",
      data: { text: "webhook history", price: null, isTip: false },
      schemaVersion: 1,
      observationId: 1,
      dedupKey: "msg:received:9001",
    }]);

    // (b) A Wave-1 REST-only row (source_journal_id NULL) with a REAL
    // observation — the initial-drain population.
    const obs = await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: pageId,
      kind: "ofapi_gateway_chat_messages_v2",
      payload: { ofapiAccountId: ACCT, chatId: FAN, conversationRef: FAN, cursors: {}, body: { data: [] } },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "bf-rt-9002",
    });
    await testDb.pool.query(
      `insert into dm_message_archive (
         platform, platform_account_id, ofapi_account_id, platform_conversation_id,
         fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
         message_created_at, text_plain, is_tip, tip_amount_mills, source,
         source_event_type, source_idempotency_key, source_journal_id,
         source_received_at, rest_material_observation_id, rest_material_observed_at,
         retain_until
       ) values (
         'onlyfans', $1, $2, $3, $3, '9002', 'fan', false,
         '2026-07-02T09:00:00Z', 'wave-1 rest only', false, 0, 'rest_reconcile',
         'messages.received', $4, null, now(), $5, now(),
         now() + interval '100 years'
       )`,
      [pageId, ACCT, FAN, `readthrough:${obs.observationId}:9002`, obs.observationId],
    );

    // (c) A null-ref tombstone stub (Wave-1 shape).
    await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId: ACCT,
      platformMessageId: "9003",
      deletedAt: new Date(),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "bf-del-9003",
      sourceJournalId: 2,
      sourceReceivedAt: new Date(),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    // Clear Wave-2 write-time bookkeeping so ALL rows look like pre-Wave-2
    // history (the backfill's actual prod population).
    await testDb.pool.query(
      `update dm_message_archive set material_fingerprint = null,
         emitted_fingerprint = null, emitted_event_id = null,
         material_field_provenance = '{}'::jsonb`,
    );

    // Dry-run first: counts only, no writes.
    const dry = await runDmCorrectionsFingerprintBackfill(appStub(), { dryRun: true });
    expect(dry).toMatchObject({ scanned: 3, fingerprinted: 2, emittedClosed: 1, drainOpen: 1, stubsSkipped: 1 });
    const untouched = await testDb.pool.query(
      "select count(*)::int as n from dm_message_archive where material_fingerprint is not null",
    );
    expect(untouched.rows[0].n).toBe(0);

    // Real run.
    const run = await runDmCorrectionsFingerprintBackfill(appStub());
    expect(run).toMatchObject({ scanned: 3, fingerprinted: 2, emittedClosed: 1, drainOpen: 1, stubsSkipped: 1 });

    const rows = await testDb.pool.query(
      `select platform_message_id,
              material_fingerprint is not null as has_material,
              emitted_fingerprint = material_fingerprint as closed,
              emitted_event_id::text as eid,
              material_field_provenance->>'textPlain' as text_prov
       from dm_message_archive order by platform_message_id`,
    );
    const byId = new Map(rows.rows.map((row: Record<string, unknown>) => [row.platform_message_id, row]));
    // (a) closed against its ledger claim, provenance seeded from source.
    expect(byId.get("9001")).toMatchObject({
      has_material: true,
      closed: true,
      eid: String(evented.events[0]!.eventId),
      text_prov: "legacy:webhook",
    });
    // (b) fingerprinted, open (the drain), provenance from rest_reconcile.
    expect(byId.get("9002")).toMatchObject({
      has_material: true,
      closed: null, // emitted NULL = comparison NULL
      text_prov: "legacy:rest_reconcile",
    });
    // (c) stub untouched.
    expect(byId.get("9003")).toMatchObject({ has_material: false });

    // Idempotent: nothing left to scan.
    const again = await runDmCorrectionsFingerprintBackfill(appStub());
    expect(again).toMatchObject({ scanned: 1, fingerprinted: 0, stubsSkipped: 1 });

    // THE preamble-1 assertion: the reconciler after the backfill appends
    // ONLY the drain (9002's first event) — zero redundant superseding
    // events for the already-evented history.
    const reconcile = await runDmCorrectionsReconcile(appStub(true));
    expect(reconcile).toMatchObject({ scanned: 1, firstEvents: 1, superseding: 0, errored: 0 });
    const eventCount = await testDb.pool.query(
      "select count(*)::int as n from domain_events where account_id = $1",
      [pageId],
    );
    expect(eventCount.rows[0].n).toBe(2); // the original + 9002's first event
  });
});
