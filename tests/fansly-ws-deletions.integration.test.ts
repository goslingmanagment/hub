import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createFanslyPage,
  getPageConversationMessages,
  listAgentTranscript,
  listArchiveConversationMessagesForAi,
  observeFanslyDmHead,
  resolveCapturedFanslyDmHeads,
  routeFanslyWsHintEvent,
  searchAgentArchive,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  RECENT_WS_DELETION_WINDOW_MS,
  runFanslyWsDeletionBackfill,
} from "../apps/runtime/src/services/fansly-ws-deletions.ts";
import { runFanslyWsHintProjection } from "../apps/runtime/src/services/projections/fansly-ws-hints.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { buildMessageArchiveShadow } from "../apps/runtime/src/services/projections/message-archive-rebuild.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// D-6 / DMWS-01 / F32: a deletion the Fansly account socket reports marks the
// stored copies deleted (hot + archive), keeps their text, and never invents a
// row for a message Hub did not capture.

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

const GENERATION = "a".repeat(64);
const GROUP = "100";
const FAN = "111";
let receiptId = 900;

async function seedThread(app: ReturnType<typeof createTestAppContext>, pageId: number, base: Date) {
  const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }]);
  // The Fansly conversation-list writer upserts the whole row, stored window
  // included, from a snapshot it read before its transaction. Re-running this
  // is such a write from a snapshot taken before any deletion mark.
  const listWrite = () => upsertPageDmConversation(app.db, {
    platformAccountId: pageId, fanId: fan!.id, platformConversationId: GROUP,
    partnerPlatformUserId: FAN, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: "150", lastUnreadMessageId: null, lastMessageAt: new Date(base.getTime() + 60_000),
    lastMessageSenderId: FAN, lastMessageSenderRole: "fan", lastMessagePreview: "second",
    messageCoverageStatus: "complete", newestStoredMessageId: "150", oldestStoredMessageId: "149",
    storedMessageCount: 2, lastMessageSyncAt: new Date(base.getTime() + 120_000), isVisible: true,
    lastSeenGeneration: 1, metadata: {},
  });
  const thread = await listWrite();
  if (!thread) throw new Error("thread missing");
  const message = (id: string, offsetMs: number, content: string, tip = 0) => ({
    conversationId: thread.id, platformAccountId: pageId, platformMessageId: id,
    senderPlatformUserId: FAN, senderRole: "fan" as const, createdAt: new Date(base.getTime() + offsetMs),
    content, totalTipAmountCents: tip, inReplyToMessageId: id === "150" ? "149" : null, inReplyToRootMessageId: null,
  });
  await upsertPageDmMessages(app.db, [message("149", 0, "first"), message("150", 60_000, "second", 500)]);
  return { thread, message, listWrite };
}

function messageEvent(ref: string, occurredAt: Date, text: string) {
  return {
    type: "message.received", occurredAt, fanIdentityRef: FAN, conversationRef: GROUP, messageRef: ref,
    transactionRef: null, data: { text, tipAmountMills: 0, isTip: false }, schemaVersion: 1,
    observationId: 1, dedupKey: `msg:received:${ref}`,
  };
}

async function fixture() {
  const app = createTestAppContext(db);
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("page missing");
  const base = new Date(Date.now() - 3_600_000);
  const { thread, message, listWrite } = await seedThread(app, page.id, base);
  await appendDomainEvents(app.db, page.id, [
    messageEvent("149", base, "first"),
    messageEvent("150", new Date(base.getTime() + 60_000), "second"),
  ]);
  await runMessageArchiveProjection(app, { accountId: page.id });
  const deletion = async (input: {
    messageRef: string; pageId?: number; groupRef?: string | null; generation?: string | null; receivedAt?: Date;
    /** When the hint projector filed the receipt (created_at); default now. */
    filedAt?: Date;
  }) => {
    const id = ++receiptId;
    await routeFanslyWsHintEvent(db.db, {
      id, pageId: input.pageId ?? page.id, observationId: id,
      receivedAt: input.receivedAt ?? new Date(), generation: input.generation === undefined ? GENERATION : input.generation,
      node: { path: [], outcome: "mutation_debt", mutation: {
        messageRef: input.messageRef, groupRef: input.groupRef === undefined ? GROUP : input.groupRef,
        correlationRef: "77", bulk: false,
      } },
    }, null);
    if (input.filedAt) {
      await db.pool.query("update fansly_ws_hint_receipts set created_at = $2 where event_id = $1", [id, input.filedAt]);
    }
  };
  return { app, page, base, thread, message, listWrite, deletion };
}

async function hot(ref: string) {
  return (await db.pool.query(
    "select deleted_at, content, total_tip_amount_cents, in_reply_to_message_id from page_dm_messages where platform_message_id = $1",
    [ref],
  )).rows[0];
}
async function archive(ref: string, table = "message_archive") {
  return (await db.pool.query(`select deleted_at, text_plain, conversation_ref from ${table} where message_ref = $1`, [ref])).rows[0];
}
async function threadRow(id: number) {
  return (await db.pool.query(
    `select stored_message_count, newest_stored_message_id, oldest_stored_message_id,
       last_message_id, last_message_preview from page_dm_threads where id = $1`,
    [id],
  )).rows[0];
}

describe("Fansly WS deletions mark stored messages (D-6)", () => {
  it("carries a journaled delete frame to both stores, keeping text, and every reader marks or skips it", async () => {
    const f = await fixture();
    const receivedAt = new Date(Date.now() - 60_000);
    const connectionId = randomUUID();
    await beginFanslyWsConnection(db.db, { id: connectionId, pageId: f.page.id, generation: GENERATION });
    await captureFanslyWsFrame(db.db, {
      connectionId, pageId: f.page.id, generation: GENERATION, accountRef: "999", ordinal: 1, receivedAt,
      frame: JSON.stringify({ t: 10000, d: { serviceId: 5, event: { type: 10, message: {
        id: "150", groupId: GROUP, correlationId: "77", type: 1,
      } } } }),
      validate: async () => {},
    });
    expect(await runCanonicalization(f.app, { accountId: f.page.id, kinds: [FANSLY_WS_CAPTURE_KIND] }))
      .toMatchObject({ errored: 0, stamped: 1 });
    await runFanslyWsHintProjection(f.app, { accountId: f.page.id });

    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 1, archiveMarked: 1 } });
    expect(await hot("150")).toEqual({
      deleted_at: receivedAt, content: "second", total_tip_amount_cents: 500, in_reply_to_message_id: "149",
    });
    expect(await archive("150")).toEqual({ deleted_at: receivedAt, text_plain: "second", conversation_ref: GROUP });
    expect((await hot("149")).deleted_at).toBeNull();
    expect((await archive("149")).deleted_at).toBeNull();
    // The stored window follows the live rows; the head stays with the
    // Fansly conversation list, its only writer.
    expect(await threadRow(f.thread.id)).toEqual({
      stored_message_count: 1, newest_stored_message_id: "149", oldest_stored_message_id: "149",
      last_message_id: "150", last_message_preview: "second",
    });

    // Conversation view and AI context already skip deleted rows.
    const conversation = await getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP,
    });
    expect(conversation?.messages.map((row) => row.messageId)).toEqual(["149"]);
    expect((await listArchiveConversationMessagesForAi(f.app.db, { accountId: f.page.id, conversationRef: GROUP }))
      .map((row) => row.messageRef)).toEqual(["149"]);
    // The agent transcript returns it, marked, with its text.
    const transcript = await listAgentTranscript(f.app.db, {
      pageId: f.page.id, platform: "fansly", conversationRef: GROUP,
      from: new Date(f.base.getTime() - 60_000), to: new Date(), sortDir: "asc", limit: 10, filters: {},
    });
    expect(transcript.rows.map((row) => [row.messageRef, row.textPlain, row.deletedAt])).toEqual([
      ["149", "first", null],
      ["150", "second", receivedAt],
    ]);
    // Search still finds the kept text, and the hit carries the mark.
    const search = (query: string) => searchAgentArchive(f.app.db, {
      pageIds: [f.page.id], query, from: new Date(f.base.getTime() - 60_000), to: new Date(),
      includeSnippet: true, limit: 10,
    });
    expect((await search("second")).rows.map((row) => [row.messageRef, row.snippet, row.deletedAt]))
      .toEqual([["150", "second", receivedAt]]);
    expect((await search("first")).rows.map((row) => [row.messageRef, row.deletedAt])).toEqual([["149", null]]);

    // Idempotent: the next sweep finds nothing new.
    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 0, archiveMarked: 0, windowsRepaired: 0 } });
  });

  it("the minutely reconcile applies only receipts filed in the last hour, dated by the earliest receipt", async () => {
    const f = await fixture();
    await upsertPageDmMessages(f.app.db, [f.message("151", 90_000, "third")]);
    await appendDomainEvents(f.app.db, f.page.id, [messageEvent("151", new Date(f.base.getTime() + 90_000), "third")]);
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });
    expect(RECENT_WS_DELETION_WINDOW_MS).toBe(3_600_000);
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    // Filed two hours ago (e.g. before this code went live): left to the
    // owner-run backfill, although its frame is recent.
    await f.deletion({ messageRef: "149", receivedAt: minutesAgo(121), filedAt: minutesAgo(120) });
    // A projector backlog files an old frame now: the reconcile applies it.
    const oldFrame = minutesAgo(3 * 24 * 60);
    await f.deletion({ messageRef: "150", receivedAt: oldFrame });
    // The same deletion filed twice: the recent receipt selects it, the
    // earliest receipt dates it.
    const firstFrame = minutesAgo(91);
    await f.deletion({ messageRef: "151", receivedAt: firstFrame, filedAt: minutesAgo(90) });
    await f.deletion({ messageRef: "151", receivedAt: minutesAgo(1) });

    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 2, archiveMarked: 2 } });
    expect((await hot("149")).deleted_at).toBeNull();
    expect((await archive("149")).deleted_at).toBeNull();
    expect((await hot("150")).deleted_at).toEqual(oldFrame);
    expect((await archive("150")).deleted_at).toEqual(oldFrame);
    expect((await hot("151")).deleted_at).toEqual(firstFrame);
    expect((await archive("151")).deleted_at).toEqual(firstFrame);
  });

  it("re-derives a thread window that a conversation-list write reverted after the mark", async () => {
    const f = await fixture();
    await f.deletion({ messageRef: "150", receivedAt: new Date(Date.now() - 30_000) });
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });
    expect(await threadRow(f.thread.id)).toMatchObject({ stored_message_count: 1, newest_stored_message_id: "149" });

    // A list chunk that read the thread before the mark writes its snapshot.
    await f.listWrite();
    expect(await threadRow(f.thread.id)).toMatchObject({ stored_message_count: 2, newest_stored_message_id: "150" });

    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 0, archiveMarked: 0, windowsRepaired: 1 } });
    expect(await threadRow(f.thread.id)).toMatchObject({
      stored_message_count: 1, newest_stored_message_id: "149", oldest_stored_message_id: "149",
    });
    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { windowsRepaired: 0 } });
  });

  it("a marked head the conversation list keeps advertising opens no head debt", async () => {
    const f = await fixture();
    // Debt recorded while the head was not yet captured is resolved by the
    // marked row, and the list naming the deleted head records none.
    await db.pool.query("insert into fansly_dm_head_debt (conversation_id, message_id) values ($1, '150')", [f.thread.id]);
    await f.deletion({ messageRef: "150", receivedAt: new Date(Date.now() - 30_000) });
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });
    expect((await hot("150")).deleted_at).not.toBeNull();

    await resolveCapturedFanslyDmHeads(f.app.db, f.thread.id);
    expect((await db.pool.query("select message_id, captured_at is not null as captured from fansly_dm_head_debt"))
      .rows).toEqual([{ message_id: "150", captured: true }]);

    await db.pool.query("delete from fansly_dm_head_debt");
    await observeFanslyDmHead(f.app.db, {
      conversationId: f.thread.id, messageId: "150", messageAt: new Date(f.base.getTime() + 60_000),
    });
    expect((await db.pool.query("select message_id, captured_at from fansly_dm_head_debt")).rows).toEqual([]);
  });

  it("marks an archive row that appears after its deletion receipt", async () => {
    const f = await fixture();
    await upsertPageDmMessages(f.app.db, [f.message("151", 90_000, "late")]);
    const receivedAt = new Date(Date.now() - 30_000);
    await f.deletion({ messageRef: "151", receivedAt });
    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 1, archiveMarked: 0 } });
    expect(await archive("151")).toBeUndefined();

    // The capture taken before the deletion is canonicalized late.
    await appendDomainEvents(f.app.db, f.page.id, [messageEvent("151", new Date(f.base.getTime() + 90_000), "late")]);
    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ inserted: 1, wsDeletions: { hotMarked: 0, archiveMarked: 1 } });
    expect(await archive("151")).toEqual({ deleted_at: receivedAt, text_plain: "late", conversation_ref: GROUP });
  });

  it("acts only on exact evidence and never creates a row for an uncaptured message", async () => {
    const f = await fixture();
    await f.deletion({ messageRef: "150", groupRef: "200" });
    await f.deletion({ messageRef: "150", groupRef: null });
    await f.deletion({ messageRef: "150", generation: null });
    await f.deletion({ messageRef: "999" });
    const before = (await db.pool.query(
      "select (select count(*)::int from page_dm_messages) as hot, (select count(*)::int from message_archive) as archive",
    )).rows[0];

    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 0, archiveMarked: 0 } });
    expect((await hot("150")).deleted_at).toBeNull();
    expect((await archive("150")).deleted_at).toBeNull();
    expect(await hot("999")).toBeUndefined();
    expect(await archive("999")).toBeUndefined();
    expect((await db.pool.query(
      "select (select count(*)::int from page_dm_messages) as hot, (select count(*)::int from message_archive) as archive",
    )).rows[0]).toEqual(before);
  });

  it("keeps the mark and the captured text when REST reads the message again", async () => {
    const f = await fixture();
    const receivedAt = new Date(Date.now() - 30_000);
    await f.deletion({ messageRef: "150", receivedAt });
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });
    await upsertPageDmMessages(f.app.db, [f.message("150", 60_000, "rewritten")]);
    expect(await hot("150")).toMatchObject({ deleted_at: receivedAt, content: "second" });
  });

  it("history backfill: read-only dry run, then marks receipts filed before the minutely window, once", async () => {
    const f = await fixture();
    const other = await createFanslyPage(f.app.db, { modelId: f.page.modelId, label: "lora-other" });
    if (!other) throw new Error("second page missing");
    const receivedAt = new Date(Date.now() - 3 * 86_400_000);
    // Filed before this code went live: three hours ago, past the hour.
    const filedAt = new Date(Date.now() - 3 * 3_600_000);
    await f.deletion({ messageRef: "150", receivedAt, filedAt });
    await f.deletion({ messageRef: "999", receivedAt, filedAt });
    await f.deletion({ messageRef: "888", pageId: other.id, receivedAt, filedAt });

    // The minutely reconcile does not reach back this far.
    expect(await runMessageArchiveProjection(f.app, { accountId: f.page.id }))
      .toMatchObject({ wsDeletions: { hotMarked: 0, archiveMarked: 0 } });

    const dryRun = await runFanslyWsDeletionBackfill(f.app);
    expect(dryRun).toMatchObject({ dryRun: true, deletions: 3, hotMarked: 1, archiveMarked: 1, windowsRepaired: 0 });
    expect(dryRun.pages).toEqual([
      { pageId: f.page.id, pageLabel: f.page.label, deletions: 2, hot: 1, archive: 1 },
      { pageId: other.id, pageLabel: "lora-other", deletions: 1, hot: 0, archive: 0 },
    ]);
    expect((await hot("150")).deleted_at).toBeNull();
    expect((await archive("150")).deleted_at).toBeNull();

    const scoped = await runFanslyWsDeletionBackfill(f.app, { dryRun: false, accountId: other.id });
    expect(scoped).toMatchObject({ dryRun: false, deletions: 1, hotMarked: 0, archiveMarked: 0 });
    expect((await hot("150")).deleted_at).toBeNull();

    expect(await runFanslyWsDeletionBackfill(f.app, { dryRun: false }))
      .toMatchObject({ dryRun: false, deletions: 3, hotMarked: 1, archiveMarked: 1 });
    expect(await hot("150")).toMatchObject({ deleted_at: receivedAt, content: "second" });
    expect(await archive("150")).toMatchObject({ deleted_at: receivedAt, text_plain: "second" });
    expect((await threadRow(f.thread.id)).stored_message_count).toBe(1);

    expect(await runFanslyWsDeletionBackfill(f.app, { dryRun: false }))
      .toMatchObject({ deletions: 3, hotMarked: 0, archiveMarked: 0, windowsRepaired: 0 });
    expect(await runFanslyWsDeletionBackfill(f.app)).toMatchObject({ hotMarked: 0, archiveMarked: 0 });

    // A window a list write reverted long ago: the dry run counts it without
    // writing, a re-run repairs it.
    await f.listWrite();
    expect(await runFanslyWsDeletionBackfill(f.app)).toMatchObject({ dryRun: true, windowsRepaired: 1 });
    expect((await threadRow(f.thread.id)).stored_message_count).toBe(2);
    expect(await runFanslyWsDeletionBackfill(f.app, { dryRun: false }))
      .toMatchObject({ hotMarked: 0, archiveMarked: 0, windowsRepaired: 1 });
    expect((await threadRow(f.thread.id)).stored_message_count).toBe(1);
  });

  it("the archive shadow rebuild re-applies the marks the event replay cannot derive", async () => {
    const f = await fixture();
    const receivedAt = new Date(Date.now() - 30_000);
    await f.deletion({ messageRef: "150", receivedAt });
    await runMessageArchiveProjection(f.app, { accountId: f.page.id });

    const build = await buildMessageArchiveShadow(f.app, { accountId: f.page.id });
    expect(build.results[0]).toMatchObject({ wsDeletionsMarked: 1 });
    expect(await archive("150", "message_archive_shadow"))
      .toEqual({ deleted_at: receivedAt, text_plain: "second", conversation_ref: GROUP });
    expect((await archive("149", "message_archive_shadow")).deleted_at).toBeNull();
  });
});
