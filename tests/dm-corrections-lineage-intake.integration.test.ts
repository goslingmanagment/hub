import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertObservation,
  listDmRepairSignalRows,
  setPageOfapiAccountId,
  upsertDmMessageArchive,
} from "@agency_hub_core/db";

import { runDmCorrectionsFingerprintBackfill } from "../apps/runtime/src/services/dm-corrections-backfill.ts";
import { runDmCorrectionsLineageIntake } from "../apps/runtime/src/services/dm-corrections-lineage-intake.ts";
import {
  resetDmCorrectionsSweepCursor,
  runDmCorrectionsReconcile,
} from "../apps/runtime/src/services/dm-corrections-reconciler.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// W2.1 (decision #123): the prod reconciler skipped 100% of the drain —
// pre-#49 webhook rows have no observation, and the journal only retains
// ~14 days. The intake journals the missing lineage (verbatim journal
// envelope when it survives, archive-material reconstruction when it does
// not) and the reconciler then drains first events normally. The sweep
// cursor must survive across runs so permanently-skipped rows cannot
// head-block the rows behind them (the second 2026-07-10 defect).

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
    await testDb.pool.query("drop table if exists ofapi_webhook_events_w2_lineage_snapshot");
    resetDmCorrectionsSweepCursor();
  }
});

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

describe("corrections lineage intake (W2.1, decision #123)", () => {
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
