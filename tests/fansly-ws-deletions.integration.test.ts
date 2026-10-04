import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  getPageConversationMessages,
  listAgentTranscript,
  listArchiveConversationMessagesForAi,
  markFanslyWsArchiveDeletions,
  markFanslyWsHotDeletion,
  searchAgentArchive,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { buildMessageArchiveShadow } from "../apps/runtime/src/services/projections/message-archive-rebuild.ts";
import { runProjectionTick } from "../apps/runtime/src/services/projections/registry.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { fileFanslyWsHintReceipt } from "./helpers/fansly-ws-hint-receipts.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// D-6 / DMWS-01 / F32: a deletion the Fansly account socket reports marks the
// stored copies deleted (hot + archive), keeps their text, and never invents a
// row for a message Hub did not capture. Since step 4 (S4-11) the engine's
// `dm-live.deletions` writes the marks (tests/sync-dm-live-deletions.
// integration.test.ts); the ws-hints projector and its minutely receipt
// reconcile are gone. What stays, and is pinned here: a captured frame alone
// marks nothing, readers treat a mark the same whoever wrote it, a mark is
// sticky, and the archive shadow rebuild re-applies the marks of the receipts
// the projector filed before (no event carries them).

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
  const thread = await upsertPageDmConversation(app.db, {
    platformAccountId: pageId, fanId: fan!.id, platformConversationId: GROUP,
    partnerPlatformUserId: FAN, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: "150", lastUnreadMessageId: null, lastMessageAt: new Date(base.getTime() + 60_000),
    lastMessageSenderId: FAN, lastMessageSenderRole: "fan", lastMessagePreview: "second",
    messageCoverageStatus: "complete", newestStoredMessageId: "150", oldestStoredMessageId: "149",
    storedMessageCount: 2, lastMessageSyncAt: new Date(base.getTime() + 120_000), isVisible: true,
    lastSeenGeneration: 1, metadata: {},
  });
  if (!thread) throw new Error("thread missing");
  const message = (id: string, offsetMs: number, content: string, tip = 0) => ({
    conversationId: thread.id, platformAccountId: pageId, platformMessageId: id,
    senderPlatformUserId: FAN, senderRole: "fan" as const, createdAt: new Date(base.getTime() + offsetMs),
    content, totalTipAmountCents: tip, inReplyToMessageId: id === "150" ? "149" : null, inReplyToRootMessageId: null,
  });
  await upsertPageDmMessages(app.db, [message("149", 0, "first"), message("150", 60_000, "second", 500)]);
  return { thread, message };
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
  const { thread, message } = await seedThread(app, page.id, base);
  await appendDomainEvents(app.db, page.id, [
    messageEvent("149", base, "first"),
    messageEvent("150", new Date(base.getTime() + 60_000), "second"),
  ]);
  await runMessageArchiveProjection(app, { accountId: page.id });
  /** An exact deletion receipt as the retired projector filed it. */
  const receipt = async (input: {
    messageRef: string; groupRef?: string | null; generation?: string | null; receivedAt?: Date;
  }) => {
    const id = ++receiptId;
    await fileFanslyWsHintReceipt(db.pool, {
      id, pageId: page.id, observationId: id,
      receivedAt: input.receivedAt ?? new Date(), generation: input.generation === undefined ? GENERATION : input.generation,
      node: { path: [], outcome: "mutation_debt", mutation: {
        messageRef: input.messageRef, groupRef: input.groupRef === undefined ? GROUP : input.groupRef,
        correlationRef: "77", bulk: false,
      } },
    }, null);
  };
  /** Mark message `ref` deleted in the hot table and the archive. */
  const mark = async (ref: string, deletedAt: Date) => {
    const row = (await db.pool.query<{ id: string }>(
      "select id::text from page_dm_messages where platform_account_id = $1 and platform_message_id = $2",
      [page.id, ref],
    )).rows[0]!;
    expect(await markFanslyWsHotDeletion(app.db, { id: Number(row.id), deletedAt })).toBe(true);
    expect(await markFanslyWsHotDeletion(app.db, { id: Number(row.id), deletedAt: new Date() })).toBe(false);
    await receipt({ messageRef: ref, receivedAt: deletedAt });
    expect(await markFanslyWsArchiveDeletions(app.db, { accountId: page.id })).toBe(1);
  };
  return { app, page, base, thread, message, receipt, mark };
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
async function receipts() {
  return (await db.pool.query<{ n: number }>("select count(*)::int as n from fansly_ws_hint_receipts")).rows[0]!.n;
}

describe("Fansly WS deletions mark stored messages (D-6)", () => {
  it("a captured delete frame alone marks nothing: no projection files a receipt or applies an old one (S4-11)", async () => {
    const f = await fixture();
    // A receipt the projector filed before step 4, a minute ago.
    await f.receipt({ messageRef: "149", receivedAt: new Date(Date.now() - 60_000) });
    const connectionId = randomUUID();
    await beginFanslyWsConnection(db.db, { id: connectionId, pageId: f.page.id, generation: GENERATION });
    await captureFanslyWsFrame(db.db, {
      connectionId, pageId: f.page.id, generation: GENERATION, accountRef: "999", ordinal: 1,
      receivedAt: new Date(Date.now() - 30_000),
      frame: JSON.stringify({ t: 10000, d: { serviceId: 5, event: { type: 10, message: {
        id: "150", groupId: GROUP, correlationId: "77", type: 1,
      } } } }),
      validate: async () => {},
    });
    expect(await runCanonicalization(f.app, { accountId: f.page.id, kinds: [FANSLY_WS_CAPTURE_KIND] }))
      .toMatchObject({ errored: 0, stamped: 1 });

    const tick = await runProjectionTick(f.app);
    expect(tick.outcomes.every((outcome) => outcome.error === null)).toBe(true);
    expect(tick.outcomes.map((outcome) => outcome.name)).not.toContain("fansly_ws_hints");
    expect(await receipts()).toBe(1);
    for (const ref of ["149", "150"]) {
      expect((await hot(ref)).deleted_at).toBeNull();
      expect((await archive(ref)).deleted_at).toBeNull();
    }
    expect((await db.pool.query(
      "select count(*)::int as n from subject_refresh_state where plane = 'fansly_ws_dm'",
    )).rows[0].n).toBe(0);
  });

  it("a marked message: every reader marks or skips it, keeping its text", async () => {
    const f = await fixture();
    const deletedAt = new Date(Date.now() - 60_000);
    await f.mark("150", deletedAt);
    expect(await hot("150")).toEqual({
      deleted_at: deletedAt, content: "second", total_tip_amount_cents: 500, in_reply_to_message_id: "149",
    });
    expect(await archive("150")).toEqual({ deleted_at: deletedAt, text_plain: "second", conversation_ref: GROUP });
    expect((await hot("149")).deleted_at).toBeNull();
    expect((await archive("149")).deleted_at).toBeNull();

    // Conversation view and AI context skip deleted rows.
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
      ["150", "second", deletedAt],
    ]);
    // Search still finds the kept text, and the hit carries the mark.
    const search = (query: string) => searchAgentArchive(f.app.db, {
      pageIds: [f.page.id], query, from: new Date(f.base.getTime() - 60_000), to: new Date(),
      includeSnippet: true, limit: 10,
    });
    expect((await search("second")).rows.map((row) => [row.messageRef, row.snippet, row.deletedAt]))
      .toEqual([["150", "second", deletedAt]]);
    expect((await search("first")).rows.map((row) => [row.messageRef, row.deletedAt])).toEqual([["149", null]]);
  });

  it("keeps the mark and the captured text when REST reads the message again", async () => {
    const f = await fixture();
    const deletedAt = new Date(Date.now() - 30_000);
    await f.mark("150", deletedAt);
    await upsertPageDmMessages(f.app.db, [f.message("150", 60_000, "rewritten")]);
    expect(await hot("150")).toMatchObject({ deleted_at: deletedAt, content: "second" });
  });

  it("the archive shadow rebuild re-applies the receipts' marks: exact evidence only, earliest receipt, no new row", async () => {
    const f = await fixture();
    const firstFrame = new Date(Date.now() - 90_000);
    await f.receipt({ messageRef: "150", receivedAt: new Date(Date.now() - 30_000) });
    await f.receipt({ messageRef: "150", receivedAt: firstFrame });
    // Not exact evidence for 149: another chat, no chat, no generation.
    await f.receipt({ messageRef: "149", groupRef: "200" });
    await f.receipt({ messageRef: "149", groupRef: null });
    await f.receipt({ messageRef: "149", generation: null });
    // A message Hub never captured.
    await f.receipt({ messageRef: "999" });

    const build = await buildMessageArchiveShadow(f.app, { accountId: f.page.id });
    expect(build.results[0]).toMatchObject({ wsDeletionsMarked: 1 });
    expect(await archive("150", "message_archive_shadow"))
      .toEqual({ deleted_at: firstFrame, text_plain: "second", conversation_ref: GROUP });
    expect((await archive("149", "message_archive_shadow")).deleted_at).toBeNull();
    expect(await archive("999", "message_archive_shadow")).toBeUndefined();
    // The live stores are the engine's: the rebuild writes only its shadow.
    expect((await archive("150")).deleted_at).toBeNull();
    expect((await hot("150")).deleted_at).toBeNull();
  });
});
