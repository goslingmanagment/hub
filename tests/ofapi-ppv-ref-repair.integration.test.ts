import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createModel,
  createOnlyFansPage,
  domainEventNotSupersededSql,
  ensureCapturePayloadCatalogPartitions,
  ensureDomainEventPartitions,
  ensureObservationPartitions,
  insertObservation,
  putPayloadObject,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { runOfapiPpvRefRepair } from "../apps/runtime/src/services/ofapi-ppv-ref-repair.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// H2 (INC-001): the repair for the pre-2026-07-15 message.ppv_unlocked events
// that name the page's own CREATOR as fan and conversation. Replay cannot heal
// them (same `ppv:<notificationId>` dedup key), so the repair appends a
// SUPERSEDING event: schema 2, refs re-derived from the source observation
// (whose July body lives only in the payload catalog), the ORIGINAL
// occurred_at, data.supersedesEventId, dedup key `supersedes:<id>`.

const ACCOUNT = "acct_0r000000000000000000000000000000";
const CREATOR = "514788334";
const FAN = "11166901";
const MESSAGE = "10283976241448";
const JULY = new Date("2026-07-05T10:27:28Z");

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

function app() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage() {
  const db = testDb!.db;
  const model = await createModel(db, { slug: "ppv-repair", name: "PPV repair" });
  const page = model ? await createOnlyFansPage(db, { modelId: model.id, label: "ppv-repair-of" }) : undefined;
  if (!page) {
    throw new Error("Expected the repair test page to be created");
  }
  await setPageOfapiAccountId(db, { pageId: page.id, ofapiAccountId: ACCOUNT });
  // The creator's own OnlyFans id — the value the old canonicalizer shipped.
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [CREATOR, page.id]);
  await ensureObservationPartitions(db, { now: JULY, monthsAhead: 0 });
  await ensureDomainEventPartitions(db, { now: JULY, monthsAhead: 0 });
  await ensureCapturePayloadCatalogPartitions(db, "2026-07-01");
  return page;
}

/** A July webhook observation whose body exists ONLY in the payload catalog
 * (pointer-only row), exactly like the production rows. */
async function julyPpvObservation(pageId: number, key: string, payload: Record<string, unknown>) {
  const db = testDb!.db;
  const envelope = { event: "messages.ppv.unlocked", account_id: ACCOUNT, payload };
  const stored = await putPayloadObject(db, {
    representation: "canonical_json",
    json: envelope,
    captureInstant: JULY,
    lane: "platform_capture",
    platformAccountId: pageId,
  });
  const inserted = await insertObservation(db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    nativeAccountRef: ACCOUNT,
    kind: "messages.ppv.unlocked",
    payload: envelope,
    payloadHash: createHash("sha256").update(key).digest(),
    idempotencyKey: key,
    receivedAt: JULY,
    payloadRef: { bucketMonth: stored.bucketMonth, objectId: stored.objectId },
    omitInlinePayload: true,
  });
  const inline = await testDb!.pool.query("select payload from observations where id = $1", [inserted.observationId]);
  expect(inline.rows[0].payload).toBeNull();
  return inserted.observationId;
}

/** What the pre-fix canonicalizer appended for one notification. */
async function appendLegacyEvent(pageId: number, input: {
  observationId: number;
  notificationId: string;
  ref: string;
  messageRef: string | null;
  amountText?: string;
}) {
  const appended = await appendDomainEvents(testDb!.db, pageId, [{
    type: "message.ppv_unlocked",
    occurredAt: new Date("2026-07-05T10:27:00Z"),
    fanIdentityRef: input.ref,
    conversationRef: input.ref,
    messageRef: input.messageRef,
    data: {
      amountText: input.amountText ?? "$13.00",
      messageLink: `<a href='https://onlyfans.com/my/chats/chat/${FAN}?firstId=${MESSAGE}'>message</a>`,
    },
    schemaVersion: 1,
    observationId: input.observationId,
    dedupKey: `ppv:${input.notificationId}`,
  }]);
  return appended.events[0]!.eventId;
}

async function countEvents() {
  const result = await testDb!.pool.query(
    "select (select count(*)::int from domain_events) as events, (select count(*)::int from domain_event_keys) as keys",
  );
  return result.rows[0] as { events: number; keys: number };
}

describe("OFAPI PPV conversation-ref repair (H2, INC-001)", () => {
  it("supersedes wrong-ref events with re-derived refs: read-only dry run, apply, rerun = 0", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const linkedPayload = {
      id: "115760446358",
      type: "paided_message",
      createdAt: "2026-07-05T10:27:00+00:00",
      user_id: CREATOR,
      replacePairs: {
        "{AMOUNT}": "$13.00",
        "{MESSAGE_LINK}": `<a href='https://onlyfans.com/my/chats/chat/${FAN}?firstId=${MESSAGE}'>message</a>`,
      },
    };
    // 1. Repairable: the chat ref is in the link (no payload.user, the live shape).
    const obsWrong = await julyPpvObservation(page.id, "july-1", linkedPayload);
    const wrongId = await appendLegacyEvent(page.id, {
      observationId: obsWrong, notificationId: "115760446358", ref: CREATOR, messageRef: MESSAGE,
    });
    // 2. Wrong, but its body names no chat at all — never guessed.
    const obsBlind = await julyPpvObservation(page.id, "july-2", {
      id: "115760446359", createdAt: "2026-07-05T10:28:00+00:00", user_id: CREATOR,
      replacePairs: { "{AMOUNT}": "$9.00", "{MESSAGE_LINK}": "<p>no link</p>" },
    });
    const blindId = await appendLegacyEvent(page.id, {
      observationId: obsBlind, notificationId: "115760446359", ref: CREATOR, messageRef: null,
    });
    // 3. Already correct (post-fix): not a candidate at all.
    const obsGood = await julyPpvObservation(page.id, "july-3", {
      ...linkedPayload, id: "115760446360", user: { id: Number(FAN) },
    });
    const goodId = await appendLegacyEvent(page.id, {
      observationId: obsGood, notificationId: "115760446360", ref: FAN, messageRef: MESSAGE,
    });

    // Dry run (the default) counts and writes nothing.
    const before = await countEvents();
    const dry = await runOfapiPpvRefRepair(app());
    expect(dry).toMatchObject({
      dryRun: true, scanned: 2, repaired: 1, alreadyRepaired: 0, missingChatRef: 1,
      alreadyCorrect: 0, missingObservation: 0, unavailableBody: 0, partitionBlocked: 0, errored: 0,
    });
    expect(await countEvents()).toEqual(before);

    const applied = await runOfapiPpvRefRepair(app(), { dryRun: false });
    expect(applied).toMatchObject({
      dryRun: false, scanned: 2, repaired: 1, alreadyRepaired: 0, missingChatRef: 1, errored: 0,
    });

    const superseding = await testDb.pool.query(
      `select type, schema_version, occurred_at, fan_identity_ref, conversation_ref, message_ref,
              observation_id::int, data, tableoid::regclass::text as partition
       from domain_events where dedup_key = $1`,
      [`supersedes:${wrongId}`],
    );
    expect(superseding.rows).toHaveLength(1);
    expect(superseding.rows[0]).toMatchObject({
      type: "message.ppv_unlocked",
      schema_version: 2,
      // The ORIGINAL fact time, in the original month's partition.
      occurred_at: new Date("2026-07-05T10:27:00Z"),
      partition: "domain_events_2026_07",
      fan_identity_ref: FAN,
      conversation_ref: FAN,
      message_ref: MESSAGE,
      observation_id: obsWrong,
    });
    expect(superseding.rows[0].data).toEqual({
      amountText: "$13.00",
      amountUsd: 13,
      messageLink: linkedPayload.replacePairs["{MESSAGE_LINK}"],
      supersedesEventId: wrongId,
      repair: "ofapi_ppv_creator_conversation_ref",
    });

    // Later consumers (H3's facts route) recognise the superseded original.
    // The exported predicate itself, rendered by the app's own dialect.
    const predicate = (testDb.db as unknown as {
      dialect: { sqlToQuery: (query: unknown) => { sql: string; params: unknown[] } };
    }).dialect.sqlToQuery(domainEventNotSupersededSql("e"));
    const live = await testDb.pool.query<{ id: string }>(
      `select e.id::text as id from domain_events e
       where e.type = 'message.ppv_unlocked' and ${predicate.sql}
       order by e.id`,
      predicate.params,
    );
    const liveIds = live.rows.map((row) => Number(row.id));
    expect(liveIds).not.toContain(wrongId);
    expect(liveIds).toEqual(expect.arrayContaining([blindId, goodId]));
    expect(liveIds).toHaveLength(3);

    // Idempotent: a re-run (and a dry run after it) repairs nothing.
    const afterApply = await countEvents();
    expect(await runOfapiPpvRefRepair(app(), { dryRun: false })).toMatchObject({
      scanned: 2, repaired: 0, alreadyRepaired: 1, missingChatRef: 1, errored: 0,
    });
    expect(await runOfapiPpvRefRepair(app())).toMatchObject({
      dryRun: true, repaired: 0, alreadyRepaired: 1,
    });
    expect(await countEvents()).toEqual(afterApply);
    expect(await runOfapiPpvRefRepair(app(), { limit: 1 })).toMatchObject({ scanned: 1 });
    expect(await runOfapiPpvRefRepair(app(), { accountId: page.id + 1000 })).toMatchObject({ scanned: 0 });

    // The event-fed archive applies the repaired (and the superseded) unlock
    // harmlessly: the message ref was right all along.
    await expect(runMessageArchiveProjection(app(), { accountId: page.id })).resolves.toMatchObject({
      eventsSeen: 4,
    });
  });
});
