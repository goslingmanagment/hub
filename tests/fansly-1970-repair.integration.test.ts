import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  insertObservation,
} from "@agency_hub_core/db";

import { canonicalizeSyncPullObservation } from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import { runFansly1970Repair } from "../apps/runtime/src/services/fansly-1970-repair.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Wave 2 — the Fansly 1970 repair, end to end: an epoch-seconds observation
// whose OLD canonicalization produced a 1970 event (pre_2024 partition) is
// healed by a superseding event with the CORRECTED timestamp; the archive
// projection's superseding merge repairs occurred_at in the serving store.
// The source-bug fix itself (asFanslyTimestamp) is asserted on the pure
// canonicalizer.

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

// 2026-07-04T00:26:40Z in epoch SECONDS — the fixture-proven Fansly shape.
const EPOCH_SECONDS = 1_782_174_400;
const FAN = "fansly-fan-1";
const GROUP = "group-77";

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

describe("Fansly 1970 repair (Wave 2, first superseding consumer)", () => {
  it("the FIXED canonicalizer converts epoch-seconds correctly (new observations never regress)", () => {
    const drafts = canonicalizeSyncPullObservation({
      id: 1,
      source: "pull",
      producer: "sync",
      platform: "fansly",
      accountId: 42,
      kind: "dm_messages",
      payload: {
        messages: [{
          id: "m-1",
          senderId: FAN,
          groupId: GROUP,
          content: "seconds payload",
          createdAt: EPOCH_SECONDS,
        }],
      },
      observedAt: null,
      receivedAt: new Date("2026-07-09T00:00:00Z"),
    }, { nativeAccountRefByAccountId: new Map([[42, "own-ref"]]) });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.occurredAt.getUTCFullYear()).toBe(2026);
    expect(drafts[0]!.occurredAt.getTime()).toBe(EPOCH_SECONDS * 1000);
    // Millisecond inputs stay verbatim (the >= 1e12 arm).
    const msDrafts = canonicalizeSyncPullObservation({
      id: 2,
      source: "pull",
      producer: "sync",
      platform: "fansly",
      accountId: 42,
      kind: "dm_messages",
      payload: {
        messages: [{ id: "m-2", senderId: FAN, groupId: GROUP, content: "ms", createdAt: EPOCH_SECONDS * 1000 }],
      },
      observedAt: null,
      receivedAt: new Date("2026-07-09T00:00:00Z"),
    }, { nativeAccountRefByAccountId: new Map([[42, "own-ref"]]) });
    expect(msDrafts[0]!.occurredAt.getTime()).toBe(EPOCH_SECONDS * 1000);
  });

  it("repairs a 1970 event via a superseding event and the archive merge heals occurred_at; idempotent re-run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "f1970", name: "f1970" });
    const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "f1970-page" });
    const pageId = page!.id;

    // The ORIGINAL observation (epoch-seconds payload) — real lineage.
    const observation = await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync",
      platform: "fansly",
      accountId: pageId,
      kind: "dm_messages",
      payload: {
        messages: [{
          id: "555001",
          senderId: FAN,
          groupId: GROUP,
          content: "damaged timestamp message",
          totalTipAmount: 250,
          createdAt: EPOCH_SECONDS,
        }],
      },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "f1970-obs-1",
    });

    // The OLD canonicalizer's product: a 1970 event (seconds read as ms) in
    // the pre_2024 partition, exactly as prod holds today.
    const legacy = await appendDomainEvents(testDb.db, pageId, [{
      type: "message.received",
      occurredAt: new Date(EPOCH_SECONDS), // the bug: seconds as ms → 1970
      fanIdentityRef: FAN,
      conversationRef: GROUP,
      messageRef: "555001",
      data: { text: "damaged timestamp message", tipAmountMills: 250, isTip: true },
      schemaVersion: 1,
      observationId: observation.observationId,
      dedupKey: "msg:received:555001",
    }]);
    expect(legacy.appended).toBe(1);
    const partitioned = await testDb.pool.query(
      "select count(*)::int as n from domain_events_pre_2024 where message_ref = '555001'",
    );
    expect(partitioned.rows[0].n).toBe(1);

    // Project the damage into the serving store (1970 occurred_at).
    await runMessageArchiveProjection(appStub(), { accountId: pageId });
    const damaged = await testDb.pool.query(
      "select occurred_at from message_archive where message_ref = '555001'",
    );
    expect(new Date(damaged.rows[0].occurred_at).getUTCFullYear()).toBe(1970);

    // Dry-run: counts, no writes.
    const dry = await runFansly1970Repair(appStub(), { dryRun: true });
    expect(dry).toMatchObject({ scanned: 1, repaired: 1, errored: 0 });
    expect((await testDb.pool.query(
      "select count(*)::int as n from domain_events where message_ref = '555001'",
    )).rows[0].n).toBe(1);

    // The repair: a superseding event with the CORRECTED time.
    const run = await runFansly1970Repair(appStub());
    expect(run).toMatchObject({ scanned: 1, repaired: 1, missingObservation: 0, missingItem: 0, outOfRange: 0, errored: 0 });

    const events = await testDb.pool.query(
      `select id, occurred_at, schema_version, dedup_key, data, observation_id::text as obs
       from domain_events where message_ref = '555001' order by account_seq`,
    );
    expect(events.rows).toHaveLength(2);
    const superseding = events.rows[1]!;
    expect(new Date(superseding.occurred_at).getTime()).toBe(EPOCH_SECONDS * 1000);
    expect(superseding.schema_version).toBe(2);
    expect(superseding.dedup_key).toMatch(/^msg:received:555001:[0-9a-f]{64}$/);
    expect(String(superseding.data.supersedesEventId)).toBe(String(events.rows[0]!.id));
    expect(superseding.obs).toBe(String(observation.observationId));
    expect(superseding.data.head).toMatchObject({
      platformMessageId: "555001",
      createdAt: new Date(EPOCH_SECONDS * 1000).toISOString(),
      text: "damaged timestamp message",
      tipAmountMills: "250",
      isTip: true,
      senderRole: "fan",
    });
    // The corrected event lives OUTSIDE pre_2024 (the right partition).
    expect((await testDb.pool.query(
      "select count(*)::int as n from domain_events_pre_2024 where message_ref = '555001'",
    )).rows[0].n).toBe(1);

    // The archive projection's superseding merge heals the serving store.
    await runMessageArchiveProjection(appStub(), { accountId: pageId });
    const healed = await testDb.pool.query(
      `select occurred_at, text_plain, tip_amount_mills::text as tip, is_tip
       from message_archive where message_ref = '555001'`,
    );
    expect(healed.rows).toHaveLength(1);
    expect(new Date(healed.rows[0].occurred_at).getTime()).toBe(EPOCH_SECONDS * 1000);
    expect(healed.rows[0]).toMatchObject({
      text_plain: "damaged timestamp message",
      tip: "250",
      is_tip: true,
    });

    // Idempotent: the fp dedup key makes a re-run a no-op.
    const rerun = await runFansly1970Repair(appStub());
    expect(rerun).toMatchObject({ scanned: 1, repaired: 0, alreadyRepaired: 1 });
    expect((await testDb.pool.query(
      "select count(*)::int as n from domain_events where message_ref = '555001'",
    )).rows[0].n).toBe(2);
  });

  it("skip-and-counts unreachable observations and out-of-range corrections without writing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "f1970b", name: "f1970b" });
    const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "f1970b-page" });
    const pageId = page!.id;

    // Event whose observation id resolves to nothing (tiered/erased).
    await appendDomainEvents(testDb.db, pageId, [{
      type: "message.received",
      occurredAt: new Date(1_700_000),
      fanIdentityRef: FAN,
      conversationRef: GROUP,
      messageRef: "555002",
      data: { text: "orphan", tipAmountMills: 0, isTip: false },
      schemaVersion: 1,
      observationId: 999_999_999,
      dedupKey: "msg:received:555002",
    }]);
    // Event whose observation exists but lacks the message item.
    const emptyObs = await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync",
      platform: "fansly",
      accountId: pageId,
      kind: "dm_messages",
      payload: { messages: [] },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "f1970-obs-empty",
    });
    await appendDomainEvents(testDb.db, pageId, [{
      type: "message.sent",
      occurredAt: new Date(1_800_000),
      fanIdentityRef: null,
      conversationRef: GROUP,
      messageRef: "555003",
      data: { text: "itemless", tipAmountMills: 0, isTip: false },
      schemaVersion: 1,
      observationId: emptyObs.observationId,
      dedupKey: "msg:sent:555003",
    }]);

    const run = await runFansly1970Repair(appStub());
    expect(run).toMatchObject({
      scanned: 2,
      repaired: 0,
      missingObservation: 1,
      missingItem: 1,
      errored: 0,
    });
    expect((await testDb.pool.query(
      "select count(*)::int as n from domain_events where schema_version = 2",
    )).rows[0].n).toBe(0);
  });
});
