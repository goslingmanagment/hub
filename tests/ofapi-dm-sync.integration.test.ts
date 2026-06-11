import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  getOfapiCreditState,
  listPageDmConversationsByPlatformConversationIds,
  listPageSyncStates,
  recordOfapiCreditUsage,
  refreshPageDmConversationWindow,
  setPageOfapiAccountId,
  startSyncRun,
  upsertCheckpoint,
  upsertPageDmConversation,
  upsertPageDmMessages,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  executeOfapiDmConversationsChunk,
  executeOfapiDmMessagesChunk,
} from "../apps/runtime/src/services/sync/ofapi-dm-sync.ts";
import { pauseDisabledOnlyFansDmPollingForPage } from "../apps/runtime/src/services/sync/onlyfans-dm-polling.ts";
import { pauseSyncBlock, resumeSyncBlock, triggerSyncBlock } from "../apps/runtime/src/services/sync-blocks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const OFAPI_ACCOUNT = "acct_sync_test";
const FAN_A = "1000005";
const FAN_B = "1000006";
const MODEL_USER_ID = 555000111;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

type FakePages = {
  chats: Map<number, OfapiListPage>;
  messages: Array<{ expectFirstId: string | null; page: OfapiListPage }>;
};

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
  username?: string;
  name?: string;
  unread?: number;
  lastMessage?: {
    id: string;
    text?: string;
    createdAt: string;
    fromFan?: boolean;
  } | null;
}): Record<string, unknown> {
  return {
    unreadMessagesCount: input.unread ?? 0,
    lastMessage: input.lastMessage
      ? {
        id: Number(input.lastMessage.id),
        text: `<p>${input.lastMessage.text ?? "last message"}</p>`,
        createdAt: input.lastMessage.createdAt,
        fromUser: {
          id: input.lastMessage.fromFan === false ? MODEL_USER_ID : Number(input.fanId),
          _view: "s",
        },
      }
      : null,
    fan: {
      id: Number(input.fanId),
      name: input.name ?? `Fan ${input.fanId}`,
      username: input.username ?? `fan${input.fanId}`,
      displayName: "",
    },
  };
}

function messageItem(input: {
  id: string;
  fanId: string;
  text?: string;
  createdAt: string;
  sentByMe?: boolean;
  isTip?: boolean;
  price?: number;
}): Record<string, unknown> {
  const sentByMe = input.sentByMe ?? false;
  return {
    id: Number(input.id),
    text: `<p>${input.text ?? `message ${input.id}`}</p>`,
    createdAt: input.createdAt,
    isSentByMe: sentByMe,
    fromUser: { id: sentByMe ? MODEL_USER_ID : Number(input.fanId), _view: "s" },
    isTip: input.isTip ?? false,
    price: input.price ?? 0,
    mediaCount: 0,
    media: [],
  };
}

function fakeOfapiClient(pages: FakePages) {
  let messageCall = 0;
  const listChats = vi.fn(async (_context: unknown, _accountId: string, params: { offset?: number }) => {
    const page = pages.chats.get(params.offset ?? 0);
    if (!page) {
      throw new Error(`Unexpected listChats offset ${params.offset ?? 0}`);
    }
    return page;
  });
  const listChatMessages = vi.fn(async (
    _context: unknown,
    _accountId: string,
    _chatId: string,
    params: { firstId?: string | null },
  ) => {
    const scripted = pages.messages[messageCall];
    if (!scripted) {
      throw new Error(`Unexpected listChatMessages call #${messageCall + 1}`);
    }
    messageCall += 1;
    expect(params.firstId ?? null).toBe(scripted.expectFirstId);
    return scripted.page;
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
  return { client, listChats, listChatMessages };
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

async function seedMappedPage(label = "lora-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label,
  });
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

async function getStoredMessages(conversationId: number) {
  const { rows } = await testDb!.pool.query<{
    platform_message_id: string;
    sender_role: string;
    content: string;
    total_tip_amount_cents: number;
  }>(
    `select platform_message_id, sender_role, content, total_tip_amount_cents
     from page_dm_messages where conversation_id = $1
     order by created_at desc, platform_message_id desc`,
    [conversationId],
  );
  return rows;
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

describe("OFAPI DM conversations sync", () => {
  it("bootstraps the full chats list, seeds conversations, and requests a dm_messages follow-up", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const { client, listChats } = fakeOfapiClient({
      chats: new Map([
        [0, listPage([
          chatItem({
            fanId: FAN_A,
            unread: 2,
            lastMessage: { id: "1000300", createdAt: "2026-06-11T10:00:00+00:00" },
          }),
          chatItem({
            fanId: FAN_B,
            unread: 0,
            lastMessage: { id: "1000280", createdAt: "2026-06-11T09:00:00+00:00", fromFan: false },
          }),
        ], true)],
        [2, listPage([
          chatItem({ fanId: "1000007", unread: 0, lastMessage: null }),
        ], false)],
      ]),
      messages: [],
    });
    appContext = { ...appContext, ofapi: client };

    const input = await buildChunkInput(page, "dm_conversations");
    const result = await executeOfapiDmConversationsChunk(appContext, input);

    expect(result.satisfied).toBe(true);
    expect(result.stats?.fullSweepCompleted).toBe(true);
    expect(listChats).toHaveBeenCalledTimes(2);

    const conversationA = await getConversation(page.id, FAN_A);
    expect(conversationA).not.toBeNull();
    expect(conversationA!.fanId).not.toBeNull();
    expect(conversationA!.unreadCount).toBe(2);
    expect(conversationA!.lastMessageId).toBe("1000300");
    expect(conversationA!.lastMessageSenderRole).toBe("fan");
    expect(conversationA!.messageCoverageStatus).toBe("pending_backfill");
    expect(conversationA!.metadata.provider).toBe("ofapi");

    const conversationB = await getConversation(page.id, FAN_B);
    expect(conversationB!.unreadCount).toBe(0);
    expect(conversationB!.lastMessageSenderRole).toBe("model");

    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_conversations");
    const state = checkpoint?.state as Record<string, unknown>;
    expect(state.mode).toBe("ofapi");
    expect(state.bootstrapCompletedAt).toBeTruthy();

    // Pending-backfill conversations trigger the dm_messages follow-up request.
    const [messagesState] = await listPageSyncStates(appContext.db, {
      pageId: page.id,
      streams: ["dm_messages"],
    });
    expect(messagesState!.requestSeq).toBeGreaterThan(0);

    // Credits were recorded from _meta on both requests.
    const credit = await getOfapiCreditState(appContext.db);
    expect(credit.spentToday).toBe(2);
    expect(credit.lastBalance).toBe(20_000);
  });

  it("skips reconcile until due, then corrects unread/head drift without regressing newer heads", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    // Bootstrap already done; reconcile happened recently.
    const recentIso = new Date(Date.now() - 60 * 1000).toISOString();
    await upsertCheckpoint(appContext.db, {
      platformAccountId: page.id,
      stream: "dm_conversations",
      state: {
        version: 1,
        mode: "ofapi",
        offset: 0,
        pageCount: 1,
        bootstrapCompletedAt: recentIso,
        lastReconcileAt: recentIso,
      },
    });

    const { client, listChats } = fakeOfapiClient({
      chats: new Map([
        [0, listPage([
          chatItem({
            fanId: FAN_A,
            unread: 5,
            lastMessage: { id: "1000350", createdAt: "2026-06-11T11:00:00+00:00" },
          }),
        ], false)],
      ]),
      messages: [],
    });
    appContext = { ...appContext, ofapi: client };

    const notDue = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(notDue.satisfied).toBe(true);
    expect(notDue.stats?.skipped).toBe("reconcile_not_due");
    expect(listChats).not.toHaveBeenCalled();

    // Seed an existing conversation whose head is NEWER than what the chats
    // list will report (a webhook projection got there first).
    const staleIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await upsertCheckpoint(appContext.db, {
      platformAccountId: page.id,
      stream: "dm_conversations",
      state: {
        version: 1,
        mode: "ofapi",
        offset: 0,
        pageCount: 1,
        bootstrapCompletedAt: staleIso,
        lastReconcileAt: staleIso,
      },
    });
    const newerHeadAt = new Date("2026-06-11T12:00:00+00:00");
    await upsertPageDmConversation(appContext.db, {
      platformAccountId: page.id,
      fanId: null,
      platformConversationId: FAN_A,
      partnerPlatformUserId: FAN_A,
      partnerUsername: "fan005",
      partnerDisplayName: "Fan A",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "1000400",
      lastUnreadMessageId: "1000400",
      lastMessageAt: newerHeadAt,
      lastMessageSenderId: FAN_A,
      lastMessageSenderRole: "fan",
      lastMessagePreview: "newer from webhook",
      lastSeenGeneration: null,
    });

    const reconciled = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(reconciled.satisfied).toBe(true);
    expect(reconciled.stats?.mode).toBe("reconcile");
    expect(listChats).toHaveBeenCalledTimes(1);

    const conversation = await getConversation(page.id, FAN_A);
    // Unread is authoritative from the chats list…
    expect(conversation!.unreadCount).toBe(5);
    // …but the newer projected head is never regressed.
    expect(conversation!.lastMessageId).toBe("1000400");
    expect(conversation!.lastMessageAt!.toISOString()).toBe(newerHeadAt.toISOString());
  });

  it("yields gracefully on the daily credit budget and the balance floor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const { client, listChats } = fakeOfapiClient({ chats: new Map(), messages: [] });

    // Daily budget exhausted.
    appContext = {
      ...createTestAppContext(testDb, { ofapiDmSyncEnabled: true, ofapiDmDailyCreditBudget: 2 }),
      ofapi: client,
    };
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 2, balance: 20_000 });
    const budgetBlocked = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(budgetBlocked.satisfied).toBe(false);
    expect(budgetBlocked.stats?.ofapiBudgetBlock).toBe("ofapi_daily_credit_budget");
    expect(budgetBlocked.continuationRetryAt).toBeInstanceOf(Date);
    expect(listChats).not.toHaveBeenCalled();

    // Balance below the floor.
    appContext = {
      ...createTestAppContext(testDb, { ofapiDmSyncEnabled: true, ofapiCreditFloor: 1000 }),
      ofapi: client,
    };
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 0, balance: 400 });
    const floorBlocked = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(floorBlocked.satisfied).toBe(false);
    expect(floorBlocked.stats?.ofapiBudgetBlock).toBe("ofapi_credit_floor");
    expect(listChats).not.toHaveBeenCalled();
  });

  it("caps OFAPI requests per chunk run and resumes the bootstrap from the checkpoint", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const chats = new Map([
      [0, listPage([
        chatItem({
          fanId: FAN_A,
          unread: 1,
          lastMessage: { id: "1000300", createdAt: "2026-06-11T10:00:00+00:00" },
        }),
      ], true)],
      [1, listPage([
        chatItem({
          fanId: FAN_B,
          unread: 0,
          lastMessage: { id: "1000280", createdAt: "2026-06-11T09:00:00+00:00", fromFan: false },
        }),
      ], false)],
    ]);

    const first = fakeOfapiClient({ chats, messages: [] });
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiDmSyncEnabled: true,
        ofapiDmBootstrapMaxRequestsPerRun: 1,
      }),
      ofapi: first.client,
    };
    const partial = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(partial.satisfied).toBe(false);
    expect(partial.stats?.ofapiBudgetBlock).toBe("ofapi_request_budget");
    expect(first.listChats).toHaveBeenCalledTimes(1);
    expect(await getConversation(page.id, FAN_A)).not.toBeNull();
    expect(await getConversation(page.id, FAN_B)).toBeNull();

    // Next chunk run continues from the persisted offset and completes.
    const second = fakeOfapiClient({ chats, messages: [] });
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiDmSyncEnabled: true,
        ofapiDmBootstrapMaxRequestsPerRun: 1,
      }),
      ofapi: second.client,
    };
    const completed = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(completed.satisfied).toBe(true);
    expect(completed.stats?.fullSweepCompleted).toBe(true);
    expect(second.listChats).toHaveBeenCalledTimes(1);
    expect(second.listChats.mock.calls[0]![2]).toMatchObject({ offset: 1 });
    expect(await getConversation(page.id, FAN_B)).not.toBeNull();
  });
});

describe("OFAPI DM messages sync", () => {
  async function seedConversationViaBootstrap(lastMessageId: string, lastMessageAt: string, unread = 1) {
    const page = await seedMappedPage();
    const bootstrap = fakeOfapiClient({
      chats: new Map([
        [0, listPage([
          chatItem({
            fanId: FAN_A,
            unread,
            lastMessage: { id: lastMessageId, createdAt: lastMessageAt },
          }),
        ], false)],
      ]),
      messages: [],
    });
    appContext = { ...appContext, ofapi: bootstrap.client };
    const result = await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    );
    expect(result.satisfied).toBe(true);
    return page;
  }

  it("backfills with the inclusive first_id cursor down to history exhaustion", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedConversationViaBootstrap("1000300", "2026-06-11T10:00:00+00:00");
    const { client, listChatMessages } = fakeOfapiClient({
      chats: new Map(),
      messages: [
        {
          expectFirstId: null,
          page: listPage([
            messageItem({ id: "1000300", fanId: FAN_A, createdAt: "2026-06-11T10:00:00+00:00" }),
            messageItem({ id: "1000299", fanId: FAN_A, createdAt: "2026-06-11T09:59:00+00:00", sentByMe: true }),
            messageItem({ id: "1000298", fanId: FAN_A, createdAt: "2026-06-11T09:58:00+00:00" }),
          ], true),
        },
        {
          expectFirstId: "1000298",
          page: listPage([
            // Inclusive cursor echo — must be deduped, not double-stored.
            messageItem({ id: "1000298", fanId: FAN_A, createdAt: "2026-06-11T09:58:00+00:00" }),
            messageItem({
              id: "1000297",
              fanId: FAN_A,
              createdAt: "2026-06-11T09:57:00+00:00",
              isTip: true,
              price: 5,
            }),
            messageItem({ id: "1000296", fanId: FAN_A, createdAt: "2026-06-11T09:56:00+00:00", sentByMe: true }),
          ], false),
        },
      ],
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(listChatMessages).toHaveBeenCalledTimes(2);

    const conversation = await getConversation(page.id, FAN_A);
    expect(conversation!.messageCoverageStatus).toBe("complete");
    expect(conversation!.messageBackfillComplete).toBe(true);
    expect(conversation!.storedMessageCount).toBe(5);
    expect(conversation!.newestStoredMessageId).toBe("1000300");
    expect(conversation!.oldestStoredMessageId).toBe("1000296");

    const messages = await getStoredMessages(conversation!.id);
    expect(messages.map((message) => message.platform_message_id)).toEqual([
      "1000300",
      "1000299",
      "1000298",
      "1000297",
      "1000296",
    ]);
    expect(messages[1]!.sender_role).toBe("model");
    expect(messages[3]!.total_tip_amount_cents).toBe(500);
  });

  it("tops up a diverged head incrementally and stops on overlap with stored messages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedConversationViaBootstrap("1000300", "2026-06-11T10:00:00+00:00");

    // First: complete a small backfill so the conversation holds 1000300.
    const backfill = fakeOfapiClient({
      chats: new Map(),
      messages: [
        {
          expectFirstId: null,
          page: listPage([
            messageItem({ id: "1000300", fanId: FAN_A, createdAt: "2026-06-11T10:00:00+00:00" }),
          ], false),
        },
      ],
    });
    appContext = { ...appContext, ofapi: backfill.client };
    expect((await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    )).satisfied).toBe(true);

    // Reconcile reports a newer head → head-stale candidate.
    const reconcile = fakeOfapiClient({
      chats: new Map([
        [0, listPage([
          chatItem({
            fanId: FAN_A,
            unread: 2,
            lastMessage: { id: "1000310", createdAt: "2026-06-11T11:00:00+00:00" },
          }),
        ], false)],
      ]),
      messages: [],
    });
    const staleIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_conversations");
    await upsertCheckpoint(appContext.db, {
      platformAccountId: page.id,
      stream: "dm_conversations",
      state: {
        ...(checkpoint?.state as Record<string, unknown>),
        lastReconcileAt: staleIso,
      },
    });
    appContext = { ...appContext, ofapi: reconcile.client };
    expect((await executeOfapiDmConversationsChunk(
      appContext,
      await buildChunkInput(page, "dm_conversations"),
    )).satisfied).toBe(true);

    // Incremental top-up: newest page overlaps the stored 1000300 and stops.
    const topUp = fakeOfapiClient({
      chats: new Map(),
      messages: [
        {
          expectFirstId: null,
          page: listPage([
            messageItem({ id: "1000310", fanId: FAN_A, createdAt: "2026-06-11T11:00:00+00:00" }),
            messageItem({ id: "1000300", fanId: FAN_A, createdAt: "2026-06-11T10:00:00+00:00" }),
            messageItem({ id: "1000290", fanId: FAN_A, createdAt: "2026-06-11T08:00:00+00:00" }),
          ], true),
        },
      ],
    });
    appContext = { ...appContext, ofapi: topUp.client };
    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(topUp.listChatMessages).toHaveBeenCalledTimes(1);

    const conversation = await getConversation(page.id, FAN_A);
    expect(conversation!.newestStoredMessageId).toBe("1000310");
    // Overlap completes the incremental pass; coverage stays complete.
    expect(conversation!.messageCoverageStatus).toBe("complete");
    const messages = await getStoredMessages(conversation!.id);
    expect(messages.map((message) => message.platform_message_id)).toEqual([
      "1000310",
      "1000300",
      "1000290",
    ]);
  });

  it("caps a backfill at the retention tier and marks it partial_window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Regular fan → 200-message retention. Stage stored count just below the
    // cap so a single page crosses it.
    const page = await seedConversationViaBootstrap("1201000", "2026-06-11T10:00:00+00:00");
    const conversation = await getConversation(page.id, FAN_A);
    const seeded: Parameters<typeof upsertPageDmMessages>[1] = [];
    for (let index = 0; index < 198; index += 1) {
      const id = 1201000 - index;
      seeded.push({
        conversationId: conversation!.id,
        platformAccountId: page.id,
        platformMessageId: String(id),
        senderPlatformUserId: FAN_A,
        senderRole: "fan",
        createdAt: new Date(Date.parse("2026-06-11T10:00:00+00:00") - index * 60_000),
        content: `seeded ${id}`,
        totalTipAmountCents: 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      });
    }
    await upsertPageDmMessages(appContext.db, seeded);
    await refreshPageDmConversationWindow(appContext.db, { conversationId: conversation!.id });

    const oldestSeeded = String(1201000 - 197);
    const { client, listChatMessages } = fakeOfapiClient({
      chats: new Map(),
      messages: [
        {
          expectFirstId: oldestSeeded,
          page: listPage([
            messageItem({ id: oldestSeeded, fanId: FAN_A, createdAt: "2026-06-11T06:00:00+00:00" }),
            messageItem({ id: "1200500", fanId: FAN_A, createdAt: "2026-06-11T05:00:00+00:00" }),
            messageItem({ id: "1200499", fanId: FAN_A, createdAt: "2026-06-11T04:59:00+00:00" }),
            messageItem({ id: "1200498", fanId: FAN_A, createdAt: "2026-06-11T04:58:00+00:00" }),
          ], true),
        },
      ],
    });
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiDmMessagesChunk(
      appContext,
      await buildChunkInput(page, "dm_messages"),
    );
    expect(result.satisfied).toBe(true);
    expect(listChatMessages).toHaveBeenCalledTimes(1);

    const capped = await getConversation(page.id, FAN_A);
    expect(capped!.messageCoverageStatus).toBe("partial_window");
    // Finalize prunes to the 200-message retention tier.
    expect(capped!.storedMessageCount).toBe(200);
  });
});

describe("OFAPI DM sync gating + admin controls", () => {
  it("does not force-pause DM streams for OFAPI-mapped pages, and admin block controls work", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();

    // OFAPI-eligible page is exempt from the polling force-pause…
    expect(await pauseDisabledOnlyFansDmPollingForPage(appContext, page.id)).toBe(false);

    // …but with the flag off the parked-poller pause still applies.
    const offContext = { ...createTestAppContext(testDb!, { ofapiDmSyncEnabled: false }), ofapi: appContext.ofapi };
    expect(await pauseDisabledOnlyFansDmPollingForPage(offContext, page.id)).toBe(true);

    // Admin block controls target the OnlyFans DM streams (D3: no new plumbing).
    const boss = { send: vi.fn(async () => null) };
    const resumed = await resumeSyncBlock(appContext, boss as never, {
      pageLabel: page.label,
      block: "messages_live",
    });
    expect(resumed.accepted).toBe(true);
    expect(resumed.requests.map((request) => request.stream)).toEqual(["dm_conversations"]);

    const triggered = await triggerSyncBlock(appContext, boss as never, {
      pageLabel: page.label,
      block: "messages_history",
    });
    expect(triggered.accepted).toBe(true);
    expect(triggered.requests.map((request) => request.stream)).toEqual(["dm_messages"]);

    const paused = await pauseSyncBlock(appContext, {
      pageLabel: page.label,
      block: "messages_history",
    });
    expect(paused.accepted).toBe(true);
    const [messagesState] = await listPageSyncStates(appContext.db, {
      pageId: page.id,
      streams: ["dm_messages"],
    });
    expect(messagesState!.status).toBe("paused");
  });
});
