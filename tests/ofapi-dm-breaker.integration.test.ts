// Per-conversation circuit breaker for the OFAPI dm_messages sync (0086):
// one poison chat (60s vendor-side scrape abort, status=null) must not wedge
// a page's whole dm_messages stream. Covers: timeout → failure recorded, pin
// cleared, next candidate proceeds, stream completes with skippedQuarantined;
// the 4th failure quarantines; 401 stays page-level; and the adaptive probe
// plumb-through (limit 100 → 20 → 5, single attempts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  listPageDmConversationsByPlatformConversationIds,
  recordConversationSyncFailure,
  setPageOfapiAccountId,
  startSyncRun,
  upsertCheckpoint,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { OfapiApiError, type OfapiClient, type OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  executeOfapiDmConversationsChunk,
  executeOfapiDmMessagesChunk,
} from "../apps/runtime/src/services/sync/ofapi-dm-sync.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const OFAPI_ACCOUNT = "acct_breaker_test";
const FAN_A = "2000005";
const FAN_B = "2000006";
const MODEL_USER_ID = 555000222;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

function listPage(items: Record<string, unknown>[], hasNextPage: boolean, balance = 20_000): OfapiListPage {
  return {
    items,
    hasNextPage,
    meta: {
      creditsUsed: 1,
      creditBalance: balance,
      isCached: false,
      rateRemainingMinute: 999,
    },
  };
}

function chatItem(input: {
  fanId: string;
  unread?: number;
  lastMessage?: { id: string; createdAt: string } | null;
}): Record<string, unknown> {
  return {
    unreadMessagesCount: input.unread ?? 0,
    lastMessage: input.lastMessage
      ? {
        id: Number(input.lastMessage.id),
        text: "<p>last message</p>",
        createdAt: input.lastMessage.createdAt,
        fromUser: { id: Number(input.fanId), _view: "s" },
      }
      : null,
    fan: {
      id: Number(input.fanId),
      name: `Fan ${input.fanId}`,
      username: `fan${input.fanId}`,
      displayName: "",
    },
  };
}

function messageItem(input: {
  id: string;
  fanId: string;
  createdAt: string;
  sentByMe?: boolean;
}): Record<string, unknown> {
  const sentByMe = input.sentByMe ?? false;
  return {
    id: Number(input.id),
    text: `<p>message ${input.id}</p>`,
    createdAt: input.createdAt,
    isSentByMe: sentByMe,
    fromUser: { id: sentByMe ? MODEL_USER_ID : Number(input.fanId), _view: "s" },
    isTip: false,
    price: 0,
    mediaCount: 0,
    media: [],
  };
}

function vendorTimeoutError(chatId: string) {
  // The 60s slow-lane abort surfaces as OfapiApiError(status=null, body=null)
  // whose message carries the AbortSignal text.
  return new OfapiApiError(
    `OFAPI request failed: GET /${OFAPI_ACCOUNT}/chats/${chatId}/messages: The operation was aborted due to timeout`,
    null,
    null,
  );
}

type ScriptEntry = { page: OfapiListPage } | { error: Error };

type RecordedMessageCall = {
  chatId: string;
  limit: number | undefined;
  retries: number | undefined;
  firstId: string | null;
};

/**
 * Fake OFAPI client scripted PER CHAT for listChatMessages (the breaker tests
 * interleave chats, so a global call sequence would be brittle) and by offset
 * for listChats. Records every message call's limit/retries/firstId.
 */
function scriptedOfapiClient(input: {
  chats?: Map<number, OfapiListPage>;
  messagesByChat?: Record<string, ScriptEntry[]>;
}) {
  const messageCalls: RecordedMessageCall[] = [];
  const perChatCallCount = new Map<string, number>();

  const listChats = vi.fn(async (_context: unknown, _accountId: string, params: { offset?: number }) => {
    const page = input.chats?.get(params.offset ?? 0);
    if (!page) {
      throw new Error(`Unexpected listChats offset ${params.offset ?? 0}`);
    }
    return page;
  });

  const listChatMessages = vi.fn(async (
    _context: unknown,
    _accountId: string,
    chatId: string,
    params: { limit?: number; firstId?: string | null; retries?: number },
  ) => {
    messageCalls.push({
      chatId,
      limit: params.limit,
      retries: params.retries,
      firstId: params.firstId ?? null,
    });
    const index = perChatCallCount.get(chatId) ?? 0;
    perChatCallCount.set(chatId, index + 1);
    const entry = input.messagesByChat?.[chatId]?.[index];
    if (!entry) {
      throw new Error(`Unexpected listChatMessages call #${index + 1} for chat ${chatId}`);
    }
    if ("error" in entry) {
      throw entry.error;
    }
    return entry.page;
  });

  const client: OfapiClient = {
    createWebhook: vi.fn(async () => ({ id: "wh" })),
    updateWebhook: vi.fn(async () => ({ id: "wh" })),
    listAccounts: vi.fn(async () => []),
    listChats: listChats as never,
    listChatMessages: listChatMessages as never,
    listActiveFans: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
    pingBalance: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
  };
  return { client, listChats, listChatMessages, messageCalls };
}

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    recordDmMessagesChunkSummary: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  } as never;
}

async function seedMappedPage(label = "breaker-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label,
  });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function buildChunkInput(page: { id: number }, stream: "dm_conversations" | "dm_messages", options?: {
  maxRequests?: number;
}) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream,
    trigger: "manual",
  });
  if (!run) {
    throw new Error("sync run seed failed");
  }
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "onlyfans" as const,
      auth: { token: "unused" },
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream } as never,
    syncRunId: run.id,
    telemetry: fakeTelemetry(),
    budget: new SyncChunkBudget(options?.maxRequests ?? 10, 60_000),
  };
}

async function getConversation(pageId: number, fanId: string) {
  const [conversation] = await listPageDmConversationsByPlatformConversationIds(appContext.db, {
    platformAccountId: pageId,
    platformConversationIds: [fanId],
  });
  return conversation ?? null;
}

/** Seeds conversations for the given fans via a dm_conversations bootstrap. */
async function bootstrapConversations(fans: Array<{ fanId: string; unread: number; headId: string }>) {
  const page = await seedMappedPage();
  const bootstrap = scriptedOfapiClient({
    chats: new Map([
      [0, listPage(
        fans.map((fan) =>
          chatItem({
            fanId: fan.fanId,
            unread: fan.unread,
            lastMessage: { id: fan.headId, createdAt: "2026-06-11T10:00:00+00:00" },
          })
        ),
        false,
      )],
    ]),
  });
  appContext = { ...appContext, ofapi: bootstrap.client };
  const result = await executeOfapiDmConversationsChunk(
    appContext,
    await buildChunkInput(page, "dm_conversations"),
  );
  expect(result.satisfied).toBe(true);
  return page;
}

async function getHealthRow(conversationId: number) {
  const { rows } = await testDb!.pool.query<{
    failure_count: number;
    error_class: string | null;
    last_error: string | null;
    next_retry_at: Date | null;
    quarantine_until: Date | null;
    preferred_page_limit: number | null;
  }>(
    `select failure_count, error_class, last_error, next_retry_at, quarantine_until, preferred_page_limit
     from page_dm_message_sync_health
     where conversation_id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }

  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { ofapiDmSyncEnabled: true });
});

describe("OFAPI DM messages per-conversation circuit breaker", () => {
  it("isolates a poison timeout chat: failure recorded, pin cleared, next candidate proceeds, run completes", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // FAN_A (higher unread → selected first) is the poison chat; FAN_B is fine.
    const page = await bootstrapConversations([
      { fanId: FAN_A, unread: 5, headId: "2000300" },
      { fanId: FAN_B, unread: 0, headId: "2000280" },
    ]);

    const { client, messageCalls } = scriptedOfapiClient({
      messagesByChat: {
        // Default fetch + both adaptive probes all time out.
        [FAN_A]: [
          { error: vendorTimeoutError(FAN_A) },
          { error: vendorTimeoutError(FAN_A) },
          { error: vendorTimeoutError(FAN_A) },
        ],
        [FAN_B]: [
          {
            page: listPage([
              messageItem({ id: "2000280", fanId: FAN_B, createdAt: "2026-06-11T09:00:00+00:00" }),
            ], false),
          },
        ],
      },
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );

    // The poison chat did not kill the chunk: FAN_B completed and the stream
    // exhausted (FAN_A is inside its backoff window, so it is not eligible).
    expect(result.satisfied).toBe(true);
    expect(result.stats?.skippedQuarantined).toBe(1);
    expect(result.stats?.perChatFailures).toBe(1);

    // Probe ladder on the poison chat: 100 (single attempt) → 20 → 5, the
    // probes as single attempts.
    const fanACalls = messageCalls.filter((call) => call.chatId === FAN_A);
    expect(fanACalls.map((call) => call.limit)).toEqual([100, 20, 5]);
    expect(fanACalls.map((call) => call.retries)).toEqual([0, 0, 0]);

    // The healthy chat proceeded and completed.
    const conversationB = await getConversation(page.id, FAN_B);
    expect(conversationB!.messageCoverageStatus).toBe("complete");
    expect(conversationB!.storedMessageCount).toBe(1);

    // Failure bookkeeping for the poison chat: one failure (the probes are
    // part of the same attempt cycle), backoff ~5 minutes, no quarantine yet.
    const conversationA = await getConversation(page.id, FAN_A);
    const health = await getHealthRow(conversationA!.id);
    expect(health).not.toBeNull();
    expect(health!.failure_count).toBe(1);
    expect(health!.error_class).toBe("vendor_opaque_timeout");
    expect(health!.last_error).toContain("aborted");
    expect(health!.quarantine_until).toBeNull();
    const backoffMs = health!.next_retry_at!.getTime() - Date.now();
    expect(backoffMs).toBeGreaterThan(3 * 60 * 1000);
    expect(backoffMs).toBeLessThanOrEqual(5 * 60 * 1000);

    // The pin was cleared — the next run will NOT lead with the poison chat.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_messages");
    expect((checkpoint?.state as Record<string, unknown>).currentConversationId).toBeNull();
    // Full success stamped despite the quarantined chat (exhaustion reached).
    expect(checkpoint?.cursorLastSucceededRunId).not.toBeNull();
  });

  it("quarantines a conversation on its 4th failure", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await bootstrapConversations([
      { fanId: FAN_A, unread: 3, headId: "2000300" },
    ]);
    const conversationA = await getConversation(page.id, FAN_A);

    // Three prior failures, far enough in the past that every backoff window
    // has lapsed (re-admission is implicit).
    const past = new Date(Date.now() - 7 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) {
      await recordConversationSyncFailure(appContext.db, {
        conversationId: conversationA!.id,
        platformAccountId: page.id,
        errorClass: "vendor_opaque_timeout",
        errorMessage: "The operation was aborted due to timeout",
        now: past,
      });
    }

    const { client } = scriptedOfapiClient({
      messagesByChat: {
        [FAN_A]: [
          { error: vendorTimeoutError(FAN_A) },
          { error: vendorTimeoutError(FAN_A) },
          { error: vendorTimeoutError(FAN_A) },
        ],
      },
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(result.stats?.skippedQuarantined).toBe(1);

    const health = await getHealthRow(conversationA!.id);
    expect(health!.failure_count).toBe(4);
    expect(health!.quarantine_until).not.toBeNull();
    const quarantineMs = health!.quarantine_until!.getTime() - Date.now();
    expect(quarantineMs).toBeGreaterThan(5 * 60 * 60 * 1000);
    expect(quarantineMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it("keeps 401 page-level: chunk fails, no per-chat quarantine, pin retained", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await bootstrapConversations([
      { fanId: FAN_A, unread: 2, headId: "2000300" },
    ]);

    const { client, messageCalls } = scriptedOfapiClient({
      messagesByChat: {
        [FAN_A]: [
          {
            error: new OfapiApiError(
              `OFAPI request failed: GET /${OFAPI_ACCOUNT}/chats/${FAN_A}/messages: status 401`,
              401,
              "{\"error\":\"unauthorized\"}",
            ),
          },
        ],
      },
    });
    appContext = { ...appContext, ofapi: client };

    await expect(executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    )).rejects.toThrow("status 401");

    // No probes for auth errors — exactly one call.
    expect(messageCalls).toHaveLength(1);

    // No breaker row: auth is an account/page condition, never chat-local.
    const conversationA = await getConversation(page.id, FAN_A);
    expect(await getHealthRow(conversationA!.id)).toBeNull();

    // The pin survives so the executor-level retry resumes the same chat.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_messages");
    expect((checkpoint?.state as Record<string, unknown>).currentConversationId)
      .toBe(conversationA!.id);
  });

  it("recovers via the limit-5 probe and keeps the smaller limit for the rest of the run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await bootstrapConversations([
      { fanId: FAN_A, unread: 1, headId: "2000300" },
    ]);

    const { client, messageCalls } = scriptedOfapiClient({
      messagesByChat: {
        [FAN_A]: [
          // Default limit and the limit-20 probe time out…
          { error: vendorTimeoutError(FAN_A) },
          { error: vendorTimeoutError(FAN_A) },
          // …the limit-5 probe succeeds with more history behind it…
          {
            page: listPage([
              messageItem({ id: "2000300", fanId: FAN_A, createdAt: "2026-06-11T10:00:00+00:00" }),
              messageItem({ id: "2000299", fanId: FAN_A, createdAt: "2026-06-11T09:59:00+00:00" }),
            ], true),
          },
          // …and the follow-up page keeps limit 5 (inclusive cursor echo).
          {
            page: listPage([
              messageItem({ id: "2000299", fanId: FAN_A, createdAt: "2026-06-11T09:59:00+00:00" }),
              messageItem({ id: "2000298", fanId: FAN_A, createdAt: "2026-06-11T09:58:00+00:00" }),
            ], false),
          },
        ],
      },
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(result.stats?.perChatFailures).toBe(0);
    expect(result.stats?.skippedQuarantined).toBe(0);

    // Exact plumb-through: 100 (default retry budget) → 20 (single attempt)
    // → 5 (single attempt) → 5 (back on the default retry budget).
    expect(messageCalls.map((call) => call.limit)).toEqual([100, 20, 5, 5]);
    expect(messageCalls.map((call) => call.retries)).toEqual([0, 0, 0, undefined]);
    expect(messageCalls.map((call) => call.firstId)).toEqual([null, null, null, "2000299"]);

    // The conversation completed normally — failure bookkeeping is clean but
    // the learned working limit is sticky (0087).
    const conversationA = await getConversation(page.id, FAN_A);
    expect(conversationA!.messageCoverageStatus).toBe("complete");
    expect(conversationA!.storedMessageCount).toBe(3);
    const healthRow = await getHealthRow(conversationA!.id);
    expect(healthRow).toMatchObject({ failure_count: 0, preferred_page_limit: 5 });
    expect(healthRow!.next_retry_at).toBeNull();
    expect(healthRow!.quarantine_until).toBeNull();

    // A later run starts the chat AT the learned limit — no 100-limit
    // timeout tax, no re-probe.
    await testDb.pool.query(
      `update page_dm_threads
         set last_message_id = '2000301', unread_count = 1,
             last_message_at = now()
       where id = $1`,
      [conversationA!.id],
    );
    const secondRun = scriptedOfapiClient({
      messagesByChat: {
        [FAN_A]: [
          {
            page: listPage([
              messageItem({ id: "2000301", fanId: FAN_A, createdAt: "2026-06-11T10:01:00+00:00" }),
              messageItem({ id: "2000300", fanId: FAN_A, createdAt: "2026-06-11T10:00:00+00:00" }),
            ], false),
          },
        ],
      },
    });
    appContext = { ...appContext, ofapi: secondRun.client };
    const secondResult = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(secondResult.satisfied).toBe(true);
    expect(secondRun.messageCalls.map((call) => call.limit)).toEqual([5]);
  });

  it("clears a pinned conversation that is inside its breaker window (deploy unwedge)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await bootstrapConversations([
      { fanId: FAN_A, unread: 5, headId: "2000300" },
      { fanId: FAN_B, unread: 0, headId: "2000280" },
    ]);
    const conversationA = await getConversation(page.id, FAN_A);

    // The poison chat is inside a fresh backoff window…
    await recordConversationSyncFailure(appContext.db, {
      conversationId: conversationA!.id,
      platformAccountId: page.id,
      errorClass: "vendor_opaque_timeout",
      errorMessage: "The operation was aborted due to timeout",
    });
    // …and the checkpoint still pins it (the pre-breaker wedge state).
    await upsertCheckpoint(appContext.db, {
      platformAccountId: page.id,
      stream: "dm_messages",
      state: {
        version: 1,
        currentConversationId: conversationA!.id,
        currentPlatformConversationId: FAN_A,
        currentBeforeMessageId: null,
        currentMode: "backfill",
      },
    });

    const { client, messageCalls } = scriptedOfapiClient({
      messagesByChat: {
        [FAN_B]: [
          {
            page: listPage([
              messageItem({ id: "2000280", fanId: FAN_B, createdAt: "2026-06-11T09:00:00+00:00" }),
            ], false),
          },
        ],
      },
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(result.stats?.skippedQuarantined).toBe(1);

    // The excluded pin was never fetched; the healthy candidate ran instead.
    expect(messageCalls.every((call) => call.chatId === FAN_B)).toBe(true);
    const conversationB = await getConversation(page.id, FAN_B);
    expect(conversationB!.messageCoverageStatus).toBe("complete");

    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_messages");
    expect((checkpoint?.state as Record<string, unknown>).currentConversationId).toBeNull();
  });
});
