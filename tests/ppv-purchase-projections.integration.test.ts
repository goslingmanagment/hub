import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendProjectionOnlyDomainEvents,
  applyDmMessagePurchaseFact,
  computeDmMaterialFingerprint,
  createModel,
  createOnlyFansPage,
  findDmMessageArchiveByPlatformMessageId,
  getOfapiWebhookEventById,
  listDmRepairSignalRows,
  reduceDmMessageCandidate,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { projectOfapiDmEvent } from "../apps/runtime/src/services/ofapi-dm-projection.ts";
import { buildMessageArchiveShadow } from "../apps/runtime/src/services/projections/message-archive-rebuild.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { getOfapiSyncSnapshot } from "../apps/runtime/src/services/ofapi-sync-snapshot.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  reconcileRecentPpvPurchases,
  runPpvPurchaseBackfill,
} from "../apps/runtime/src/services/ppv-purchase-backfill.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// H2 (INC-001): a PPV purchase reaches EVERY hub store, monotonically.
// Before H2 only page_dm_messages.purchased_at heard of it: message_archive
// ignored message.ppv_unlocked, dm_message_archive.is_opened stayed false, and
// the desktop snapshot served hot rows with a hard-coded `price: 0`.

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");
const SIGNING_SECRET = "ppv-purchase-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const ACCOUNT = "acct_0p000000000000000000000000000000";
const CREATOR = "514788334";
const FAN = "1000003";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let keyCounter = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  server = null;
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiDmProjectionEnabled: true,
    ofapiDmColdArchiveEnabled: true,
  });
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_ppv",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
});

async function seedPage() {
  const model = await createModel(appContext.db, { slug: "ppv-proj", name: "PPV projections" });
  const page = model ? await createOnlyFansPage(appContext.db, { modelId: model.id, label: "ppv-proj-of" }) : undefined;
  if (!page) {
    throw new Error("Expected the PPV projections test page to be created");
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: ACCOUNT });
  return page;
}

/** Real receiver + real settle (cold archive, DM projection, live canonicalization). */
async function deliverAndProcess(envelope: Record<string, unknown>, app: AppContext = appContext) {
  keyCounter += 1;
  const body = JSON.stringify(envelope);
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": `ppv_evt_${String(keyCounter).padStart(36, "0")}`,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { rows } = await testDb!.pool.query<{ id: number }>("select max(id)::int as id from ofapi_webhook_events");
  await processOfapiWebhookEvent(app, rows[0]!.id);
  return rows[0]!.id;
}

/** The live messages.sent fixture IS a PPV: price 25, isOpened false, 2 media. */
async function sentPpv(messageId: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, "messages_sent.json"), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  const payload = raw.payload as Record<string, unknown>;
  payload.id = Number(messageId);
  (payload.toUser as Record<string, unknown>).id = Number(FAN);
  return { ...raw, account_id: ACCOUNT };
}

function ppvUnlock(
  notificationId: string,
  messageId: string,
  amount = "$25.00",
  createdAt = "2026-09-20T12:00:00+00:00",
) {
  return {
    event: "messages.ppv.unlocked",
    account_id: ACCOUNT,
    payload: {
      id: notificationId,
      type: "paided_message",
      createdAt,
      text: "Fan paid for your message",
      user_id: CREATOR,
      user: { id: Number(FAN) },
      replacePairs: {
        "{AMOUNT}": amount,
        "{MESSAGE_LINK}": `<a href='https://onlyfans.com/my/chats/chat/${FAN}?firstId=${messageId}'>message</a>`,
      },
    },
  };
}

interface MessageState {
  hotPurchasedAt: Date | null;
  dmIsOpened: boolean | null;
  maIsOpened: boolean | null;
}

async function stateOf(pageId: number, messageId: string): Promise<MessageState> {
  const hot = await testDb!.pool.query(
    "select purchased_at from page_dm_messages where platform_account_id = $1 and platform_message_id = $2",
    [pageId, messageId],
  );
  const dm = await testDb!.pool.query(
    "select is_opened from dm_message_archive where platform_account_id = $1 and platform_message_id = $2",
    [pageId, messageId],
  );
  const ma = await testDb!.pool.query(
    "select is_opened from message_archive where account_id = $1 and message_ref = $2",
    [pageId, messageId],
  );
  return {
    hotPurchasedAt: hot.rows[0]?.purchased_at ?? null,
    dmIsOpened: dm.rows[0]?.is_opened ?? null,
    maIsOpened: ma.rows[0]?.is_opened ?? null,
  };
}

/** The material fingerprint must stay a function of the reduced head, and a
 * purchase must not leave the corrections reconciler a repair signal (which
 * would mint a duplicate superseding message.* frame per purchase). */
async function expectFingerprintConsistent(messageId: string) {
  const row = await findDmMessageArchiveByPlatformMessageId(appContext.db, {
    platform: "onlyfans",
    ofapiAccountId: ACCOUNT,
    platformMessageId: messageId,
  });
  expect(row).not.toBeNull();
  const recomputed = computeDmMaterialFingerprint({
    senderPlatformUserId: row!.senderPlatformUserId,
    senderRole: row!.senderRole,
    isSentByMe: row!.isSentByMe,
    messageCreatedAt: row!.messageCreatedAt,
    textPlain: row!.textPlain,
    priceMills: row!.priceMills,
    isOpened: row!.isOpened,
    isTip: row!.isTip,
    tipAmountMills: row!.tipAmountMills,
    inReplyToMessageId: row!.inReplyToMessageId,
    platformConversationId: row!.platformConversationId,
    fanPlatformUserId: row!.fanPlatformUserId,
    mediaMetadata: row!.mediaMetadata,
  });
  expect(row!.materialFingerprint?.equals(recomputed)).toBe(true);
  expect(row!.emittedFingerprint?.equals(recomputed)).toBe(true);
  expect(row!.materialFieldProvenance.isOpened).toBe("ppv_unlocked");
  const signals = await listDmRepairSignalRows(appContext.db, {});
  expect(signals.map((signal) => signal.platformMessageId)).not.toContain(messageId);
}

async function appendMaterialHead(pageId: number, messageId: string, head: Record<string, unknown>, key: string) {
  const occurredAt = new Date("2026-06-10T21:25:47Z");
  await appendProjectionOnlyDomainEvents(appContext.db, pageId, [{
    type: "message.material_observed",
    occurredAt,
    fanIdentityRef: FAN,
    conversationRef: FAN,
    messageRef: messageId,
    data: {
      head: {
        isSentByMe: true,
        textHtml: "<p>Sample fan message text used in anonymized fixtures.</p>",
        priceMills: "25000",
        materialObservedAt: new Date().toISOString(),
        ...head,
      },
    },
    schemaVersion: 1,
    observationId: 1,
    dedupKey: `test:material:${key}`,
  }], { occurredAt, observationId: 1, dedupKey: `test:material-checkpoint:${key}` });
}

type SnapshotMessage = {
  messageId: string;
  message: { price: number; isOpened?: boolean | null; media?: unknown[] } | null;
};

async function legacySnapshotMessage(pageId: number, messageId: string) {
  const snapshot = await getOfapiSyncSnapshot(appContext, {
    assignedPageIds: [pageId], accountId: ACCOUNT, afterSeq: 0, pageCursor: 0, limit: 50, messageLimit: 50,
  });
  const messages = snapshot.threads.flatMap((thread) => thread.messages as SnapshotMessage[]);
  return messages.find((entry) => entry.messageId === messageId) ?? null;
}

async function boundedSnapshotMessage(pageId: number, messageId: string) {
  const messages: SnapshotMessage[] = [];
  let stateCursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const snapshot = await getOfapiSyncSnapshot(appContext, {
      assignedPageIds: [pageId], accountId: ACCOUNT, afterSeq: 0, pageCursor: 0, limit: 50,
      pageMode: "bounded_v1", messageLimit: 50,
      ...(stateCursor === undefined ? {} : { stateCursor }),
    });
    messages.push(...snapshot.threads.flatMap((thread) => thread.messages as SnapshotMessage[]));
    const next = "nextStateCursor" in snapshot ? snapshot.nextStateCursor : null;
    if (!next) {
      break;
    }
    stateCursor = next;
  }
  return messages.find((entry) => entry.messageId === messageId) ?? null;
}

describe("PPV purchases in every hub projection (H2, INC-001)", () => {
  it("a live purchase opens both archives and the hot row, and nothing can regress it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const MESSAGE = "2000001";
    await deliverAndProcess(await sentPpv(MESSAGE));
    await runMessageArchiveProjection(appContext, { accountId: page.id });
    expect(await stateOf(page.id, MESSAGE)).toEqual({ hotPurchasedAt: null, dmIsOpened: false, maIsOpened: null });

    const unlockJournalId = await deliverAndProcess(ppvUnlock("3000001", MESSAGE));
    expect((await getOfapiWebhookEventById(appContext.db, unlockJournalId))?.projectionStatus).toBe("projected");
    // The DM projection wrote the hot row AND the material head.
    const afterUnlock = await stateOf(page.id, MESSAGE);
    expect(afterUnlock.hotPurchasedAt).not.toBeNull();
    expect(afterUnlock.dmIsOpened).toBe(true);
    await expectFingerprintConsistent(MESSAGE);

    // The receipt canonicalized the unlock with a numeric amount; the event-fed
    // archive applies it.
    const events = await testDb.pool.query(
      "select conversation_ref, message_ref, data from domain_events where account_id = $1 and type = 'message.ppv_unlocked'",
      [page.id],
    );
    expect(events.rows).toEqual([{
      conversation_ref: FAN,
      message_ref: MESSAGE,
      data: expect.objectContaining({ amountText: "$25.00", amountUsd: 25 }),
    }]);
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({
      opened: 1,
      // Nothing was late: the recent-window reconcile finds every store done.
      purchases: { hotPurchasedMarked: 0, messageArchiveOpened: 0, dmArchiveOpened: 0 },
    });
    expect((await stateOf(page.id, MESSAGE)).maIsOpened).toBe(true);

    // Monotonic, archive 1: a later material head that still says "unopened"
    // (a stale REST page) must not undo the purchase.
    await appendMaterialHead(page.id, MESSAGE, { isOpened: false }, "stale");
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({ opened: 0 });
    expect((await stateOf(page.id, MESSAGE)).maIsOpened).toBe(true);

    // Monotonic, archive 2: a stale REST candidate is a material no-op.
    const stale = await reduceDmMessageCandidate(appContext.db, {
      source: "rest_reconcile",
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCOUNT,
      platformMessageId: MESSAGE,
      isOpened: false,
      sourceIdempotencyKey: "readthrough:stale",
      sourceReceivedAt: new Date(),
      restMaterialObservationId: 424242,
      retentionPolicy: "default",
      retainUntil: new Date("2100-01-01T00:00:00Z"),
    });
    expect(stale.status).not.toBe("fenced");
    expect((await stateOf(page.id, MESSAGE)).dmIsOpened).toBe(true);

    // A replayed unlock is idempotent: nothing left to mark, still opened.
    const journalRow = await getOfapiWebhookEventById(appContext.db, unlockJournalId);
    expect(await projectOfapiDmEvent(appContext, journalRow!)).toMatchObject({ status: "skipped" });
    expect(await stateOf(page.id, MESSAGE)).toMatchObject({ dmIsOpened: true, maIsOpened: true });
  });

  it("an unlock that arrives BEFORE its message row reaches all three stores once the row exists", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const LATE = "2000010";
    const zero = { hotPurchasedMarked: 0, messageArchiveOpened: 0, dmArchiveOpened: 0 };
    const unlockedAt = new Date(Date.now() - 5 * 60_000);
    // The fan buys while the PPV's messages.sent is still missing (lost in an
    // outage). The unlock is ledgered, but there is nothing to annotate yet.
    const unlockJournalId = await deliverAndProcess(ppvUnlock("3000010", LATE, "$25.00", unlockedAt.toISOString()));
    expect((await getOfapiWebhookEventById(appContext.db, unlockJournalId))?.projectionStatus).toBe("skipped");
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({
      opened: 0, purchases: zero,
    });

    // Auto-redelivery brings messages.sent back later, with a higher seq:
    // every store's insert path writes the row as "not bought".
    await deliverAndProcess(await sentPpv(LATE));
    expect(await stateOf(page.id, LATE)).toEqual({ hotPurchasedAt: null, dmIsOpened: false, maIsOpened: null });

    // Outside the window the minutely pass leaves history alone (that is the
    // one-off backfill's job) …
    expect(await reconcileRecentPpvPurchases(appContext, {
      accountId: page.id, now: new Date(Date.now() + 9 * 24 * 60 * 60_000),
    })).toEqual(zero);
    // … inside it, the very next sweep heals all three stores.
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({
      inserted: 1,
      opened: 0,
      purchases: { hotPurchasedMarked: 1, messageArchiveOpened: 1, dmArchiveOpened: 1 },
    });
    expect(await stateOf(page.id, LATE)).toEqual({
      // Dated by the unlock itself, not by the heal.
      hotPurchasedAt: unlockedAt,
      dmIsOpened: true,
      maIsOpened: true,
    });
    await expectFingerprintConsistent(LATE);
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({ purchases: zero });

    // The shadow rebuild reproduces it — and a purchase known only from the
    // hot table — although its replay met the unlock before the row existed.
    const HOT_ONLY = "2000011";
    await deliverAndProcess(await sentPpv(HOT_ONLY));
    await runMessageArchiveProjection(appContext, { accountId: page.id });
    await testDb.pool.query(
      "update page_dm_messages set purchased_at = now() where platform_message_id = $1",
      [HOT_ONLY],
    );
    await runPpvPurchaseBackfill(appContext, { dryRun: false, accountId: page.id });
    expect((await stateOf(page.id, HOT_ONLY)).maIsOpened).toBe(true);
    const build = await buildMessageArchiveShadow(appContext, { accountId: page.id });
    expect(build.results[0]).toMatchObject({ purchasesOpened: 2 });
    const shadow = await testDb.pool.query(
      "select message_ref, is_opened from message_archive_shadow where account_id = $1 order by message_ref",
      [page.id],
    );
    expect(shadow.rows).toEqual([
      { message_ref: LATE, is_opened: true },
      { message_ref: HOT_ONLY, is_opened: true },
    ]);
  });

  it("a material head already awaiting correction stays flagged for the reconciler", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await seedPage();
    const MESSAGE = "2000006";
    await deliverAndProcess(await sentPpv(MESSAGE));
    // The ledger is behind this row for some other material change.
    await testDb.pool.query(
      "update dm_message_archive set emitted_fingerprint = '\\x00'::bytea where platform_message_id = $1",
      [MESSAGE],
    );
    const result = await applyDmMessagePurchaseFact(appContext.db, {
      platform: "onlyfans", ofapiAccountId: ACCOUNT, platformMessageId: MESSAGE,
    });
    expect(result.status).toBe("written");
    expect(result.row!.materialFingerprint?.equals(result.row!.emittedFingerprint!)).toBe(false);
    const signals = await listDmRepairSignalRows(appContext.db, {});
    // Still a repair signal: the reconciler's next superseding head carries
    // isOpened = true along with whatever else moved.
    expect(signals.map((signal) => signal.platformMessageId)).toContain(MESSAGE);
    expect(await applyDmMessagePurchaseFact(appContext.db, {
      platform: "onlyfans", ofapiAccountId: ACCOUNT, platformMessageId: MESSAGE,
    })).toMatchObject({ status: "noop" });
    expect(await applyDmMessagePurchaseFact(appContext.db, {
      platform: "onlyfans", ofapiAccountId: ACCOUNT, platformMessageId: "no-such-message",
    })).toEqual({ status: "missing" });
  });

  it("an unlock for a message no store holds is a harmless no-op (never a stub)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await deliverAndProcess(ppvUnlock("3000009", "2999999"));
    expect(await runMessageArchiveProjection(appContext, { accountId: page.id })).toMatchObject({ opened: 0 });
    const rows = await testDb.pool.query(
      `select (select count(*)::int from message_archive) as ma,
              (select count(*)::int from dm_message_archive) as dm`,
    );
    expect(rows.rows[0]).toEqual({ ma: 0, dm: 0 });
  });

  it("serves hot-only snapshot rows with price, media and purchase from the archive", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const MESSAGE = "2000002";
    await deliverAndProcess(await sentPpv(MESSAGE));
    await appendMaterialHead(page.id, MESSAGE, {
      isOpened: false,
      media: [
        { id: "m-video", type: "video", canView: false, isReady: true, duration: 12 },
        // isReady is boolean-or-null in a material head: missing is NOT false
        // (a false makes an auto-read desktop poll paid media reads).
        { id: "m-photo", type: "photo", canView: true, isReady: null, duration: 0 },
      ],
    }, "media");
    await runMessageArchiveProjection(appContext, { accountId: page.id });
    // A hot-only row: the dm_message_archive overlay (which wins wherever it
    // exists) is absent, so the hot serializer answers alone.
    await testDb.pool.query("delete from dm_message_archive where platform_message_id = $1", [MESSAGE]);

    const expectedMedia = [
      { id: "m-video", type: "video", isReady: true, locked: true, durationSeconds: 12 },
      { id: "m-photo", type: "photo", isReady: true, locked: false, durationSeconds: 0 },
    ];
    for (const read of [legacySnapshotMessage, boundedSnapshotMessage]) {
      const before = await read(page.id, MESSAGE);
      // Before H2: price 0, media [], isOpened null — a PPV that looked free.
      expect(before?.message).toMatchObject({ price: 25, isOpened: false, media: expectedMedia });
    }

    await deliverAndProcess(ppvUnlock("3000002", MESSAGE));
    for (const read of [legacySnapshotMessage, boundedSnapshotMessage]) {
      const after = await read(page.id, MESSAGE);
      expect(after?.message).toMatchObject({ price: 25, isOpened: true, media: expectedMedia });
    }

    // With no archive row at all the hot row keeps its old, honest shape.
    await testDb.pool.query("delete from message_archive where message_ref = $1", [MESSAGE]);
    await testDb.pool.query("update page_dm_messages set purchased_at = null where platform_message_id = $1", [MESSAGE]);
    const bare = await legacySnapshotMessage(page.id, MESSAGE);
    expect(bare?.message).toMatchObject({ price: 0, isOpened: null, media: [] });
  });

  it("backfills historical purchases: read-only dry run, apply, and a re-run that changes nothing", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // The pre-H2 world: the unlock settled with NO purchase projection and the
    // event-fed archive never applied it.
    const preH2 = createTestAppContext(testDb, { ofapiDmProjectionEnabled: false, ofapiDmColdArchiveEnabled: true });
    const A = "2000003"; // purchase known from the unlock event only
    const B = "2000004"; // purchase known from the hot row only
    const C = "2000005"; // never bought — the control
    for (const id of [A, B, C]) {
      await deliverAndProcess(await sentPpv(id));
    }
    await runMessageArchiveProjection(appContext, { accountId: page.id });
    await deliverAndProcess(ppvUnlock("3000003", A, "$13.99"), preH2);
    await testDb.pool.query(
      "update page_dm_messages set purchased_at = '2026-09-21T00:00:00Z' where platform_message_id = $1",
      [B],
    );
    const before = {
      A: await stateOf(page.id, A),
      B: await stateOf(page.id, B),
      C: await stateOf(page.id, C),
    };
    expect(before.A).toEqual({ hotPurchasedAt: null, dmIsOpened: false, maIsOpened: null });
    expect(before.B).toMatchObject({ dmIsOpened: false, maIsOpened: null });
    const snapshotTables = async () => (await testDb!.pool.query(`
      select
        (select json_agg(row_to_json(t) order by id) from (select id, purchased_at from page_dm_messages) t) as hot,
        (select json_agg(row_to_json(t) order by id) from (select id, is_opened, encode(material_fingerprint, 'hex') as mfp,
           encode(emitted_fingerprint, 'hex') as efp, updated_at from dm_message_archive) t) as dm,
        (select json_agg(row_to_json(t) order by id) from (select id, is_opened, updated_at from message_archive) t) as ma
    `)).rows[0];
    const tablesBefore = await snapshotTables();

    // Dry run is the default and writes nothing.
    const dry = await runPpvPurchaseBackfill(appContext);
    expect(dry).toEqual({
      dryRun: true, facts: 2, hotPurchasedMarked: 1, messageArchiveOpened: 2, dmArchiveOpened: 2,
    });
    expect(await snapshotTables()).toEqual(tablesBefore);

    const applied = await runPpvPurchaseBackfill(appContext, { dryRun: false });
    expect(applied).toEqual({
      dryRun: false, facts: 2, hotPurchasedMarked: 1, messageArchiveOpened: 2, dmArchiveOpened: 2,
    });
    const after = {
      A: await stateOf(page.id, A),
      B: await stateOf(page.id, B),
      C: await stateOf(page.id, C),
    };
    // A's hot purchase is dated by the unlock itself.
    expect(after.A).toEqual({
      hotPurchasedAt: new Date("2026-09-20T12:00:00Z"), dmIsOpened: true, maIsOpened: true,
    });
    expect(after.B).toMatchObject({ dmIsOpened: true, maIsOpened: true });
    expect(after.C).toEqual(before.C);
    await expectFingerprintConsistent(A);
    await expectFingerprintConsistent(B);

    // Idempotent: a re-run (and a dry run after it) finds nothing to do.
    const zero = { facts: 2, hotPurchasedMarked: 0, messageArchiveOpened: 0, dmArchiveOpened: 0 };
    expect(await runPpvPurchaseBackfill(appContext, { dryRun: false })).toEqual({ dryRun: false, ...zero });
    expect(await runPpvPurchaseBackfill(appContext)).toEqual({ dryRun: true, ...zero });
    // Account scope: another page has no facts.
    expect(await runPpvPurchaseBackfill(appContext, { accountId: page.id + 1000 })).toEqual({
      dryRun: true, facts: 0, hotPurchasedMarked: 0, messageArchiveOpened: 0, dmArchiveOpened: 0,
    });
  });
});
