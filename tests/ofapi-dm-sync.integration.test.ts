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
  setPageOfapiAccountId,
  startSyncRun,
  upsertCheckpoint,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  executeOfapiDmConversationsChunk,
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

function fakeOfapiClient(pages: FakePages) {
  const listChats = vi.fn(async (_context: unknown, _accountId: string, params: { offset?: number }) => {
    const page = pages.chats.get(params.offset ?? 0);
    if (!page) {
      throw new Error(`Unexpected listChats offset ${params.offset ?? 0}`);
    }
    return page;
  });
  const listChatMessages = vi.fn(async () => {
    throw new Error("List Chats must not invoke the retired per-chat history crawler");
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
  if (!model) {
    throw new Error(`model ${label} was not created`);
  }
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label,
  });
  if (!page) {
    throw new Error(`page ${label} was not created`);
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function buildChunkInput(page: { id: number }, stream: "dm_conversations", options?: {
  maxRequests?: number;
}) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream,
    trigger: "manual",
  });
  if (!run) {
    throw new Error(`sync run for page ${page.id} was not created`);
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
  it("bootstraps the full chats list without self-seeding the retired history crawler", async (context) => {
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

    // Head evidence never creates paid history work by itself. Only durable
    // OF mirror intentions may do that after S1.
    const messagesStates = await listPageSyncStates(appContext.db, {
      pageId: page.id,
      streams: ["dm_messages"],
    });
    expect(messagesStates).toEqual([]);

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
    const { client, listChats } = fakeOfapiClient({ chats: new Map() });

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

    const first = fakeOfapiClient({ chats });
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
    const second = fakeOfapiClient({ chats });
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

describe("OFAPI DM sync gating + admin controls", () => {
  it("keeps List Chats available while every legacy history control stays retired", async (context) => {
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

    // Live List Chats remains controllable.
    const boss = { send: vi.fn(async () => null) };
    const resumed = await resumeSyncBlock(appContext, boss as never, {
      pageLabel: page.label,
      block: "messages_live",
    });
    expect(resumed.accepted).toBe(true);
    expect(resumed.requests.map((request) => request.stream)).toEqual(["dm_conversations"]);

    // History actions fail before writes/wakeups and the state row stays a
    // durable retired tombstone.
    await expect(triggerSyncBlock(appContext, boss as never, {
      pageLabel: page.label,
      block: "messages_history",
    })).rejects.toThrow(/permanently retired/i);
    await expect(resumeSyncBlock(appContext, boss as never, {
      pageLabel: page.label,
      block: "messages_history",
    })).rejects.toThrow(/permanently retired/i);
    await expect(pauseSyncBlock(appContext, {
      pageLabel: page.label,
      block: "messages_history",
    })).rejects.toThrow(/permanently retired/i);
    expect(boss.send).toHaveBeenCalledTimes(1);

    const messagesStates = await listPageSyncStates(appContext.db, {
      pageId: page.id,
      streams: ["dm_messages"],
    });
    expect(messagesStates).toEqual([]);
  });
});
