import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFanslyWsOwnership,
  appendMixedDomainEvents,
  applyFanslyWsLiveReceipt,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listArchiveConversationMessagesForAi,
  markObservationParsed,
  readDmLiveUnion,
  upsertFans,
  upsertPageDmConversation,
  type ArchiveMessageRow,
  type FanslyMessageMarkers,
} from "@agency_hub_core/db";

import { runCanonicalization, resetCanonicalizeSweepRuntime } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { appendOfapiMessageMaterialPage } from "../apps/runtime/src/services/ofapi-message-material.ts";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { rebuildMessageArchiveProjection, runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// R20 HF-7d0 (chat-extension Project Unite): Fansly's automation markers — the
// vendor's `type` and `correlationId`, each with whether the message carried
// it — reach both stores a transcript reads, through their real writers:
//
//   REST dm_messages observation → sync-pull material head → archive
//   projection → message_archive → listArchiveConversationMessagesForAi
//   socket frame → live decoder → dm_live_messages → readDmLiveUnion
//
// Data only: nothing labels a message from them yet (HF-7d does).

const PAGE_REF = "700000000000000009";
const FAN = "700000000000000001";
const GROUP = "800000000000000001";
const MASS = "900000000000000001";
const AUTO_NOTE = "900000000000000002";
const REPLY = "900000000000000003";
const PERSONAL = "900000000000000004";
const FAN_MESSAGE = "900000000000000005";
const SHARED = "900000000000000006";
const SOCKET_MASS = "900000000000000007";
const SOCKET_BARE = "900000000000000008";
const CORRELATION = "500000000000000001";

const UNKNOWN: FanslyMessageMarkers = { type: null, typeObserved: false, correlationId: null, correlationIdObserved: false };
const known = (type: number | null, correlationId: string | null): FanslyMessageMarkers =>
  ({ type, typeObserved: true, correlationId, correlationIdObserved: true });

let testDb: StartedTestDatabase;
const owners: NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>[] = [];
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
});
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); });

const base = new Date(Date.now() - 60 * 60_000);
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);

/** A REST message as Fansly's DM page serves it (every key it carries live). */
function rest(id: string, seconds: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, groupId: GROUP, senderId: PAGE_REF, content: `<p>rest ${id}</p>`, createdAt: at(seconds).getTime() / 1000,
    attachments: [], inReplyTo: null, inReplyToRoot: null, type: 1, correlationId: "0", totalTipAmount: 0,
    ...fields,
  };
}

/** A socket `message created` payload. */
function socket(id: string, seconds: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, groupId: GROUP, senderId: PAGE_REF, content: `socket ${id}`, createdAt: at(seconds).getTime() / 1000,
    attachments: [], inReplyTo: null, type: 1, correlationId: "0", ...fields,
  };
}

const without = (message: Record<string, unknown>, ...keys: string[]) => {
  const copy = { ...message };
  for (const key of keys) delete copy[key];
  return copy;
};

async function fixture() {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("seed failed");
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page.id, PAGE_REF]);
  const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }]);
  await upsertPageDmConversation(app.db, {
    platformAccountId: page.id, fanId: fan!.id, platformConversationId: GROUP,
    partnerPlatformUserId: FAN, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: null, lastUnreadMessageId: null, lastMessageAt: at(0),
    lastMessageSenderId: FAN, lastMessageSenderRole: "fan", lastMessagePreview: null,
    messageCoverageStatus: "complete", newestStoredMessageId: null, oldestStoredMessageId: null,
    storedMessageCount: 0, lastMessageSyncAt: at(0), isVisible: true, lastSeenGeneration: 1, metadata: {},
  });

  let observations = 0;
  /** One REST DM page through the real canonicalizer and archive projection. */
  const restPage = async (messages: Record<string, unknown>[], receivedAt = new Date()) => {
    const payload = { messages };
    await insertObservation(app.db, {
      source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
      accountId: page.id, kind: "dm_messages", payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `markers-${++observations}`, receivedAt,
    });
    await runCanonicalization(app, { kinds: ["dm_messages"], accountId: page.id });
    await runMessageArchiveProjection(app, { accountId: page.id });
  };

  const generation = await readProbeGeneration(app.db, page.label);
  const owner = await acquireFanslyWsOwnership(testDb.connectionString, page.id, () => {});
  if (!owner) throw new Error("owner unavailable");
  owners.push(owner);
  const connectionId = randomUUID();
  let ordinal = 0;
  await beginFanslyWsConnection(owner.db, { id: connectionId, pageId: page.id, generation });
  /** Socket frames through the real capture, live decoder and overlay apply. */
  const socketFrames = async (...messages: Record<string, unknown>[]) => {
    const frame = wrapped(10001, messages.map((message) => serviceFrame({ type: 1, message })));
    const observationId = await captureFanslyWsFrame(owner.db, {
      connectionId, pageId: page.id, generation, accountRef: PAGE_REF, ordinal: ++ordinal, frame,
      receivedAt: new Date(),
      validate: async (tx) => {
        if (await readFanslyPageGeneration(tx, page.label) !== generation) throw new Error("generation_fenced");
      },
    });
    expect(await applyFanslyWsLiveReceipt(app.db, { observationId }))
      .toMatchObject({ status: "applied", created: messages.length });
  };

  const archive = async () => listArchiveConversationMessagesForAi(app.db, { accountId: page.id, conversationRef: GROUP });
  const union = async () => readDmLiveUnion(app.db, {
    pageId: page.id, platformConversationId: GROUP, store: "message_archive", limit: 100,
    readStore: (notTombstoned) => listArchiveConversationMessagesForAi(app.db, {
      accountId: page.id, conversationRef: GROUP, notTombstoned,
    }),
    storeKey: (row) => ({ messageId: row.messageRef, at: row.occurredAt }),
  });
  return { app, page, restPage, socketFrames, archive, union };
}

const byRef = (rows: ArchiveMessageRow[]) => new Map(rows.map((row) => [row.messageRef, row]));

describe("Fansly automation markers reach the archive and the live union (R20 HF-7d0)", () => {
  it("archive-only: a REST page's markers land through the real canonicalizer, survive a sparse re-read and a rebuild", async () => {
    const f = await fixture();
    await f.restPage([
      rest(MASS, 0, { type: 2, correlationId: CORRELATION }),
      rest(AUTO_NOTE, 10, { correlationId: "500000000000000002" }),
      rest(REPLY, 20, { correlationId: "500000000000000003", inReplyTo: FAN_MESSAGE }),
      rest(PERSONAL, 30),
      rest(FAN_MESSAGE, 5, { senderId: FAN }),
    ]);
    const expected = new Map<string, Partial<ArchiveMessageRow>>([
      [MASS, { senderRole: "model", inReplyToRef: null, markers: known(2, CORRELATION) }],
      [AUTO_NOTE, { senderRole: "model", inReplyToRef: null, markers: known(1, "500000000000000002") }],
      [REPLY, { senderRole: "model", inReplyToRef: FAN_MESSAGE, markers: known(1, "500000000000000003") }],
      [PERSONAL, { senderRole: "model", inReplyToRef: null, markers: known(1, "0") }],
      [FAN_MESSAGE, { senderRole: "fan", inReplyToRef: null, markers: known(1, "0") }],
    ]);
    const check = async () => {
      const rows = byRef(await f.archive());
      expect(rows.size).toBe(expected.size);
      for (const [ref, fields] of expected) expect(rows.get(ref), ref).toMatchObject(fields);
    };
    await check();
    // The stored form: the two values and the overlay's presence bits.
    expect((await testDb.pool.query(`select message_type, correlation_id, marker_field_mask from message_archive
      where account_id = $1 and message_ref = $2`, [f.page.id, MASS])).rows)
      .toEqual([{ message_type: 2, correlation_id: CORRELATION, marker_field_mask: 48 }]);

    // A later read of the mass message without the two keys updates its text
    // and leaves its markers known; an explicit change is taken.
    await f.restPage([
      without(rest(MASS, 0, { content: "<p>edited</p>" }), "type", "correlationId"),
      rest(PERSONAL, 30, { correlationId: null }),
    ], new Date(Date.now() + 1000));
    expect(byRef(await f.archive()).get(MASS)).toMatchObject({ textPlain: "edited", markers: known(2, CORRELATION) });
    expected.set(MASS, { ...expected.get(MASS), textPlain: "edited" });
    expected.set(PERSONAL, { ...expected.get(PERSONAL), markers: known(1, null) });
    await check();

    // The archive is a projection: a rebuild from the ledger gives the same.
    await rebuildMessageArchiveProjection(f.app, { accountId: f.page.id });
    await check();
  });

  it("archive-only: rows projected before the markers stay unknown until their message is observed again", async () => {
    const f = await fixture();
    // A v6 head from before HF-7d0, as the ledger holds it: no marker fields.
    const observation = await insertObservation(f.app.db, {
      source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
      accountId: f.page.id, kind: "dm_messages", payload: { messages: [] },
      payloadHash: createHash("sha256").update("old").digest(), idempotencyKey: "pre-markers",
      receivedAt: at(60),
    });
    await appendMixedDomainEvents(f.app.db, f.page.id, [{
      type: "message.material_observed", occurredAt: at(0), conversationRef: GROUP,
      fanIdentityRef: null, messageRef: MASS, transactionRef: null, observationId: observation.observationId,
      schemaVersion: 1, dedupKey: "pre-markers-head", data: { head: {
        nativeMessageId: MASS, textHtml: "old mass", isSentByMe: true, senderPlatformUserId: PAGE_REF,
        fanPlatformUserId: null, messageCreatedAt: at(0).toISOString(), priceMills: null, isOpened: null,
        isNew: null, isTip: false, tipAmountMills: "0", tipTextPlain: null, reply: null, replyContractVersion: 1,
        media: [], fieldPresence: { media: true, reply: true, tipText: false },
        vendorChangedAt: null, materialObservedAt: at(60).toISOString(), originClass: "fansly_dm_sidecar",
      } },
    }], { observationId: observation.observationId, occurredAt: at(60), dedupKey: "pre-markers-checkpoint" });
    await markObservationParsed(f.app.db, { ...observation, parseVersion: 6 });
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });
    expect((await f.archive())[0]).toMatchObject({ messageRef: MASS, textPlain: "old mass", markers: UNKNOWN });
    expect((await testDb.pool.query(`select message_type, correlation_id, marker_field_mask from message_archive
      where account_id = $1`, [f.page.id])).rows).toEqual([{ message_type: null, correlation_id: null, marker_field_mask: null }]);

    // Observed again after the deploy: the markers arrive with the next head.
    await f.restPage([rest(MASS, 0, { type: 2, correlationId: CORRELATION })]);
    expect((await f.archive())[0]).toMatchObject({ messageRef: MASS, markers: known(2, CORRELATION) });
  });

  it("archive-only: OnlyFans material leaves the markers unknown", async () => {
    const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
    const model = await createModel(app.db, { slug: "of-markers", name: "OF" });
    const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "of-markers" });
    await appendOfapiMessageMaterialPage(app.db, {
      accountId: page!.id, observationId: 1, observationReceivedAt: at(60), chatId: FAN,
      originClass: "capture_background",
      items: [{ id: "9001", isSentByMe: true, text: "of", fromUser: { id: "1" }, createdAt: at(0).toISOString() }],
    });
    await runMessageArchiveProjection(app, { accountId: page!.id });
    const rows = await listArchiveConversationMessagesForAi(app.db, { accountId: page!.id, conversationRef: FAN });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "onlyfans", textPlain: "of", markers: UNKNOWN });
    expect((await testDb.pool.query("select marker_field_mask from message_archive where account_id = $1", [page!.id])).rows)
      .toEqual([{ marker_field_mask: null }]);
  });

  it("live-only: socket messages carry their markers into the union; a frame without the keys reads unknown", async () => {
    const f = await fixture();
    await f.socketFrames(
      socket(SOCKET_MASS, 100, { type: 2, correlationId: CORRELATION }),
      without(socket(SOCKET_BARE, 110, { senderId: FAN }), "type", "correlationId"),
    );
    expect(await f.archive()).toEqual([]);
    const items = await f.union();
    expect(items.map((item) => item.source === "live"
      ? { id: item.message.platformMessageId, role: item.message.senderRole, markers: item.message.markers }
      : null)).toEqual([
      { id: SOCKET_BARE, role: "fan", markers: UNKNOWN },
      { id: SOCKET_MASS, role: "model", markers: known(2, CORRELATION) },
    ]);
  });

  it("mixed: one chat serves archive rows and socket-only rows, each with its own store's markers; a message in both comes once, from REST", async () => {
    const f = await fixture();
    await f.restPage([
      rest(MASS, 0, { type: 2, correlationId: CORRELATION }),
      rest(PERSONAL, 30),
      rest(SHARED, 40, { type: 2, correlationId: "500000000000000006" }),
    ]);
    // The socket saw the shared message without its markers, and one more the
    // archive does not hold yet.
    await f.socketFrames(
      without(socket(SHARED, 40), "type", "correlationId"),
      socket(SOCKET_MASS, 100, { type: 2, correlationId: CORRELATION }),
    );
    const items = await f.union();
    expect(items.map((item) => item.source === "rest"
      ? { source: "rest", id: item.row.messageRef, markers: item.row.markers }
      : { source: "live", id: item.message.platformMessageId, markers: item.message.markers })).toEqual([
      { source: "live", id: SOCKET_MASS, markers: known(2, CORRELATION) },
      { source: "rest", id: SHARED, markers: known(2, "500000000000000006") },
      { source: "rest", id: PERSONAL, markers: known(1, "0") },
      { source: "rest", id: MASS, markers: known(2, CORRELATION) },
    ]);
  });
});
