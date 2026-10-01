import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  advanceDmEmittedFingerprint,
  appendDomainEvents,
  computeDmMaterialFingerprint,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listDmRepairSignalRows,
  type MessageFactCandidate,
  rebuildDmMessageDailyAggregates,
  reduceDmMessageCandidate,
  setPageOfapiAccountId,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
  upsertDmMessageArchiveFromReadthrough,
} from "@agency_hub_core/db";

import { runDmCorrectionsFingerprintBackfill } from "../apps/runtime/src/services/dm-corrections-backfill.ts";
import { runDmCorrectionsLineageIntake } from "../apps/runtime/src/services/dm-corrections-lineage-intake.ts";
import {
  resetDmCorrectionsSweepCursor,
  runDmCorrectionsReconcile,
} from "../apps/runtime/src/services/dm-corrections-reconciler.ts";
import { buildMessagePayloadEnrichments } from "../apps/runtime/src/services/domain-events-enrich.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  type StartedTestDatabase,
  startIntegrationTestDatabase,
} from "./helpers/db.ts";

// Everything that writes or reads `dm_message_archive` and its Wave 2
// corrections bookkeeping, on one database per file run. Each block keeps its
// own fixtures (account and fan refs are opaque per block).

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  await testDb.pool.query("drop table if exists ofapi_webhook_events_w2_lineage_snapshot");
  resetDmCorrectionsSweepCursor();
});

describe("DM daily analytics aggregates", () => {
  it("rebuilds aggregate-only UTC facts idempotently and corrects tombstones", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, { slug: "dm-analytics", name: "DM Analytics" });
    if (!model) throw new Error("expected the model");
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "dm-analytics-of",
    });
    if (!page) throw new Error("expected the OnlyFans page");
    const base = {
      platform: "onlyfans" as const,
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      senderPlatformUserId: null,
      priceMills: null,
      isOpened: null,
      isTip: false,
      tipAmountMills: 0n,
      inReplyToMessageId: null,
      source: "webhook" as const,
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    };

    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "100",
      fanPlatformUserId: "100",
      platformMessageId: "inbound",
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-06-20T00:10:00.000Z"),
      textPlain: "not copied to aggregate",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "evt_inbound",
      sourceJournalId: 1,
      sourceFanoutSeq: 10,
      sourceReceivedAt: new Date("2026-06-20T00:10:01.000Z"),
    });
    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "100",
      fanPlatformUserId: "100",
      platformMessageId: "outbound",
      senderRole: "model",
      isSentByMe: true,
      messageCreatedAt: new Date("2026-06-20T00:12:00.000Z"),
      textPlain: "not copied to aggregate",
      priceMills: 25_000n,
      sourceEventType: "messages.sent",
      sourceIdempotencyKey: "evt_outbound",
      sourceJournalId: 2,
      sourceFanoutSeq: 11,
      sourceReceivedAt: new Date("2026-06-20T00:12:01.000Z"),
    });
    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "200",
      fanPlatformUserId: "200",
      platformMessageId: "tip",
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-06-20T00:15:00.000Z"),
      textPlain: "not copied to aggregate",
      isTip: true,
      tipAmountMills: 5_000n,
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "evt_tip",
      sourceJournalId: 3,
      sourceFanoutSeq: 12,
      sourceReceivedAt: new Date("2026-06-20T00:15:01.000Z"),
    });
    await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      platformMessageId: "deleted-only",
      deletedAt: new Date("2026-06-20T00:20:00.000Z"),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "evt_deleted",
      sourceJournalId: 4,
      sourceFanoutSeq: 13,
      sourceReceivedAt: new Date("2026-06-20T00:20:01.000Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    });

    const rebuild = async () => rebuildDmMessageDailyAggregates(testDb!.db, {
      fromBusinessDate: "2026-06-20",
      throughBusinessDate: "2026-06-20",
      rebuiltAt: new Date("2026-06-20T01:00:00.000Z"),
    });
    await rebuild();
    await rebuild();

    // `select *`: the aggregate table itself must hold no message text or media.
    const aggregates = async () => (await testDb!.pool.query<Record<string, unknown>>(
      `select *, business_date::text as business_date_text from dm_message_daily_aggregates
        where business_date = '2026-06-20'`,
    )).rows;
    let [row] = await aggregates();
    expect(row).toMatchObject({
      platform_account_id: BigInt(page.id),
      business_date_text: "2026-06-20",
      archive_rows: 4,
      inbound_messages: 2,
      outbound_messages: 1,
      deleted_messages: 1,
      distinct_conversations: 2,
      paid_outbound_messages: 1,
      paid_outbound_price_mills: 25_000n,
      tip_messages: 1,
      tip_amount_mills: 5_000n,
      source_max_fanout_seq: 13n,
    });
    expect(row).not.toHaveProperty("text_plain");
    expect(row).not.toHaveProperty("media_metadata");

    await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      platformMessageId: "outbound",
      deletedAt: new Date("2026-06-20T00:30:00.000Z"),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "evt_outbound_deleted",
      sourceJournalId: 5,
      sourceFanoutSeq: 14,
      sourceReceivedAt: new Date("2026-06-20T00:30:01.000Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    });
    await rebuild();

    [row] = await aggregates();
    expect(row).toMatchObject({
      archive_rows: 4,
      outbound_messages: 0,
      deleted_messages: 2,
      paid_outbound_messages: 0,
      paid_outbound_price_mills: 0n,
      source_max_fanout_seq: 14n,
    });
  });
});

describe("candidate reducer bookkeeping (Wave 2)", () => {
  // Wave 2 corrections — the candidate reducer's NEW bookkeeping on top of the
  // (already-pinned) amendment-3 merge semantics: material fingerprints from
  // the reduced head, emitted discipline per design note §1, per-field
  // provenance, the repair-signal listing, and the guarded emitted advance.
  const ACCT = "acct_cand";
  const FAN = "888200888";

  async function seedPage(label = "cand-page") {
    const model = await createModel(testDb!.db, { slug: label, name: label });
    if (!model) throw new Error("model seed failed");
    const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
    if (!page) throw new Error("page seed failed");
    await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: ACCT });
    return page;
  }

  function webhookCandidate(
    pageId: number,
    overrides: Partial<MessageFactCandidate> = {},
  ): MessageFactCandidate {
    return {
      source: "webhook",
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId: ACCT,
      platformMessageId: "7001",
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "hello",
      priceMills: null,
      isOpened: null,
      isTip: false,
      tipAmountMills: 0n,
      inReplyToMessageId: null,
      mediaMetadata: [],
      sourceEventType: "messages.received",
      sourceIdempotencyKey: `cand-wh-${overrides.platformMessageId ?? "7001"}-${overrides.sourceReceivedAt?.getTime() ?? "a"}`,
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-05T10:00:01Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  async function fingerprintColumns(messageId: string) {
    const { rows } = await testDb!.pool.query(
      `select encode(material_fingerprint, 'hex') as material,
              encode(emitted_fingerprint, 'hex') as emitted,
              emitted_event_id, revision_no, material_field_provenance,
              rest_platform_changed_at
       from dm_message_archive where platform_message_id = $1`,
      [messageId],
    );
    return rows[0] as {
      material: string | null;
      emitted: string | null;
      emitted_event_id: string | null;
      revision_no: number;
      material_field_provenance: Record<string, string>;
      rest_platform_changed_at: Date | null;
    } | undefined;
  }

  it("webhook INSERT sets material fingerprint from the reduced head AND emitted = material (design note §1)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const result = await reduceDmMessageCandidate(testDb.db, webhookCandidate(page.id));
    expect(result.status).toBe("written");
    expect(result.materialChanged).toBe(true);

    const row = await fingerprintColumns("7001");
    expect(row!.material).not.toBeNull();
    // Webhook first-write: the canonicalizer emits the first ledger event
    // from the same journal row — emitted = material, no reconciler append.
    expect(row!.emitted).toBe(row!.material);
    expect(row!.revision_no).toBe(1);
    expect(row!.material_field_provenance.textPlain).toBe("webhook");
    // The fingerprint matches an independent computation over the head.
    const expected = computeDmMaterialFingerprint({
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "hello",
      priceMills: null,
      isOpened: null,
      isTip: false,
      tipAmountMills: 0n,
      inReplyToMessageId: null,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      mediaMetadata: [],
    });
    expect(row!.material).toBe(expected.toString("hex"));
    // In-ledger webhook row: NOT in the repair-signal list.
    expect(await listDmRepairSignalRows(testDb.db, {})).toHaveLength(0);
  });

  it("REST INSERT leaves emitted NULL (reconciler appends the first event) and stores platform changedAt separately", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const result = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7002",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T11:00:00Z"),
      textPlain: "rest only",
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 515151,
      observationReceivedAt: new Date("2026-07-05T11:00:05Z"),
      platformChangedAt: new Date("2026-07-05T11:00:02Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(result.status).toBe("written");
    const row = await fingerprintColumns("7002");
    expect(row!.material).not.toBeNull();
    expect(row!.emitted).toBeNull();
    expect(row!.rest_platform_changed_at).toEqual(new Date("2026-07-05T11:00:02Z"));
    expect(row!.material_field_provenance.textPlain).toBe("rest_reconcile");
    // No ledger event yet → the repair signal flags it for the reconciler.
    const flagged = await listDmRepairSignalRows(testDb.db, {});
    expect(flagged.map((r) => r.platformMessageId)).toEqual(["7002"]);
  });

  it("material advance moves material fingerprint but not emitted; guarded advance closes the gap; stale advance refuses", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await reduceDmMessageCandidate(testDb.db, webhookCandidate(page.id, { platformMessageId: "7003", sourceIdempotencyKey: "cand-7003-a" }));
    const before = await fingerprintColumns("7003");
    // REST fills price → material advances, emitted stays (webhook-era fp).
    const advanced = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7003",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "hello",
      priceMills: 4000n,
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 626262,
      observationReceivedAt: new Date("2026-07-05T12:00:00Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(advanced.status).toBe("written");
    const after = await fingerprintColumns("7003");
    expect(after!.material).not.toBe(before!.material);
    expect(after!.emitted).toBe(before!.emitted);
    expect(after!.material_field_provenance.priceMills).toBe("rest_reconcile");
    expect(after!.material_field_provenance.textPlain).toBe("webhook");

    const flagged = await listDmRepairSignalRows(testDb.db, {});
    expect(flagged.map((r) => r.platformMessageId)).toEqual(["7003"]);
    const rowId = flagged[0]!.id;

    // A STALE advance (old fingerprint) must refuse — the row stays flagged.
    const staleOk = await advanceDmEmittedFingerprint(testDb.db, {
      rowId,
      fingerprint: Buffer.from(before!.material!, "hex"),
      eventId: 90001,
      superseding: true,
    });
    expect(staleOk).toBe(false);

    // The guarded advance with the CURRENT fingerprint closes the gap and
    // bumps revision_no (superseding append).
    const ok = await advanceDmEmittedFingerprint(testDb.db, {
      rowId,
      fingerprint: Buffer.from(after!.material!, "hex"),
      eventId: 90002,
      superseding: true,
    });
    expect(ok).toBe(true);
    const closed = await fingerprintColumns("7003");
    expect(closed!.emitted).toBe(closed!.material);
    expect(String(closed!.emitted_event_id)).toBe("90002");
    expect(closed!.revision_no).toBe(2);
    expect(await listDmRepairSignalRows(testDb.db, {})).toHaveLength(0);
  });

  it("a material no-op leaves fingerprints, provenance, and updated_at untouched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7004",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "same",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "cand-7004-a",
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-05T10:00:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    const before = await fingerprintColumns("7004");
    // Same material re-delivered (retry): true no-op.
    const replay = await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7004",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "same",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "cand-7004-b",
      sourceJournalId: 2,
      sourceReceivedAt: new Date("2026-07-05T10:05:00Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-02T00:00:00Z"),
    });
    expect(replay.status).toBe("noop");
    const after = await fingerprintColumns("7004");
    expect(after).toEqual(before);
  });
});

describe("corrections fingerprint backfill (Wave 2 preamble)", () => {
  // Wave 2 preamble (tabletop S7): the fingerprint backfill MUST close
  // already-in-ledger history so enabling the reconciler afterwards appends
  // NOTHING redundant — the exact hazard preamble 1 names. REST-only rows are
  // the measured initial-drain bound; stubs stay outside the signal.
  const ACCT = "acct_bf";
  const FAN = "777400777";

  function appStub(reconcile = false) {
    return {
      db: testDb!.db,
      config: { ofapiDmCorrectionsReconcileEnabled: reconcile },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
  }

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

describe("corrections lineage intake (W2.1, decision #123)", () => {
  // W2.1 (decision #123): the prod reconciler skipped 100% of the drain —
  // pre-#49 webhook rows have no observation, and the journal only retains
  // ~14 days. The intake journals the missing lineage (verbatim journal
  // envelope when it survives, archive-material reconstruction when it does
  // not) and the reconciler then drains first events normally. The sweep
  // cursor must survive across runs so permanently-skipped rows cannot
  // head-block the rows behind them (the second 2026-07-10 defect).
  const ACCT = "acct_intake";
  const FAN = "555200555";
  const SNAPSHOT = "ofapi_webhook_events_w2_lineage_snapshot";

  function appStub(reconcile = false) {
    return {
      db: testDb!.db,
      config: { ofapiDmCorrectionsReconcileEnabled: reconcile },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
  }

  async function seedPage(label = "intake-page") {
    const model = await createModel(testDb!.db, { slug: label, name: label });
    const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label });
    await setPageOfapiAccountId(testDb!.db, { pageId: page!.id, ofapiAccountId: ACCT });
    return page!.id;
  }

  async function seedWebhookArchiveRow(pageId: number, messageId: string, idempotencyKey: string) {
    await upsertDmMessageArchive(testDb!.db, {
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: messageId,
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-06-20T10:00:00Z"),
      textPlain: `pre-#49 message ${messageId}`,
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: idempotencyKey,
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-06-20T10:00:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
  }

  async function insertJournalRow(table: string, idempotencyKey: string, messageId: string) {
    await testDb!.pool.query(
      `insert into ${table} (idempotency_key, event_type, ofapi_account_id, payload, status, projection_status)
       values ($1, 'messages.received', $2, $3, 'settled', 'projected')`,
      [idempotencyKey, ACCT, JSON.stringify({ id: messageId, text: `wire ${messageId}` })],
    );
  }

  /** The W2 writers stamp fingerprints at write time; the intake's actual
   * population is PRE-Wave-2 history — mirror the backfill test's reset. */
  async function stripWave2Bookkeeping() {
    await testDb!.pool.query(
      `update dm_message_archive set material_fingerprint = null,
         emitted_fingerprint = null, emitted_event_id = null,
         material_field_provenance = '{}'::jsonb`,
    );
  }

  it("intakes journal-armed rows verbatim, reconstructs journal-less rows, and the reconciler then drains them all", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();

    // (a) journal row alive in the LIVE table.
    await seedWebhookArchiveRow(pageId, "7001", "evt_live_7001");
    await insertJournalRow("ofapi_webhook_events", "evt_live_7001", "7001");
    // (b) journal row survives only in the SNAPSHOT rescue copy.
    await seedWebhookArchiveRow(pageId, "7002", "evt_snap_7002");
    await testDb.pool.query(
      `create table ${SNAPSHOT} (like ofapi_webhook_events including defaults)`,
    );
    await insertJournalRow(SNAPSHOT, "evt_snap_7002", "7002");
    // (c) no journal payload anywhere — material reconstruction.
    await seedWebhookArchiveRow(pageId, "7003", "evt_gone_7003");
    await stripWave2Bookkeeping();

    const backfill = await runDmCorrectionsFingerprintBackfill(appStub());
    expect(backfill.drainOpen).toBe(3);

    // Reconciler alone cannot drain any of them (the prod 2026-07-10 state).
    const stuck = await runDmCorrectionsReconcile(appStub(true));
    expect(stuck.lineageSkips).toBe(3);
    expect(stuck.firstEvents).toBe(0);
    expect(stuck.lineageSkipSample).toHaveLength(3);

    const dry = await runDmCorrectionsLineageIntake(appStub(), { dryRun: true });
    expect(dry).toMatchObject({
      scanned: 3, journalIntaken: 2, materialIntaken: 1, alreadyResolvable: 0, errored: 0,
    });

    const real = await runDmCorrectionsLineageIntake(appStub());
    expect(real).toMatchObject({ journalIntaken: 2, materialIntaken: 1 });

    // Idempotent rerun: everything already resolves.
    const rerun = await runDmCorrectionsLineageIntake(appStub());
    expect(rerun).toMatchObject({
      scanned: 3, alreadyResolvable: 3, journalIntaken: 0, materialIntaken: 0,
    });

    // The intaken observations are honest anchors: verbatim envelope in the
    // webhook lane (original key), material head in the operator lane.
    const lanes = await testDb.pool.query<{ source: string; kind: string; n: string }>(
      `select source, kind, count(*)::text as n from observations
       where producer = 'cli:corrections-lineage-intake' group by 1, 2 order by 1`,
    );
    expect(lanes.rows).toEqual([
      { source: "operator", kind: "dm_archive_material_reconstruction", n: "1" },
      { source: "webhook", kind: "ofapi_webhook_lineage_backfill", n: "2" },
    ]);

    resetDmCorrectionsSweepCursor();
    const drained = await runDmCorrectionsReconcile(appStub(true));
    expect(drained.firstEvents).toBe(3);
    expect(drained.lineageSkips).toBe(0);

    const remaining = await listDmRepairSignalRows(testDb.db, { limit: 10 });
    expect(remaining).toHaveLength(0);
  });

  it("sweep cursor advances past skipped rows across runs instead of head-blocking", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage("cursor-page");

    // Three unresolvable rows at the head, one lineage-armed row behind them.
    await seedWebhookArchiveRow(pageId, "8001", "evt_gone_8001");
    await seedWebhookArchiveRow(pageId, "8002", "evt_gone_8002");
    await seedWebhookArchiveRow(pageId, "8003", "evt_gone_8003");
    await seedWebhookArchiveRow(pageId, "8004", "evt_live_8004");
    await stripWave2Bookkeeping();
    await runDmCorrectionsFingerprintBackfill(appStub());
    // Arm ONLY the tail row's lineage — the head three stay skipped.
    await insertObservation(testDb.db, {
      source: "webhook",
      producer: "test",
      platform: "onlyfans",
      accountId: pageId,
      kind: "ofapi_webhook_lineage_backfill",
      payload: { event: "messages.received", account_id: ACCT, payload: { id: "8004" } },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "evt_live_8004",
    });

    // A sweep capped at 2 rows/run used to rescan {8001, 8002} forever.
    resetDmCorrectionsSweepCursor();
    const first = await runDmCorrectionsReconcile(appStub(true), { pageSize: 2, maxPages: 1 });
    expect(first).toMatchObject({ scanned: 2, lineageSkips: 2, firstEvents: 0 });

    const second = await runDmCorrectionsReconcile(appStub(true), { pageSize: 2, maxPages: 1 });
    expect(second).toMatchObject({ scanned: 2, lineageSkips: 1, firstEvents: 1 });

    // Past the end: an empty page resets the cursor for the next cycle...
    const third = await runDmCorrectionsReconcile(appStub(true), { pageSize: 2, maxPages: 1 });
    expect(third.scanned).toBe(0);

    // ...and the wrapped sweep rescans the still-flagged head rows.
    const fourth = await runDmCorrectionsReconcile(appStub(true), { pageSize: 2, maxPages: 1 });
    expect(fourth).toMatchObject({ scanned: 2, lineageSkips: 2 });
  });
});

describe("DM corrections reconciler (Wave 2)", () => {
  // Wave 2 corrections — the reconciler end-to-end: first events for
  // REST/command-only rows (canonical dedup key, dedupe-proof against a late
  // webhook), superseding events for advanced material (fp dedup key, complete
  // head), the message_archive same-message superseding merge, and head-based
  // enrichment for v2 frames.
  const ACCT = "acct_rec";
  const FAN = "999300999";

  function appStub() {
    return {
      db: testDb!.db,
      config: { ofapiDmCorrectionsReconcileEnabled: true },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
  }

  async function seedPage(label = "rec-page") {
    const model = await createModel(testDb!.db, { slug: label, name: label });
    if (!model) throw new Error("model seed failed");
    const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
    if (!page) throw new Error("page seed failed");
    await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: ACCT });
    return page;
  }

  /** A real readthrough observation so the reconciler's lineage resolution
   * (rest_material_observation_id) points at a real journal row. */
  async function seedRestRow(pageId: number, messageId: string, text: string, priceMills?: bigint) {
    const observation = await insertObservation(testDb!.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: pageId,
      kind: "ofapi_gateway_chat_messages_v2",
      payload: { ofapiAccountId: ACCT, chatId: FAN, conversationRef: FAN, cursors: {}, body: { data: [] } },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: `rec-obs-${messageId}-${text.length}-${priceMills ?? "x"}`,
    });
    const written = await upsertDmMessageArchiveFromReadthrough(testDb!.db, {
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: messageId,
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-06T10:00:00Z"),
      textPlain: text,
      priceMills: priceMills ?? null,
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: observation.observationId,
      observationReceivedAt: observation.receivedAt,
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    return { observation, written };
  }

  async function eventRows(accountId: number) {
    const { rows } = await testDb!.pool.query(
      `select e.id, e.type, e.schema_version, e.dedup_key, e.data, e.account_seq
       from domain_events e where e.account_id = $1 order by e.account_seq`,
      [accountId],
    );
    return rows as Array<{
      id: string;
      type: string;
      schema_version: number;
      dedup_key: string;
      data: Record<string, unknown>;
      account_seq: string;
    }>;
  }

  it("appends the FIRST event for a REST-only row with the CANONICAL key; a late webhook canonicalizer emission dedups against it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedRestRow(page.id, "8001", "rest only message");

    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 1, firstEvents: 1, superseding: 0, errored: 0 });

    const events = await eventRows(page.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      schema_version: 1,
      dedup_key: "msg:received:8001",
    });
    expect(events[0]!.data.text).toBe("rest only message");

    // Row bookkeeping closed: emitted = material, event id linked.
    const { rows } = await testDb.pool.query(
      `select emitted_fingerprint = material_fingerprint as closed, emitted_event_id::text as eid, revision_no
       from dm_message_archive where platform_message_id = '8001'`,
    );
    expect(rows[0]).toMatchObject({ closed: true, revision_no: 1 });
    expect(String(rows[0].eid)).toBe(String(events[0]!.id));

    // The late webhook's canonicalizer emission dedups silently (the
    // cross-producer proof, now covering reconciler-emitted first events).
    const late = await appendDomainEvents(testDb.db, page.id, [{
      type: "message.received",
      occurredAt: new Date("2026-07-06T10:00:00Z"),
      fanIdentityRef: FAN,
      conversationRef: FAN,
      messageRef: "8001",
      data: { text: "rest only message", price: null, isTip: false },
      schemaVersion: 1,
      observationId: 1,
      dedupKey: "msg:received:8001",
    }]);
    expect(late).toMatchObject({ appended: 0, deduped: 1 });

    // Idempotent: a second sweep finds nothing.
    expect((await runDmCorrectionsReconcile(appStub())).scanned).toBe(0);
  });

  it("appends a SUPERSEDING event (fp key, schema v2, complete head) when material advances, and the archive merge heals the projection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // First: REST row → first event via reconciler → projector builds the row.
    await seedRestRow(page.id, "8002", "original text");
    await runDmCorrectionsReconcile(appStub());
    await runMessageArchiveProjection(appStub() as never, { accountId: page.id });
    const before = await testDb.pool.query(
      `select text_plain, price_mills::text as price from message_archive where message_ref = '8002'`,
    );
    expect(before.rows[0]).toMatchObject({ text_plain: "original text", price: null });

    // Material advances: a second readthrough fills the price.
    await seedRestRow(page.id, "8002", "original text", 6000n);
    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ superseding: 1, firstEvents: 0, errored: 0 });

    const events = await eventRows(page.id);
    expect(events).toHaveLength(2);
    const superseding = events[1]!;
    expect(superseding.schema_version).toBe(2);
    expect(superseding.dedup_key).toMatch(/^msg:received:8002:[0-9a-f]{64}$/);
    expect(String(superseding.data.supersedesEventId)).toBe(String(events[0]!.id));
    expect(superseding.data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const head = superseding.data.head as Record<string, unknown>;
    expect(head).toMatchObject({
      platformMessageId: "8002",
      text: "original text",
      priceMills: "6000",
      isSentByMe: false,
    });

    // revision_no bumped; emitted re-closed.
    const { rows } = await testDb.pool.query(
      `select revision_no, emitted_fingerprint = material_fingerprint as closed
       from dm_message_archive where platform_message_id = '8002'`,
    );
    expect(rows[0]).toMatchObject({ revision_no: 2, closed: true });

    // The projector's same-message superseding merge REPLACES material.
    await runMessageArchiveProjection(appStub() as never, { accountId: page.id });
    const after = await testDb.pool.query(
      `select text_plain, price_mills::text as price from message_archive where message_ref = '8002'`,
    );
    expect(after.rows[0]).toMatchObject({ text_plain: "original text", price: "6000" });

    // Enrichment builds the frame payload from the HEAD (no observation
    // envelope lookup for superseding frames).
    const enriched = await buildMessagePayloadEnrichments(appStub() as never, [{
      id: Number(superseding.id),
      accountId: page.id,
      currentAccountRef: ACCT,
      accountSeq: Number(superseding.account_seq),
      type: superseding.type,
      occurredAt: new Date("2026-07-06T10:00:00Z"),
      fanIdentityRef: FAN,
      conversationRef: FAN,
      messageRef: "8002",
      transactionRef: null,
      data: superseding.data,
      schemaVersion: superseding.schema_version,
      observationId: 1,
      dedupKey: superseding.dedup_key,
      createdAt: new Date(),
    }]);
    expect(enriched.get(Number(superseding.id))).toMatchObject({
      id: "8002",
      text: "original text",
      price: 6,
      isSentByMe: false,
    });
  });

  it("skip-and-counts null-ref stubs (preamble 3) without wedging the sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A tombstone stub, then force a material fingerprint onto it so it
    // trips the repair signal (simulates a pathological backfill edge).
    const stub = await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformMessageId: "8003",
      deletedAt: new Date(),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "rec-del-8003",
      sourceJournalId: 1,
      sourceReceivedAt: new Date(),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(stub.status).toBe("written");
    await testDb.pool.query(
      `update dm_message_archive set material_fingerprint = '\\x01' where platform_message_id = '8003'`,
    );
    // And a healthy REST row alongside — the sweep must process it.
    await seedRestRow(page.id, "8004", "healthy neighbor");

    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 2, stubSkips: 1, firstEvents: 1, errored: 0 });
  });

  it("skip-and-counts unresolvable lineage — command-source rows only emit through a REAL command_result observation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A command-source candidate whose cmd observation does NOT exist.
    const orphan = await reduceDmMessageCandidate(testDb.db, {
      source: "command",
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformMessageId: "8005",
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      senderRole: "model",
      isSentByMe: true,
      messageCreatedAt: new Date("2026-07-06T12:00:00Z"),
      textPlain: "orphan send",
      sourceIdempotencyKey: "cmd:nonexistent:confirmed",
      sourceReceivedAt: new Date("2026-07-06T12:00:01Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(orphan.status).toBe("written");
    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 1, lineageSkips: 1, firstEvents: 0 });

    // With the REAL observation in place, the next sweep emits.
    await insertObservation(testDb.db, {
      source: "command_result",
      producer: "ofapi:command-executor",
      platform: "onlyfans",
      accountId: page.id,
      kind: "command.confirmed",
      payload: { commandId: "nonexistent", state: "confirmed" },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "cmd:nonexistent:confirmed",
    });
    const second = await runDmCorrectionsReconcile(appStub());
    expect(second).toMatchObject({ scanned: 1, firstEvents: 1 });
    const events = await eventRows(page.id);
    expect(events[0]).toMatchObject({ type: "message.sent", dedup_key: "msg:sent:8005" });
  });

  it("does nothing when the flag is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedRestRow(page.id, "8006", "flag off");
    const run = await runDmCorrectionsReconcile({
      db: testDb.db,
      config: { ofapiDmCorrectionsReconcileEnabled: false },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    expect(run.scanned).toBe(0);
    expect(await eventRows(page.id)).toHaveLength(0);
  });
});
