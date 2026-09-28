import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  finalizePageDmConversationMessageSync,
  getCheckpoint,
  getFanslyDmHeadTarget,
  getPageDmConversationById,
  getPageSyncState,
  hasUnresolvedFanslyDmHead,
  nextFanslyDmHeadRetryAt,
  observeFanslyDmHead,
  selectNextPageDmMessageSyncCandidate,
  startSyncRun,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
} from "@agency_hub_core/db";
import type { HttpRequestEvent } from "@agency_hub_core/shared";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmMessagesChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { fakeTelemetry, groupsPage, PAGE_ACCOUNT_ID, seedThreadInput, sweepAdapter } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

async function seedPage() {
  const model = await createModel(testDb.db, { slug: "history", name: "History" });
  if (!model) throw new Error("Expected model seed");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "history" });
  if (!page) throw new Error("Expected page seed");
  return page;
}

async function seedThread(pageId: number, group: string, attempts: number, unreadCount = 0) {
  const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: `fan-${group}` }]);
  if (!fan) throw new Error("Expected fan seed");
  const thread = await upsertPageDmConversation(testDb.db, {
    ...seedThreadInput(pageId, group, 1),
    fanId: fan.id,
    unreadCount,
    messageCoverageStatus: "pending_backfill",
    newestStoredMessageId: "older-message",
  });
  if (!thread) throw new Error("Expected conversation seed");
  await observeFanslyDmHead(testDb.db, {
    conversationId: thread.id, messageId: thread.lastMessageId, messageAt: thread.lastMessageAt,
  });
  await testDb.pool.query(
    `update fansly_dm_head_debt set attempts = $2, next_retry_at = '2026-01-01'::timestamptz
     where conversation_id = $1`,
    [thread.id, attempts],
  );
  return thread;
}

async function readDebt(conversationId: number) {
  const { rows } = await testDb.pool.query(
    `select r.message_id, r.state, r.attempts, r.captured_at, r.history_coverage
     from fansly_dm_head_debt_report r
     join page_dm_threads c on c.platform_account_id = r.page_id
       and c.platform_conversation_id = r.platform_conversation_id
     where c.id = $1`,
    [conversationId],
  );
  return rows;
}

describe("Fansly exhausted head debt and ordinary history", () => {
  it("offers pending history while retaining the exhausted unresolved identity", async () => {
    const page = await seedPage();
    const thread = await seedThread(page.id, "exhausted", 5);
    const before = await readDebt(thread.id);
    expect(before).toEqual([{
      message_id: "msg-exhausted", state: "exhausted", attempts: 5,
      captured_at: null, history_coverage: "pending_backfill",
    }]);

    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id, includeHeadDebt: true,
    })).toMatchObject({ id: thread.id, lastMessageId: "msg-exhausted", messageCoverageStatus: "pending_backfill" });
    expect(await hasUnresolvedFanslyDmHead(testDb.db, thread.id)).toBe(true);
    expect(await getFanslyDmHeadTarget(testDb.db, { conversationId: thread.id })).toBeNull();
    expect(await nextFanslyDmHeadRetryAt(testDb.db, { platformAccountId: page.id })).toBeNull();
    expect(await readDebt(thread.id)).toEqual(before);
  });

  it("prioritizes an unexhausted head, and its backoff cannot masquerade as ordinary history", async () => {
    const page = await seedPage();
    const history = await seedThread(page.id, "history", 5, 100);
    const active = await seedThread(page.id, "active", 4);
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id, includeHeadDebt: true,
    })).toMatchObject({ id: active.id });
    expect(await getFanslyDmHeadTarget(testDb.db, { conversationId: active.id }))
      .toMatchObject({ messageId: "msg-active", attempts: 4, captured: false });

    await testDb.pool.query(
      "update fansly_dm_head_debt set next_retry_at = now() + interval '1 hour' where conversation_id = $1",
      [active.id],
    );
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id, includeHeadDebt: true,
    })).toMatchObject({ id: history.id });
    expect(await hasUnresolvedFanslyDmHead(testDb.db, active.id)).toBe(true);
    expect(await nextFanslyDmHeadRetryAt(testDb.db, { platformAccountId: page.id })).not.toBeNull();
  });

  it("reads older history once and completes without retrying an exhausted head", async () => {
    const page = await seedPage();
    const thread = await seedThread(page.id, "exhausted", 5);
    await upsertPageDmMessages(testDb.db, [{
      conversationId: thread.id, platformAccountId: page.id,
      platformMessageId: "stored-overlap", senderPlatformUserId: "fan-exhausted",
      senderRole: "fan", createdAt: new Date("2026-03-08"), content: "already stored",
      totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
    }]);
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: thread.id, messageCoverageStatus: "pending_backfill", headReadAt: new Date(), enforceRetention: false,
    });
    const calls: Array<string | null> = [];
    const adapter = {
      async getMessagesPage(
        context: { requestObserver?: { onRequestEvent(event: HttpRequestEvent): Promise<void> } | null },
        params: { groupId: string; before?: string | null },
      ) {
        const before = params.before ?? null;
        calls.push(before);
        await context.requestObserver?.onRequestEvent({
          state: "started", requestId: `history-${calls.length}`, operation: "messages",
          endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
        });
        // A read from the head only overlaps; the older cursor makes history progress.
        const message = before === "stored-overlap"
          ? { id: "older-history", createdAt: Date.parse("2026-03-07") }
          : { id: "stored-overlap", createdAt: Date.parse("2026-03-08") };
        return {
          items: [{ ...message, senderId: "fan-exhausted", content: message.id }],
          groupId: params.groupId, before, done: true,
          raw: { response: { messages: [message] } },
        };
      },
    };
    const app = createTestAppContext(testDb, {
      syncSharedRateLimitEnabled: true, adapter: adapter as never,
    });
    app.config.fanslyDmHeadCatchupPageAllowlist = page.label;
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id, stream: "dm_messages", trigger: "manual",
    });
    if (!run) throw new Error("Expected message sync run seed");
    const result = await fanslyDmMessagesChunk(app, {
      pageContext: {
        page: { ...page, platformAccountId: PAGE_ACCOUNT_ID }, platform: "fansly",
        session: { authorization: "token" }, proxy: null, egressKey: "direct",
      },
      streamState: { stream: "dm_messages" }, syncRunId: run.id,
      telemetry: { ...fakeTelemetry(), recordDmMessagesChunkSummary: vi.fn(async () => {}) },
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(calls).toEqual(["stored-overlap"]);
    expect(await getPageDmConversationById(testDb.db, thread.id)).toMatchObject({
      lastMessageId: "msg-exhausted", newestStoredMessageId: "stored-overlap",
      oldestStoredMessageId: "older-history", storedMessageCount: 2,
      messageCoverageStatus: "complete",
    });
    expect(await getCheckpoint(testDb.db, page.id, "dm_messages"))
      .toMatchObject({ state: { currentConversationId: null } });
    expect(await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id, includeHeadDebt: true,
    })).toBeNull();
    expect(await hasUnresolvedFanslyDmHead(testDb.db, thread.id)).toBe(true);
    expect(await readDebt(thread.id)).toEqual([{
      message_id: "msg-exhausted", state: "exhausted", attempts: 5,
      captured_at: null, history_coverage: "complete",
    }]);
  });

  it.each([
    { attempts: 5, followups: 1, debtState: "exhausted" },
    { attempts: 4, followups: 0, debtState: "backoff" },
  ])("the allowlisted sweep queues $followups history followups with $attempts head attempts", async ({
    attempts, followups, debtState,
  }) => {
    const page = await seedPage();
    const thread = await seedThread(page.id, "listed", attempts);
    await testDb.pool.query(
      "update fansly_dm_head_debt set next_retry_at = now() + interval '1 hour' where conversation_id = $1",
      [thread.id],
    );
    await ensurePageSyncStates(testDb.db, { pageId: page.id });
    const before = await getPageSyncState(testDb.db, page.id, "dm_messages");
    if (!before) throw new Error("Expected message stream seed");
    const { adapter, calls } = sweepAdapter({
      pages: [groupsPage({ conversations: ["listed"], total: 1, offset: 0, done: true })],
    });
    const app = createTestAppContext(testDb, { syncSharedRateLimitEnabled: true, adapter });
    app.config.fanslyDmHeadCatchupPageAllowlist = page.label;
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id, stream: "dm_conversations", trigger: "manual",
    });
    if (!run) throw new Error("Expected sync run seed");

    const result = await fanslyDmConversationsChunk(app, {
      pageContext: {
        page: { ...page, platformAccountId: PAGE_ACCOUNT_ID }, platform: "fansly",
        session: { authorization: "token" }, proxy: null, egressKey: "direct",
      },
      streamState: { requestSeq: 1 }, syncRunId: run.id,
      telemetry: fakeTelemetry(), budget: new SyncChunkBudget(5),
    } as never);

    expect(result).toMatchObject({ satisfied: true, stats: { processedConversations: 1 } });
    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(await getPageSyncState(testDb.db, page.id, "dm_messages"))
      .toMatchObject({ requestSeq: before.requestSeq + followups });
    expect(await readDebt(thread.id)).toEqual([{
      message_id: "msg-listed", state: debtState, attempts,
      captured_at: null, history_coverage: "pending_backfill",
    }]);
  });
});

describe("Fansly pending history off the head catch-up allowlist", () => {
  const storedIds = Array.from({ length: 30 }, (_, index) => `s${String(index).padStart(2, "0")}`);
  const storedAt = (index: number) => Date.parse("2026-03-09T11:00:00.000Z") - index * 60_000;

  /** A pending_backfill thread whose list head (msg-g) is not its newest
   *  stored message, on a page with head catch-up off (the prod default). */
  async function runPendingHistory(input: {
    stored: string[];
    headStaleByTime: boolean;
    page: (before: string | null) => { ids: string[]; done: boolean };
  }) {
    const page = await seedPage();
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "fan-g" }]);
    if (!fan) throw new Error("Expected fan seed");
    const thread = await upsertPageDmConversation(testDb.db, {
      ...seedThreadInput(page.id, "g", 1), fanId: fan.id, messageCoverageStatus: "pending_backfill",
    });
    if (!thread) throw new Error("Expected conversation seed");
    await upsertPageDmMessages(testDb.db, input.stored.map((id, index) => ({
      conversationId: thread.id, platformAccountId: page.id, platformMessageId: id,
      senderPlatformUserId: "fan-g", senderRole: "fan" as const, createdAt: new Date(storedAt(index)),
      content: id, totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
    })));
    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: thread.id, messageCoverageStatus: "pending_backfill", headReadAt: new Date(), enforceRetention: false,
    });
    // Seeded after the list head (09.03 12:00) unless the head is due.
    await testDb.pool.query("update page_dm_threads set last_message_sync_at = $2 where id = $1", [
      thread.id, input.headStaleByTime ? "2026-03-09T00:00:00.000Z" : "2026-03-10T00:00:00.000Z",
    ]);
    const calls: Array<string | null> = [];
    const adapter = {
      async getMessagesPage(
        context: { requestObserver?: { onRequestEvent(event: HttpRequestEvent): Promise<void> } | null },
        params: { groupId: string; before?: string | null },
      ) {
        const before = params.before ?? null;
        calls.push(before);
        await context.requestObserver?.onRequestEvent({
          state: "started", requestId: `pending-${calls.length}`, operation: "messages",
          endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(),
        });
        const { ids, done } = input.page(before);
        const messages = ids.map((id) => ({
          id, content: id, senderId: "fan-g",
          createdAt: id === "msg-g" ? Date.parse("2026-03-09T12:00:00.000Z")
            : id === "older" ? Date.parse("2026-03-01T00:00:00.000Z")
            : storedAt(storedIds.indexOf(id)),
        }));
        return { items: messages, groupId: params.groupId, before, done, raw: { response: { messages } } };
      },
    };
    const app = createTestAppContext(testDb, { syncSharedRateLimitEnabled: true, adapter: adapter as never });
    expect(app.config.fanslyDmHeadCatchupPageAllowlist ?? "none").toBe("none");
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id, stream: "dm_messages", trigger: "manual",
    });
    if (!run) throw new Error("Expected message sync run seed");
    const result = await fanslyDmMessagesChunk(app, {
      pageContext: {
        page: { ...page, platformAccountId: PAGE_ACCOUNT_ID }, platform: "fansly",
        session: { authorization: "token" }, proxy: null, egressKey: "direct",
      },
      streamState: { stream: "dm_messages" }, syncRunId: run.id,
      telemetry: { ...fakeTelemetry(), recordDmMessagesChunkSummary: vi.fn(async () => {}) },
      budget: new SyncChunkBudget(5),
    } as never);
    return { calls, result, thread: await getPageDmConversationById(testDb.db, thread.id) };
  }

  // The head page overlaps without exhausting; only the older cursor progresses.
  const headOverlap = (ids: string[]) => (before: string | null) => before === null
    ? { ids, done: false }
    : { ids: ["older"], done: true };

  it("walks history from the oldest cursor instead of rereading an already-read head", async () => {
    const { calls, result, thread } = await runPendingHistory({
      stored: storedIds, headStaleByTime: false, page: headOverlap(storedIds.slice(0, 25)),
    });

    // Before the fix: five identical head reads and the thread stayed pending.
    expect(calls).toEqual(["s29"]);
    expect(result.satisfied).toBe(true);
    expect(thread).toMatchObject({
      lastMessageId: "msg-g", newestStoredMessageId: "s00", oldestStoredMessageId: "older",
      storedMessageCount: 31, messageCoverageStatus: "complete",
    });
  });

  it("reads a time-stale head once, then walks history even when /message never returns that id", async () => {
    const { calls, result, thread } = await runPendingHistory({
      stored: storedIds, headStaleByTime: true, page: headOverlap(storedIds.slice(0, 25)),
    });

    expect(calls).toEqual([null, "s29"]);
    expect(result.satisfied).toBe(true);
    expect(thread).toMatchObject({
      lastMessageId: "msg-g", newestStoredMessageId: "s00", messageCoverageStatus: "complete",
    });
  });

  it("still reads a genuinely new head before older history", async () => {
    const { calls, thread } = await runPendingHistory({
      stored: storedIds, headStaleByTime: true, page: headOverlap(["msg-g", ...storedIds.slice(0, 24)]),
    });

    expect(calls).toEqual([null, "s29"]);
    expect(thread).toMatchObject({
      lastMessageId: "msg-g", newestStoredMessageId: "msg-g", messageCoverageStatus: "complete",
    });
  });

  it("completes pending history when the head walk itself exhausts the provider", async () => {
    const { calls, result, thread } = await runPendingHistory({
      stored: storedIds.slice(0, 2), headStaleByTime: true,
      page: () => ({ ids: ["msg-g", "s00", "s01"], done: true }),
    });

    // An incremental walk is contiguous from the head: exhaustion is the whole history.
    expect(calls).toEqual([null]);
    expect(result.satisfied).toBe(true);
    expect(thread).toMatchObject({
      newestStoredMessageId: "msg-g", oldestStoredMessageId: "s01", storedMessageCount: 3,
      messageCoverageStatus: "complete",
    });
  });
});
