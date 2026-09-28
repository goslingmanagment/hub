import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFanslyPage, createModel, finalizePageDmConversationMessageSync,
  getFanslyDmHeadTarget, hasUnresolvedFanslyDmHead, nextFanslyDmHeadRetryAt,
  observeFanslyDmHead, recordFanslyDmHeadAttempt, selectNextPageDmMessageSyncCandidate,
  upsertFans, upsertPageDmConversation, upsertPageDmMessages,
} from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

async function seed(group = "group-1", head: string | null = "expected-head") {
  const model = await createModel(testDb.db, { slug: group, name: group });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: group });
  const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: group }]);
  const conversation = await upsertPageDmConversation(testDb.db, {
    platformAccountId: page!.id, fanId: fan!.id, platformConversationId: group,
    partnerPlatformUserId: group, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: head, lastUnreadMessageId: null, lastMessageAt: new Date("2026-01-01"),
    lastMessageSenderId: group, lastMessageSenderRole: "fan", lastMessagePreview: "head",
    messageCoverageStatus: "complete", newestStoredMessageId: "old-head",
    lastMessageSyncAt: new Date(), isVisible: true, lastSeenGeneration: 1, metadata: {},
  });
  if (!conversation) throw new Error("conversation seed failed");
  await observeFanslyDmHead(testDb.db, {
    conversationId: conversation.id, messageId: head, messageAt: conversation.lastMessageAt,
  });
  return { pageId: page!.id, conversationId: conversation.id };
}

async function store(conversationId: number, pageId: number, messageId: string, at = "2026-01-01") {
  await upsertPageDmMessages(testDb.db, [{
    conversationId, platformAccountId: pageId, platformMessageId: messageId,
    senderPlatformUserId: "fan", senderRole: "fan", createdAt: new Date(at), content: "message",
    totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
  }]);
}

async function attempt(conversationId: number, messageId = "expected-head") {
  const { rows } = await testDb.pool.query<{ started: Date }>(
    `select greatest(next_retry_at, first_observed_at, now()) + interval '1 millisecond' as started
     from fansly_dm_head_debt where conversation_id = $1 and message_id = $2`,
    [conversationId, messageId],
  );
  const startedAt = rows[0]!.started;
  await recordFanslyDmHeadAttempt(testDb.db, { conversationId, messageId, startedAt, now: startedAt });
  return startedAt;
}

describe("Fansly exact head debt", () => {
  it("a successful stale read keeps the expected ID eligible only after backoff", async () => {
    const { pageId, conversationId } = await seed();
    await store(conversationId, pageId, "old-head", "2025-12-31");
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId, messageCoverageStatus: "complete", headReadAt: new Date(), enforceRetention: false,
    });
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, { platformAccountId: pageId })).toBeNull();
    expect((await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: pageId, includeHeadDebt: true,
    }))?.id).toBe(conversationId);
    const startedAt = await attempt(conversationId);
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: pageId, includeHeadDebt: true, now: startedAt,
    })).toBeNull();
    const retryAt = await nextFanslyDmHeadRetryAt(testDb.db, { platformAccountId: pageId });
    expect(retryAt!.getTime() - startedAt.getTime()).toBe(60_000);
    expect((await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: pageId, includeHeadDebt: true, now: retryAt!,
    }))?.id).toBe(conversationId);
    expect(await hasUnresolvedFanslyDmHead(testDb.db, conversationId)).toBe(true);
  });

  it("five bounded failed reads leave exhausted debt; relisting and complete history cannot clear it", async () => {
    const { pageId, conversationId } = await seed();
    for (let n = 0; n < 5; n++) await attempt(conversationId);
    await observeFanslyDmHead(testDb.db, { conversationId, messageId: "expected-head", messageAt: new Date() });
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId, messageCoverageStatus: "complete", headReadAt: new Date(), enforceRetention: false,
    });
    expect(await nextFanslyDmHeadRetryAt(testDb.db, { platformAccountId: pageId })).toBeNull();
    const { rows } = await testDb.pool.query("select state, attempts, history_coverage from fansly_dm_head_debt_report");
    expect(rows).toEqual([{ state: "exhausted", attempts: 5, history_coverage: "complete" }]);
    await store(conversationId, pageId, "expected-head");
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId, messageCoverageStatus: "complete", headReadAt: new Date(), enforceRetention: false,
    });
    expect(await hasUnresolvedFanslyDmHead(testDb.db, conversationId)).toBe(false);
  });

  it("exact ID resolves even behind a newer stored message; another conversation's same ID does not", async () => {
    const a = await seed("group-a");
    const b = await seed("group-b");
    await store(b.conversationId, b.pageId, "expected-head");
    await store(a.conversationId, a.pageId, "newer", "2026-02-01");
    await attempt(a.conversationId);
    expect(await hasUnresolvedFanslyDmHead(testDb.db, a.conversationId)).toBe(true);
    await store(a.conversationId, a.pageId, "expected-head");
    await attempt(a.conversationId);
    expect(await hasUnresolvedFanslyDmHead(testDb.db, a.conversationId)).toBe(false);
  });

  it("a new head retains old debt and does not inherit its retry or receipt", async () => {
    const { pageId, conversationId } = await seed();
    const startedAt = await attempt(conversationId);
    await observeFanslyDmHead(testDb.db, { conversationId, messageId: "new-head", messageAt: null });
    await store(conversationId, pageId, "expected-head");
    await recordFanslyDmHeadAttempt(testDb.db, { conversationId, messageId: "expected-head", startedAt });
    expect(await getFanslyDmHeadTarget(testDb.db, { conversationId })).toMatchObject({ messageId: "new-head", attempts: 0 });
  });

  it("replaying a completed attempt is idempotent and pending history cannot bypass its backoff", async () => {
    const { pageId, conversationId } = await seed();
    await testDb.pool.query("update page_dm_threads set message_coverage_status = 'pending_backfill' where id = $1", [conversationId]);
    const startedAt = await attempt(conversationId);
    await recordFanslyDmHeadAttempt(testDb.db, { conversationId, messageId: "expected-head", startedAt });
    expect(await getFanslyDmHeadTarget(testDb.db, { conversationId, messageId: "expected-head" })).toMatchObject({ attempts: 1 });
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: pageId, includeHeadDebt: true, now: startedAt,
    })).toBeNull();
  });

  it("pending history without a head remains eligible, but hidden/excluded/identity-less debt does not", async () => {
    const { pageId, conversationId } = await seed("without-head", null);
    await testDb.pool.query("update page_dm_threads set message_coverage_status = 'pending_backfill' where id = $1", [conversationId]);
    expect((await selectNextPageDmMessageSyncCandidate(testDb.db, { platformAccountId: pageId, includeHeadDebt: true }))?.id).toBe(conversationId);
    await observeFanslyDmHead(testDb.db, { conversationId, messageId: "head", messageAt: null });
    for (const change of ["is_visible = false", "is_visible = true, fan_id = null", "metadata = '{\"messageSyncExcludedReason\":\"excluded\"}'"]) {
      await testDb.pool.query(`update page_dm_threads set ${change} where id = $1`, [conversationId]);
      expect(await nextFanslyDmHeadRetryAt(testDb.db, { platformAccountId: pageId })).toBeNull();
    }
  });
});
