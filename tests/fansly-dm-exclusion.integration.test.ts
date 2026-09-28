import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countOtherDmMessageGroupsFailingSinceLastSuccess,
  ensurePageSyncStates, excludePageDmConversationMessageSync, finalizePageDmConversationMessageSync,
  finishSyncRequestAttempt, getCheckpoint, getPageDmConversationById, insertSyncRequestAttempt,
  PageSyncLeaseLostError, runWithPageSyncExecutionContext, upsertCheckpointProgress, upsertFans,
  upsertPageDmConversation, upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY as exclusionKey,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP as reason,
} from "@agency_hub_core/shared";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
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

describe("Fansly DM per-thread breaker", () => {
  async function seedBreakerPage() {
    const { page, syncRunId } = await seedFanslyLanePage(testDb, {
      slug: "breaker", name: "Breaker", label: "breaker", accountRef: "creator", stream: "dm_messages",
    });
    const threads: Record<string, NonNullable<Awaited<ReturnType<typeof upsertPageDmConversation>>>> = {};
    for (const [group, unreadCount] of [["poison", 5], ["healthy", 1]] as const) {
      const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: `fan-${group}` }]);
      if (!fan) throw new Error("Expected a fixture fan");
      const thread = await upsertPageDmConversation(testDb.db, {
        ...seedThreadInput(page.id, group, 1), fanId: fan.id, unreadCount,
      });
      if (!thread) throw new Error("Expected a fixture conversation");
      threads[group] = thread;
    }
    await ensurePageSyncStates(testDb.db, { pageId: page.id });
    await testDb.pool.query(`update page_sync_states set status = 'running', leased_seq = 1,
      lease_token = 'owner', lease_expires_at = now() + interval '1 hour'
      where page_id = $1 and stream = 'dm_messages'`, [page.id]);
    return { page, syncRunId, poison: threads.poison!, healthy: threads.healthy! };
  }

  async function journalAttempt(
    fixture: Awaited<ReturnType<typeof seedBreakerPage>>,
    group: string,
    outcome: { state: "success" | "failed"; httpStatus?: number; failureKind?: "http" | "policy" },
    startedAt = new Date(),
  ) {
    const attempt = await insertSyncRequestAttempt(testDb.db, {
      syncRunId: fixture.syncRunId, platformAccountId: fixture.page.id, provider: "fansly", stream: "dm_messages",
      operation: "messages", logicalRequestId: `${group}-${startedAt.getTime()}`, attemptNumber: 1,
      requestShape: { groupId: group }, startedAt,
    });
    if (!attempt) throw new Error("Expected a fixture attempt");
    await finishSyncRequestAttempt(testDb.db, attempt.id, { ...outcome, finishedAt: startedAt });
  }

  function breakerChunk(fixture: Awaited<ReturnType<typeof seedBreakerPage>>, failingGroups: Set<string>) {
    const providerError = new FanslyApiError("error getting group messages", 500, 500);
    const groups: string[] = [];
    const getMessagesPage = vi.fn(async (_context: unknown, params: { groupId: string }) => {
      groups.push(params.groupId);
      if (failingGroups.has(params.groupId)) throw providerError;
      const message = { id: `msg-${params.groupId}`, senderId: `fan-${params.groupId}`, content: "body",
        createdAt: Date.parse("2026-03-09T12:00:00.000Z") };
      return { items: [message], groupId: params.groupId, before: null, done: true, raw: { messages: [message] } };
    });
    const app = createTestAppContext(testDb, {
      syncSharedRateLimitEnabled: true,
      adapter: { getMessagesPage, getAccountsByIdsPage: vi.fn() } as never,
    });
    const run = () => runWithPageSyncExecutionContext({
      pageId: fixture.page.id, stream: "dm_messages", requestSeq: 1, leaseToken: "owner",
    }, () => fanslyDmMessagesChunk(app, fanslyLaneInput({
      pageId: fixture.page.id, label: fixture.page.label, accountRef: "creator", egressKey: "fixture",
      syncRunId: fixture.syncRunId, now: new Date(),
      telemetry: { ...fanslyLaneTelemetryStub(), recordDmMessagesChunkSummary: vi.fn() } as never,
    }) as never));
    return { run, providerError, groups };
  }

  const breakerRow = async (conversationId: number) => (await testDb.pool.query(
    "select failure_count, error_class, next_retry_at from page_dm_message_sync_health where conversation_id = $1",
    [conversationId],
  )).rows[0] as { failure_count: number; error_class: string; next_retry_at: Date } | undefined;

  it("backs off a thread whose first page fails, so the next chunk reads another thread", async () => {
    const fixture = await seedBreakerPage();
    const failing = new Set(["poison"]);
    const chunk = breakerChunk(fixture, failing);

    await expect(chunk.run()).rejects.toBe(chunk.providerError);
    const row = await breakerRow(fixture.poison.id);
    expect(row).toMatchObject({ failure_count: 1, error_class: "fansly_500" });
    expect(row!.next_retry_at.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await getCheckpoint(testDb.db, fixture.page.id, "dm_messages"))?.state).toEqual(emptyDmMessagesCursorState());

    // Before the breaker, the checkpoint pinned the poison thread for good.
    expect((await chunk.run()).satisfied).toBe(true);
    expect(chunk.groups).toEqual(["poison", "healthy"]);
    expect(await getPageDmConversationById(testDb.db, fixture.healthy.id))
      .toMatchObject({ newestStoredMessageId: "msg-healthy", messageCoverageStatus: "complete" });

    // Re-admitted once its window lapses; a completed walk clears the row.
    failing.clear();
    await testDb.pool.query("update page_dm_message_sync_health set next_retry_at = now() - interval '1 second'");
    expect((await chunk.run()).satisfied).toBe(true);
    expect(chunk.groups).toEqual(["poison", "healthy", "poison"]);
    expect(await breakerRow(fixture.poison.id)).toBeUndefined();
  });

  it("treats failures across several threads since the last good read as an outage", async () => {
    const fixture = await seedBreakerPage();
    await journalAttempt(fixture, "other-1", { state: "success" }, new Date(Date.now() - 60_000));
    await journalAttempt(fixture, "other-2", { state: "failed", httpStatus: 502, failureKind: "http" }, new Date(Date.now() - 30_000));
    await journalAttempt(fixture, "other-3", { state: "failed", httpStatus: 502, failureKind: "http" }, new Date(Date.now() - 20_000));
    const chunk = breakerChunk(fixture, new Set(["poison", "healthy"]));

    await expect(chunk.run()).rejects.toBe(chunk.providerError);
    expect(await breakerRow(fixture.poison.id)).toBeUndefined();
    expect((await getCheckpoint(testDb.db, fixture.page.id, "dm_messages"))?.state)
      .toMatchObject({ currentConversationId: fixture.poison.id });

    // A later good read of any thread ends the outage verdict.
    await journalAttempt(fixture, "other-1", { state: "success" }, new Date(Date.now() - 10_000));
    await expect(chunk.run()).rejects.toBe(chunk.providerError);
    expect(await breakerRow(fixture.poison.id)).toMatchObject({ failure_count: 1 });
  });

  it("counts only other groups' provider failures after the page's latest successful read", async () => {
    const fixture = await seedBreakerPage();
    const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
    const count = (since = at(3600)) => countOtherDmMessageGroupsFailingSinceLastSuccess(testDb.db, {
      platformAccountId: fixture.page.id, platformConversationId: "poison", since,
    });
    expect(await count()).toBe(0);

    await journalAttempt(fixture, "before-success", { state: "failed", httpStatus: 500, failureKind: "http" }, at(50));
    await journalAttempt(fixture, "any", { state: "success" }, at(40));
    await journalAttempt(fixture, "poison", { state: "failed", httpStatus: 500, failureKind: "http" }, at(30));
    await journalAttempt(fixture, "policy", { state: "failed", failureKind: "policy" }, at(25));
    await journalAttempt(fixture, "other-1", { state: "failed", httpStatus: 404, failureKind: "http" }, at(20));
    await journalAttempt(fixture, "other-1", { state: "failed", httpStatus: 500, failureKind: "http" }, at(15));
    expect(await count()).toBe(1);

    await journalAttempt(fixture, "other-2", { state: "failed", httpStatus: 502, failureKind: "http" }, at(10));
    expect(await count()).toBe(2);
    // Outside the scan window nothing counts, not even the stale success.
    expect(await count(at(5))).toBe(0);
  });
});

describe("Fansly DM incremental walk dropped mid-way", () => {
  const at = (n: number) => Date.parse("2026-09-20T00:00:00.000Z") + n * 60_000;
  const id = (n: number) => `m${String(n).padStart(2, "0")}`;

  it("reads the gap below its own earlier pages when the thread is picked again", async () => {
    const { page, syncRunId } = await seedFanslyLanePage(testDb, {
      slug: "dropped", name: "Dropped", label: "dropped", accountRef: "creator", stream: "dm_messages",
    });
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "fan-group" }]);
    if (!fan) throw new Error("Expected a fixture fan");
    // m01..m10 are stored and summarized; the provider head is m30.
    const thread = await upsertPageDmConversation(testDb.db, {
      ...seedThreadInput(page.id, "group", 1), fanId: fan.id, lastMessageId: id(30), lastMessageAt: new Date(at(30)),
    });
    if (!thread) throw new Error("Expected a fixture conversation");
    const message = (n: number) => ({ id: id(n), senderId: "fan-group", content: `body ${n}`, createdAt: at(n) });
    await upsertPageDmMessages(testDb.db, Array.from({ length: 10 }, (_, index) => ({
      conversationId: thread.id, platformAccountId: page.id, platformMessageId: id(index + 1),
      senderPlatformUserId: "fan-group", senderRole: "fan" as const, createdAt: new Date(at(index + 1)),
      content: `body ${index + 1}`, totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
    })));
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: thread.id, messageCoverageStatus: "complete", headReadAt: new Date(at(10)), enforceRetention: false,
    });
    await ensurePageSyncStates(testDb.db, { pageId: page.id });
    await testDb.pool.query(`update page_sync_states set status = 'running', leased_seq = 1,
      lease_token = 'owner', lease_expires_at = now() + interval '1 hour'
      where page_id = $1 and stream = 'dm_messages'`, [page.id]);

    // Five messages a page, newest first, one request per chunk.
    const history = Array.from({ length: 30 }, (_, index) => message(30 - index));
    const befores: Array<string | null> = [];
    const getMessagesPage = vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
      params: { groupId: string; before?: string | null },
    ) => {
      befores.push(params.before ?? null);
      await context.requestObserver?.onRequestEvent({
        state: "started", requestId: `walk-${befores.length}`, operation: "messages",
        endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
      });
      const start = params.before ? history.findIndex((item) => item.id === params.before) + 1 : 0;
      const items = history.slice(start, start + 5);
      return { items, groupId: params.groupId, before: params.before ?? null,
        done: start + 5 >= history.length, raw: { messages: items } };
    });
    const app = createTestAppContext(testDb, {
      syncSharedRateLimitEnabled: true, adapter: { getMessagesPage, getAccountsByIdsPage: vi.fn() } as never,
    });
    const telemetry = { ...fanslyLaneTelemetryStub(), recordDmMessagesChunkSummary: vi.fn() };
    const runChunk = () => runWithPageSyncExecutionContext({
      pageId: page.id, stream: "dm_messages", requestSeq: 1, leaseToken: "owner",
    }, () => fanslyDmMessagesChunk(app, fanslyLaneInput({
      pageId: page.id, label: page.label, accountRef: "creator", egressKey: "fixture",
      syncRunId, now: new Date(), telemetry, budget: new SyncChunkBudget(1),
    }) as never));

    // Two pages of the head walk land (m30..m21), then the thread drops out.
    await runChunk();
    await runChunk();
    expect((await getCheckpoint(testDb.db, page.id, "dm_messages"))?.state)
      .toMatchObject({ currentConversationId: thread.id, currentMode: "incremental", currentBeforeMessageId: id(21) });
    await excludePageDmConversationMessageSync(testDb.db, {
      conversationId: thread.id, platformAccountId: page.id, partnerPlatformUserId: "fan-group", reason,
    });
    expect((await runChunk()).satisfied).toBe(true);
    expect(telemetry.anomalies).toEqual([expect.objectContaining({
      code: "dm_messages_walk_dropped",
      details: expect.objectContaining({ reason: "excluded", droppedBeforeMessageId: id(21), newestStoredMessageId: id(10) }),
    })]);

    // Eligible again, the thread is picked from its head. Its own pages above
    // m10 are not known ground, so the walk continues down to m10.
    await testDb.pool.query("update page_dm_threads set metadata = metadata - $2 where id = $1", [thread.id, exclusionKey]);
    for (let chunk = 0; chunk < 10 && !(await runChunk()).satisfied; chunk++);

    expect(befores).toEqual([null, id(26), null, id(26), id(21), id(16), id(11)]);
    const stored = await testDb.pool.query(
      "select platform_message_id from page_dm_messages where conversation_id = $1 order by created_at", [thread.id],
    );
    expect(stored.rows.map((row) => row.platform_message_id)).toEqual(Array.from({ length: 30 }, (_, index) => id(index + 1)));
    expect(await getPageDmConversationById(testDb.db, thread.id)).toMatchObject({
      newestStoredMessageId: id(30), oldestStoredMessageId: id(1), storedMessageCount: 30, messageCoverageStatus: "complete",
    });
  });
});
