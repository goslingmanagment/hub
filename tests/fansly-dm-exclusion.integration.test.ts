import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePageSyncStates, excludePageDmConversationMessageSync, finishSyncRequestAttempt,
  getCheckpoint, getPageDmConversationById, insertSyncRequestAttempt, PageSyncLeaseLostError,
  runWithPageSyncExecutionContext, upsertCheckpointProgress, upsertFans,
  upsertPageDmConversation, upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY as exclusionKey,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP as reason,
} from "@agency_hub_core/shared";
import { emptyDmMessagesCursorState } from "../apps/runtime/src/services/sync/cursor-state.ts";
import { fanslyDmMessagesChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedThreadInput } from "./helpers/fansly-dm-sweep.ts";
import { fanslyLaneInput, fanslyLaneTelemetryStub, seedFanslyLanePage } from "./helpers/fansly-lane-harness.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); });
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

async function seed() {
  const { page, syncRunId } = await seedFanslyLanePage(testDb, {
    slug: "exclusion", name: "Exclusion", label: "exclusion", accountRef: "creator", stream: "dm_messages",
  });
  const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "fan-group" }]);
  if (!fan) throw new Error("Expected a fixture fan");
  const threadInput = { ...seedThreadInput(page.id, "group", 1), fanId: fan.id };
  const thread = await upsertPageDmConversation(testDb.db, threadInput);
  if (!thread) throw new Error("Expected a fixture conversation");
  const state = {
    ...emptyDmMessagesCursorState(), currentConversationId: thread.id,
    currentPlatformConversationId: "group", currentBeforeMessageId: "before-old", currentMode: "backfill",
  };
  await upsertCheckpointProgress(testDb.db, { platformAccountId: page.id, stream: "dm_messages", state });
  await ensurePageSyncStates(testDb.db, { pageId: page.id });
  await testDb.pool.query(`update page_sync_states set status = 'running', leased_seq = 1,
    lease_token = 'owner', lease_expires_at = now() + interval '1 hour'
    where page_id = $1 and stream = 'dm_messages'`, [page.id]);
  for (let index = 0; index < 3; index++) {
    const attempt = await insertSyncRequestAttempt(testDb.db, {
      syncRunId, platformAccountId: page.id, provider: "fansly", stream: "dm_messages",
      operation: "messages", logicalRequestId: `failure-${index}`, attemptNumber: 1,
      requestShape: { groupId: "group" },
    });
    if (!attempt) throw new Error("Expected a fixture attempt");
    await finishSyncRequestAttempt(testDb.db, attempt.id, { state: "failed", httpStatus: 500 });
  }
  return { page, syncRunId, thread, threadInput, state };
}

function chunk(fixture: Awaited<ReturnType<typeof seed>>, duringLookup: () => Promise<void>) {
  const providerError = new FanslyApiError("fixture terminal failure", 500);
  const getAccountsByIdsPage = vi.fn(async () => {
    // The message handler has loaded its old row; a second writer commits
    // while the partner lookup is outstanding, before exclusion is applied.
    await duringLookup();
    return { parsed: [], raw: { accounts: [] } };
  });
  const app = createTestAppContext(testDb, {
    syncSharedRateLimitEnabled: true,
    adapter: { getMessagesPage: async () => { throw providerError; }, getAccountsByIdsPage } as never,
  });
  const telemetry = { ...fanslyLaneTelemetryStub(), recordDmMessagesChunkSummary: vi.fn() };
  const run = () => runWithPageSyncExecutionContext({
    pageId: fixture.page.id, stream: "dm_messages", requestSeq: 1, leaseToken: "owner",
  }, () => fanslyDmMessagesChunk(app, fanslyLaneInput({
    pageId: fixture.page.id, label: fixture.page.label, accountRef: "creator", egressKey: "fixture",
    syncRunId: fixture.syncRunId, now: new Date(), telemetry,
  }) as never));
  return { run, providerError, getAccountsByIdsPage, telemetry };
}

describe("Fansly DM partner exclusion", () => {
  it("preserves the newer head, body, stored cursors and metadata committed during lookup", async () => {
    const fixture = await seed();
    let latest = fixture.thread;
    const messageAt = new Date("2026-09-14T12:00:00Z");
    const task = chunk(fixture, async () => {
      const updated = await upsertPageDmConversation(testDb.db, {
        ...fixture.threadInput, lastMessageId: "new-head", lastMessagePreview: "new preview",
        lastMessageAt: messageAt, unreadCount: 7, conversationFlags: 4,
        newestStoredMessageId: "new-head", oldestStoredMessageId: "older-cursor", storedMessageCount: 2,
        messageCoverageStatus: "partial_window", lastMessageSyncAt: new Date("2026-09-14T12:01:00Z"),
        lastSeenGeneration: 9, metadata: { newer: { revision: 2 }, retained: "value" },
      });
      if (!updated) throw new Error("Expected the concurrent update");
      latest = updated;
      await upsertPageDmMessages(testDb.db, [{
        conversationId: fixture.thread.id, platformAccountId: fixture.page.id, platformMessageId: "new-head",
        senderPlatformUserId: "fan-group", senderRole: "fan", createdAt: messageAt,
        content: "new body", totalTipAmountCents: 0, inReplyToMessageId: "reply", inReplyToRootMessageId: "root",
      }]);
    });
    expect((await task.run()).satisfied).toBe(true);
    expect(task.getAccountsByIdsPage).toHaveBeenCalledWith(expect.anything(), ["fan-group"]);
    const after = await getPageDmConversationById(testDb.db, fixture.thread.id);
    expect({ ...after, updatedAt: null }).toEqual({
      ...latest, updatedAt: null, metadata: { ...latest.metadata, [exclusionKey]: reason },
      messageSyncEligibility: "excluded", messageSyncExcludedReason: reason,
    });
    const messages = await testDb.pool.query(`select content, in_reply_to_message_id, in_reply_to_root_message_id
      from page_dm_messages where conversation_id = $1`, [fixture.thread.id]);
    expect(messages.rows).toEqual([{
      content: "new body", in_reply_to_message_id: "reply", in_reply_to_root_message_id: "root",
    }]);
    expect((await getCheckpoint(testDb.db, fixture.page.id, "dm_messages"))?.state).toEqual(emptyDmMessagesCursorState());
  });

  it.for(["rebound", "removed"])("rejects a %s conversation without clearing its checkpoint", async (change) => {
    const fixture = await seed();
    const task = chunk(fixture, async () => {
      if (change === "rebound") {
        await testDb.pool.query(
          "update page_dm_threads set partner_platform_user_id = 'replacement' where id = $1", [fixture.thread.id],
        );
      } else {
        await testDb.pool.query("delete from page_dm_threads where id = $1", [fixture.thread.id]);
      }
    });
    const checkpoint = await getCheckpoint(testDb.db, fixture.page.id, "dm_messages");
    await expect(task.run()).rejects.toBe(task.providerError);
    expect(await getCheckpoint(testDb.db, fixture.page.id, "dm_messages")).toEqual(checkpoint);
    expect(task.telemetry.recordCheckpointAdvanced).not.toHaveBeenCalled();
    const after = await getPageDmConversationById(testDb.db, fixture.thread.id);
    if (change === "removed") expect(after).toBeNull();
    else expect(after).toMatchObject({ partnerPlatformUserId: "replacement", metadata: {} });
  });

  it("refuses exclusion after lease replacement and retains the checkpoint", async () => {
    const fixture = await seed();
    const task = chunk(fixture, async () => {
      await testDb.pool.query(`update page_sync_states set lease_token = 'replacement'
        where page_id = $1 and stream = 'dm_messages'`, [fixture.page.id]);
    });
    const checkpoint = await getCheckpoint(testDb.db, fixture.page.id, "dm_messages");
    await expect(task.run()).rejects.toBeInstanceOf(PageSyncLeaseLostError);
    expect(await getCheckpoint(testDb.db, fixture.page.id, "dm_messages")).toEqual(checkpoint);
    expect((await getPageDmConversationById(testDb.db, fixture.thread.id))?.metadata).toEqual({});
  });

  it("refuses a mismatched page even when conversation and partner match", async () => {
    const fixture = await seed();
    expect(await excludePageDmConversationMessageSync(testDb.db, {
      conversationId: fixture.thread.id, platformAccountId: fixture.page.id + 1,
      partnerPlatformUserId: "fan-group", reason,
    })).toBe(false);
    expect((await getPageDmConversationById(testDb.db, fixture.thread.id))?.metadata).toEqual({});
  });
});
