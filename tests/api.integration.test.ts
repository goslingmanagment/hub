import assert from "node:assert/strict";
import { fixtureUserId } from "./helpers/user-identity.ts";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { KERNEL_CONTRACT_HASH } from "@agency_hub_core/contracts";
import {
  createOnlyFansPage,
  createUser,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  ensureSyncPage,
  finishSyncRequestAttempt,
  finishSyncRun,
  getNotificationIncidentByKey,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
  openNotificationIncident,
  recalculateFanPageSpend,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  refreshPageDmConversationWindow,
  storeFanslySession,
  syncRateLimits,
  pageSyncStates as pageSyncStateRows,
  startSyncRun,
  updatePageMetadata,
  upsertFanPage,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
  unassignPageFromUser,
} from "../apps/runtime/src/services/auth.ts";
import {
  issueChatterDeviceToken,
  issueDeviceTokenForUserId,
} from "./helpers/device-credentials.ts";
import { getModelRevenueReport, getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { ensureSyncQueues } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedFormerFanslyRows } from "./helpers/fansly-legacy-rows.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";
import type * as UrgentModule from "../apps/runtime/src/sync/requests/urgent.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// The owner's `/account/me` levers of a Fansly page (page verify, a credentials
// or proxy change) go through the page's engine actor; no actor runs in this
// file, so a case that needs its answer sets it here. Unset, the real queue
// answers (a page the engine does not run gets no work).
// tests/sync-account-routing.integration.test.ts runs the levers against a
// real actor.
const engineAnswer = vi.hoisted(() => ({
  answer: null as null | ((input: { resource: string; params?: { candidate?: { base?: string } } }) => unknown),
  asked: [] as string[],
}));
vi.mock("../apps/runtime/src/sync/requests/urgent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof UrgentModule>();
  return {
    ...actual,
    enqueueAndWait: async (...args: Parameters<typeof actual.enqueueAndWait>) => {
      if (engineAnswer.answer === null) return actual.enqueueAndWait(...args);
      engineAnswer.asked.push(args[1].resource);
      return engineAnswer.answer(args[1] as never) as Awaited<ReturnType<typeof actual.enqueueAndWait>>;
    },
  };
});

/** The engine's actor answered for the fixture page's own account. */
function engineAnswersFor(account: { accountId: string; username: string }) {
  engineAnswer.answer = (input) => ({
    state: "done",
    workId: engineAnswer.asked.length,
    satisfied: true,
    closeReason: input.resource === "account.verify" ? "verified" : "identity_matches",
    result: {
      accountId: account.accountId,
      username: account.username,
      matches: true,
      proof: { attemptId: engineAnswer.asked.length, sentAt: new Date().toISOString(), base: input.params?.candidate?.base },
    },
  });
}

/** Makes a fixture Fansly page one the engine runs (`live`), with a stored
 *  session and proxy: the only state in which its `/account/me` levers act
 *  since step 4 (S4-19 deleted their legacy fallbacks). */
async function makeEngineLive(testDb: StartedTestDatabase, pageId: number) {
  await saveProxy(createTestAppContext(testDb), pageId, { url: "socks5://127.0.0.1:1080" });
  await storeFanslySession(
    testDb.db,
    pageId,
    JSON.stringify(encryptJson({
      platform: "fansly",
      session: {
        authorization: "verify-token",
      },
    }, Buffer.alloc(32, 7), 1)),
    1,
  );
  await ensureSyncPage(testDb.db, { pageId });
  await setModeDirect(testDb.pool, pageId, "live");
}

/** The page-level latches an older build left open on the page. */
async function openLegacyPageLatches(testDb: StartedTestDatabase, page: { id: number; label: string; platform: string }) {
  for (const [kind, errorCode, errorSummary] of [
    ["auth_blocked", "auth_blocked", "Session expired"],
    ["proxy_failed", "transport", "Proxy unavailable"],
  ] as const) {
    await openNotificationIncident(testDb.db, {
      incidentKey: `${kind}:${page.id}`,
      kind,
      platformAccountId: page.id,
      errorCode,
      errorSummary,
      metadata: {
        pageLabel: page.label,
        platform: page.platform,
      },
    });
  }
}

async function seedPhase2Fixture(testDb: StartedTestDatabase) {
  const lanaModel = await createModel(testDb.db, {
    slug: "lana-model",
    name: "Lana Model",
  });
  const lilyModel = await createModel(testDb.db, {
    slug: "lily-model",
    name: "Lily Model",
  });
  const lanaPage = await createFanslyPage(testDb.db, {
    modelId: lanaModel.id,
    label: "lana",
  });
  const lilyPage = await createFanslyPage(testDb.db, {
    modelId: lilyModel.id,
    label: "lily1",
  });
  await storeFanslySession(testDb.db, lanaPage.id, "encrypted-lana-session", 1);
  await storeFanslySession(testDb.db, lilyPage.id, "encrypted-lily-session", 1);

  await updatePageMetadata(testDb.db, lanaPage.id, {
    platformAccountIdValue: "acct-lana",
    username: "lana_page",
    displayName: "Lana",
    followerCount: 1,
    subscriberCount: 1,
    earningsBalanceMills: 7000n,
    metadata: {},
    syncType: "light",
  });
  await updatePageMetadata(testDb.db, lilyPage.id, {
    platformAccountIdValue: "acct-lily",
    username: "lily_page",
    displayName: "Lily",
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 3000n,
    metadata: {},
    syncType: "light",
  });

  const [fan] = await upsertFans(testDb.db, [{
    platform: "fansly",
    platformUserId: "fan-001",
    username: "buyer",
    displayName: "Buyer One",
  }]);
  assert(fan !== undefined, "Expected fan from the test fixture");

  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lanaPage.id,
    isFollower: true,
    followerSince: new Date("2026-03-02T12:00:00.000Z"),
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-20T12:00:00.000Z"),
    autoRenew: true,
  });
  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lilyPage.id,
    isFollower: false,
    isSubscriber: false,
  });

  await upsertPageFollow(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    platformFollowId: "follow-lana-1",
    followedAt: new Date("2026-03-02T12:00:00.000Z"),
  });
  await upsertPageSubscription(testDb.db, {
    platformSubscriptionId: "sub-lana-1",
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    rawStatus: 3,
    canonicalStatus: "active",
    priceMills: 5000n,
    renewPriceMills: 5000n,
    autoRenew: true,
    sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
    endsAt: new Date("2026-03-20T12:00:00.000Z"),
  });

  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-subscription",
    rawType: 15001,
    canonicalType: "subscription",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 5000n,
    sourceDestinationAmountMills: 5000n,
    creatorNetAmountMills: 5000n,
    occurredAt: new Date("2026-03-05T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "pending",
    rawStatus: 1,
    grossAmountMills: 2000n,
    sourceDestinationAmountMills: 2000n,
    creatorNetAmountMills: 2000n,
    occurredAt: new Date("2026-03-06T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-reversal",
    rawType: 16013,
    canonicalType: "payout_reversal",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 900n,
    sourceDestinationAmountMills: 900n,
    creatorNetAmountMills: 900n,
    occurredAt: new Date("2026-03-07T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lilyPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-lily-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 3000n,
    sourceDestinationAmountMills: 3000n,
    creatorNetAmountMills: 3000n,
    occurredAt: new Date("2026-03-06T13:00:00.000Z"),
  });

  await rebuildRevenueRollups(testDb.db, lanaPage.id);
  await rebuildRevenueRollups(testDb.db, lilyPage.id);
  await rebuildFollowerRollups(testDb.db, lanaPage.id, 1);
  await rebuildSubscriberRollups(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lilyPage.id);

  return {
    lanaModel,
    lanaPage,
    lilyPage,
  };
}

function setCookieHeaderFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value;
}

function sessionCookieFrom(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const value = setCookieHeaderFrom(response);
  return value.split(";")[0]!;
}

async function loginOwnerCookie(server: Awaited<ReturnType<typeof buildApiServer>>) {
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      username: "dima",
      password: "owner-secret",
    },
  });

  return sessionCookieFrom(login);
}

/** The OFAPI vendor's account list for an OnlyFans onboarding: one
 *  connected, identity-verified account. */
function createOnboardingOfapi(input: { accountId: string; username: string; displayName: string }): AppContext["ofapi"] {
  return {
    async listAccounts() {
      return [{
        id: input.accountId,
        username: input.username,
        displayName: input.displayName,
        onlyfansName: input.username,
        onlyfansUserId: `${input.accountId}-user`,
        avatarUrl: null,
      }];
    },
  } as unknown as AppContext["ofapi"];
}

/** The stored summary of a thread whose messages are all read: the window
 *  recounted from the stored rows, coverage `complete`, and the head-read
 *  watermark. (The legacy sync's closing write, gone since step 4 S4-15; the
 *  Fansly Sync Engine writes the same columns from the archive.) */
async function settleCompleteThreadSummary(
  testDb: StartedTestDatabase,
  input: { conversationId: number; headReadAt: Date },
) {
  await refreshPageDmConversationWindow(testDb.db, { conversationId: input.conversationId });
  await testDb.pool.query(
    `update page_dm_threads
        set message_coverage_status = 'complete', message_backfill_complete = true, last_message_sync_at = $2
      where id = $1`,
    [input.conversationId, input.headReadAt],
  );
}

async function setSyncRunTimes(
  testDb: StartedTestDatabase,
  runId: number,
  startedAt: Date,
  finishedAt: Date | null,
) {
  await testDb.pool.query(
    "update sync_runs set started_at = $1, finished_at = $2 where id = $3",
    [startedAt, finishedAt, runId],
  );
}

async function seedMonitorCompletedRun(
  testDb: StartedTestDatabase,
  input: {
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile" | "top_spenders";
    startedAt: Date;
    finishedAt: Date;
    trigger?: string;
    status: "success" | "partial" | "failed" | "skipped";
    errorSummary?: string | null;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    trigger: input.trigger ?? "worker",
  });
  await finishSyncRun(testDb.db, run.id, {
    status: input.status,
    errorSummary: input.errorSummary ?? null,
    stats: {},
  });
  await setSyncRunTimes(testDb, run.id, input.startedAt, input.finishedAt);
  return run;
}

async function seedMonitorRunningRun(
  testDb: StartedTestDatabase,
  input: {
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile" | "top_spenders";
    startedAt: Date;
    trigger?: string;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    trigger: input.trigger ?? "worker",
  });
  await setSyncRunTimes(testDb, run.id, input.startedAt, null);
  return run;
}

async function seedMonitorAttempt(
  testDb: StartedTestDatabase,
  input: {
    runId: number;
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile" | "top_spenders";
    startedAt: Date;
    finishedAt?: Date;
    state: "started" | "success" | "retry" | "failed";
    httpStatus?: number | null;
    failureKind?: "timeout" | "transport" | "http" | "provider" | null;
    errorMessage?: string | null;
    attemptNumber?: number;
    operation?: string;
    provider?: "fansly" | "onlyfans";
    requestShape?: Record<string, unknown>;
    responseShape?: Record<string, unknown>;
  },
) {
  const attempt = await insertSyncRequestAttempt(testDb.db, {
    syncRunId: input.runId,
    platformAccountId: input.pageId,
    provider: input.provider ?? "fansly",
    stream: input.stream,
    operation: input.operation ?? `${input.stream}_request`,
    logicalRequestId: `${input.stream}:${input.runId}:${input.startedAt.toISOString()}`,
    attemptNumber: input.attemptNumber ?? 1,
    requestShape: input.requestShape ?? {},
    startedAt: input.startedAt,
  });
  if (input.state === "started") {
    return attempt;
  }

  await finishSyncRequestAttempt(testDb.db, attempt.id, {
    state: input.state,
    httpStatus: input.httpStatus ?? null,
    failureKind: input.failureKind ?? null,
    errorMessage: input.errorMessage ?? null,
    durationMs: Math.max(1, (input.finishedAt ?? input.startedAt).getTime() - input.startedAt.getTime()),
    responseShape: input.responseShape ?? {},
    finishedAt: input.finishedAt ?? input.startedAt,
  });

  return attempt;
}

/**
 * A page of the legacy page-sync executor in trouble: its account read stuck
 * mid-run, its transactions retrying behind a 429, its subscribers paused,
 * its chat list blocked on the credentials, its top spenders failing on a
 * 5xx. The executor serves OnlyFans only (step 4), so the page is an OnlyFans
 * page; the streams are the executor's.
 */
async function seedSyncMonitorScenario(
  testDb: StartedTestDatabase,
  pageId: number,
  now = new Date(),
) {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000);
  const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  const completedMessageCreatedAt = minutesAgo(80);
  const completedLastMessageAt = minutesAgo(76);
  const completedSyncAt = minutesAgo(75);
  const laggingLastMessageAt = minutesAgo(50);
  const laggingLastMessageSyncAt = minutesAgo(120);
  const pendingConversationAt = minutesAgo(45);
  const excludedConversationAt = minutesAgo(60);
  const authFailedAt = minutesAgo(60);
  const lightRunningStartedAt = hoursAgo(2);
  const lightRunningEventAt = minutesAgo(115);
  const transactionsStartedAt = hoursAgo(3);
  const transactionsFinishedAt = minutesAgo(173);
  const last429At = minutesAgo(178);
  const transactionsEventAt = minutesAgo(177);
  const topSpendersSucceededAt = hoursAgo(30);
  const topSpendersStartedAt = minutesAgo(45);
  const topSpendersFailedAt = minutesAgo(40);
  const last5xxAt = minutesAgo(44);
  const oldLightStartedAt = hoursAgo(30);
  const oldLightFinishedAt = new Date(oldLightStartedAt.getTime() + 2 * 60_000);
  const oldLight429At = new Date(oldLightStartedAt.getTime() + 60_000);
  const retryAt = minutesFromNow(4);

  const [fanA, fanB, fanC, fanD] = await upsertFans(testDb.db, [
    {
      platform: "onlyfans",
      platformUserId: "monitor-fan-a",
      username: "monitor_a",
      displayName: "Monitor A",
    },
    {
      platform: "onlyfans",
      platformUserId: "monitor-fan-b",
      username: "monitor_b",
      displayName: "Monitor B",
    },
    {
      platform: "onlyfans",
      platformUserId: "monitor-fan-c",
      username: "monitor_c",
      displayName: "Monitor C",
    },
    {
      platform: "onlyfans",
      platformUserId: "monitor-fan-d",
      username: "monitor_d",
      displayName: "Monitor D",
    },
  ]);
  assert(fanA !== undefined, "Expected fanA from the test fixture");
  assert(fanB !== undefined, "Expected fanB from the test fixture");
  assert(fanC !== undefined, "Expected fanC from the test fixture");
  assert(fanD !== undefined, "Expected fanD from the test fixture");

  for (const fan of [fanA, fanB, fanC, fanD]) {
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: pageId,
      isFollower: false,
      isSubscriber: false,
    });
  }

  const completedConversation = await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanA.id,
    platformConversationId: "monitor-conv-complete",
    partnerPlatformUserId: "monitor-fan-a",
    partnerUsername: "monitor_a",
    partnerDisplayName: "Monitor A",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-msg-002",
    lastUnreadMessageId: null,
    lastMessageAt: completedLastMessageAt,
    lastMessageSenderId: "monitor-fan-a",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Latest stored message",
    lastFanMessageAt: completedLastMessageAt,
    lastModelMessageAt: completedMessageCreatedAt,
    newestStoredMessageId: "monitor-msg-002",
    oldestStoredMessageId: "monitor-msg-001",
    storedMessageCount: 2,
    messageBackfillComplete: true,
    lastMessageSyncAt: completedSyncAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });
  await upsertPageDmMessages(testDb.db, [
    {
      conversationId: completedConversation.id,
      platformAccountId: pageId,
      platformMessageId: "monitor-msg-001",
      senderPlatformUserId: "acct-lana",
      senderRole: "model",
      createdAt: completedMessageCreatedAt,
      content: "Opening line",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
    {
      conversationId: completedConversation.id,
      platformAccountId: pageId,
      platformMessageId: "monitor-msg-002",
      senderPlatformUserId: "monitor-fan-a",
      senderRole: "fan",
      createdAt: completedLastMessageAt,
      content: "Latest stored message",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
  ]);
  await settleCompleteThreadSummary(testDb, {
    conversationId: completedConversation.id,
    headReadAt: completedSyncAt,
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanB.id,
    platformConversationId: "monitor-conv-lagging",
    partnerPlatformUserId: "monitor-fan-b",
    partnerUsername: "monitor_b",
    partnerDisplayName: "Monitor B",
    conversationFlags: 0,
    unreadCount: 1,
    subscriptionTierId: null,
    lastMessageId: "monitor-lagging-003",
    lastUnreadMessageId: "monitor-lagging-003",
    lastMessageAt: laggingLastMessageAt,
    lastMessageSenderId: "monitor-fan-b",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Lagging conversation",
    lastFanMessageAt: laggingLastMessageAt,
    lastModelMessageAt: null,
    newestStoredMessageId: "monitor-lagging-002",
    oldestStoredMessageId: "monitor-lagging-001",
    storedMessageCount: 2,
    messageBackfillComplete: false,
    lastMessageSyncAt: laggingLastMessageSyncAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanC.id,
    platformConversationId: "monitor-conv-pending",
    partnerPlatformUserId: "monitor-fan-c",
    partnerUsername: "monitor_c",
    partnerDisplayName: "Monitor C",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-pending-001",
    lastUnreadMessageId: null,
    lastMessageAt: pendingConversationAt,
    lastMessageSenderId: "acct-lana",
    lastMessageSenderRole: "model",
    lastMessagePreview: "Pending backfill",
    lastFanMessageAt: null,
    lastModelMessageAt: pendingConversationAt,
    newestStoredMessageId: "monitor-pending-001",
    oldestStoredMessageId: "monitor-pending-001",
    storedMessageCount: 1,
    messageBackfillComplete: false,
    lastMessageSyncAt: pendingConversationAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanD.id,
    platformConversationId: "monitor-conv-excluded",
    partnerPlatformUserId: "monitor-fan-d",
    partnerUsername: "monitor_d",
    partnerDisplayName: "Monitor D",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-excluded-001",
    lastUnreadMessageId: null,
    lastMessageAt: excludedConversationAt,
    lastMessageSenderId: "monitor-fan-d",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Excluded conversation",
    lastFanMessageAt: excludedConversationAt,
    lastModelMessageAt: null,
    newestStoredMessageId: null,
    oldestStoredMessageId: null,
    storedMessageCount: 0,
    messageBackfillComplete: false,
    lastMessageSyncAt: null,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await testDb.db.insert(pageSyncStateRows).values([
    {
      pageId,
      stream: "light",
      status: "running",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(30).getTime() / 1000 / 3600) - 1,
      requestSeq: 3,
      appliedSeq: 3,
      startedAt: lightRunningStartedAt,
    },
    {
      pageId,
      stream: "transactions" as const,
      status: "retrying",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(15).getTime() / 1000 / 3600) - 1,
      requestSeq: 4,
      appliedSeq: 3,
      retryAt: retryAt,
    },
    {
      pageId,
      stream: "subscribers" as const,
      status: "paused",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(60).getTime() / 1000 / 3600) - 1,
      requestSeq: 1,
      appliedSeq: 1,
    },
    {
      pageId,
      stream: "dm_conversations" as const,
      status: "blocked",
      cadenceSeconds: 1800,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(10).getTime() / 1000 / 1800) - 1,
      requestSeq: 2,
      appliedSeq: 1,
      failedAt: authFailedAt,
      blockerKind: "auth",
      blockerCode: "auth_blocked",
      blockerMessage: "Session expired",
      blockedAt: authFailedAt,
      lastErrorCode: "auth_blocked",
      lastErrorSummary: "Session expired",
    },
    {
      pageId,
      stream: "top_spenders" as const,
      status: "idle",
      cadenceSeconds: 21600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(hoursAgo(-12).getTime() / 1000 / 21600) - 1,
      requestSeq: 6,
      appliedSeq: 6,
      finishedAt: topSpendersSucceededAt,
      succeededAt: topSpendersSucceededAt,
      failedAt: topSpendersFailedAt,
      consecutiveFailures: 2,
      lastErrorCode: "http_500",
      lastErrorSummary: "Top spenders sync failed",
    },
  ]);

  const runningLightRun = await seedMonitorRunningRun(testDb, {
    pageId,
    stream: "light",
    startedAt: lightRunningStartedAt,
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: runningLightRun.id,
    platformAccountId: pageId,
    provider: "onlyfans",
    stream: "light",
    eventType: "phase_started",
    severity: "info",
    message: "Light sync is active",
    emittedAt: lightRunningEventAt,
  });

  const transactionsRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "transactions",
    status: "partial",
    startedAt: transactionsStartedAt,
    finishedAt: transactionsFinishedAt,
  });
  await seedMonitorAttempt(testDb, {
    runId: transactionsRun.id,
    pageId,
    provider: "onlyfans",
    stream: "transactions",
    startedAt: last429At,
    finishedAt: new Date(last429At.getTime() + 30_000),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Rate limited",
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: transactionsRun.id,
    platformAccountId: pageId,
    provider: "onlyfans",
    stream: "transactions",
    eventType: "backfill_progress",
    severity: "warn",
    message: "Transactions backfill slowed by 429s",
    emittedAt: transactionsEventAt,
  });

  const failedTopSpendersRun = present(await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "top_spenders",
    status: "failed",
    startedAt: topSpendersStartedAt,
    finishedAt: topSpendersFailedAt,
    errorSummary: "Top spenders sync failed",
  }), "the failed top_spenders run");
  await seedMonitorAttempt(testDb, {
    runId: failedTopSpendersRun.id,
    pageId,
    provider: "onlyfans",
    stream: "top_spenders",
    startedAt: last5xxAt,
    finishedAt: new Date(last5xxAt.getTime() + 30_000),
    state: "failed",
    httpStatus: 500,
    failureKind: "http",
    errorMessage: "Internal server error",
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: failedTopSpendersRun.id,
    platformAccountId: pageId,
    provider: "onlyfans",
    stream: "top_spenders",
    eventType: "run_failed",
    severity: "error",
    message: "Top spenders sync failed",
    emittedAt: topSpendersFailedAt,
  });

  const oldLightRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "light",
    status: "success",
    startedAt: oldLightStartedAt,
    finishedAt: oldLightFinishedAt,
  });
  await seedMonitorAttempt(testDb, {
    runId: oldLightRun.id,
    pageId,
    provider: "onlyfans",
    stream: "light",
    startedAt: oldLight429At,
    finishedAt: new Date(oldLight429At.getTime() + 20_000),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Old rate limit",
  });

  await testDb.pool.query(`
    insert into egress_endpoints (
      platform_account_id,
      kind,
      url,
      encrypted_auth,
      key_version,
      rate_limit_scope_key
    ) values ($1, 'proxy', 'socks5://proxy.example', null, null, 'socks5://proxy.example:1080')
  `, [pageId]);

  await testDb.db.insert(syncRateLimits).values({
    provider: "onlyfans",
    scope: "global",
    egressKey: "socks5://proxy.example:1080",
    minSpacingMs: 1_000,
    nextAvailableAt: retryAt,
  });

  return {
    retryAt,
    topSpendersFailedAt,
    last429At,
    last5xxAt,
    lightRunningEventAt,
    lightRunningStartedAt,
  };
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`);
  return value;
}

/** An OnlyFans page under the model of a fixture page. */
async function createOnlyFansPageOf(testDb: StartedTestDatabase, model: { id: number } | undefined, label: string) {
  const page = await createOnlyFansPage(testDb.db, { modelId: present(model, "the fixture model").id, label });
  return present(page, `the OnlyFans page ${label}`);
}

/** The monitor's pages: an OnlyFans page of each fixture model, the first one
 *  assigned to the team lead beside the Fansly page `lana`. */
async function seedOnlyFansMonitorPages(
  testDb: StartedTestDatabase,
  fixture: Awaited<ReturnType<typeof seedPhase2Fixture>>,
) {
  const appContext = createTestAppContext(testDb);
  const lanaOf = await createOnlyFansPageOf(testDb, fixture.lanaModel, "lana-of");
  const lilyOf = await createOnlyFansPageOf(
    testDb, { id: present(fixture.lilyPage, "the fixture page lily1").modelId }, "lily-of",
  );
  await assignPageToUser(appContext, {
    userId: await fixtureUserId(appContext, "lead"),
    pageLabel: "lana-of",
  }, { source: "cli" });
  return { lanaOf, lilyOf };
}

async function seedSyncRequestsScenario(
  testDb: StartedTestDatabase,
  input: {
    lanaPageId: number;
    lilyPageId: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

  const lanaStartedAt = secondsAgo(3);
  const lilySharedAt = secondsAgo(4);
  const lilyGhostAt = secondsAgo(5);
  const lanaRetryAt = secondsAgo(8);
  const lanaFailedAt = secondsAgo(14);
  const oldAttemptAt = secondsAgo(75);

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: input.lanaPageId,
    fanId: null,
    platformConversationId: "group-live-1",
    partnerPlatformUserId: "fan-live-1",
    partnerUsername: "fan_live",
    partnerDisplayName: "Fan Live",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "dm-live-001",
    lastUnreadMessageId: null,
    lastMessageAt: lanaStartedAt,
    lastMessageSenderId: "fan-live-1",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "hello there",
    lastFanMessageAt: lanaStartedAt,
    lastModelMessageAt: null,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  const lanaMessagesRun = await seedMonitorRunningRun(testDb, {
    pageId: input.lanaPageId,
    stream: "dm_messages",
    startedAt: secondsAgo(6),
  });
  const lilyFollowersRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "followers",
    status: "success",
    startedAt: secondsAgo(10),
    finishedAt: secondsAgo(2),
  });
  const lilyGhostMessagesRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "dm_messages",
    status: "success",
    startedAt: secondsAgo(9),
    finishedAt: secondsAgo(4),
  });
  const lanaTransactionsRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lanaPageId,
    stream: "transactions",
    status: "partial",
    startedAt: secondsAgo(12),
    finishedAt: secondsAgo(7),
  });
  const lanaFollowersRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lanaPageId,
    stream: "followers",
    status: "failed",
    startedAt: secondsAgo(20),
    finishedAt: secondsAgo(13),
  });
  const lilyOldRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "light",
    status: "success",
    startedAt: secondsAgo(90),
    finishedAt: secondsAgo(70),
  });

  await seedMonitorAttempt(testDb, {
    runId: lanaMessagesRun.id,
    pageId: input.lanaPageId,
    stream: "dm_messages",
    operation: "messages",
    startedAt: lanaStartedAt,
    state: "started",
    requestShape: {
      endpointTemplate: "/message",
      method: "GET",
      rateLimitWaitMs: 1_200,
      groupId: "group-live-1",
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyFollowersRun.id,
    pageId: input.lilyPageId,
    stream: "followers",
    operation: "followers",
    startedAt: lilySharedAt,
    finishedAt: new Date(lilySharedAt.getTime() + 240),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/account/:accountId/followersnew",
      method: "GET",
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyGhostMessagesRun.id,
    pageId: input.lilyPageId,
    stream: "dm_messages",
    operation: "messages",
    startedAt: lilyGhostAt,
    finishedAt: new Date(lilyGhostAt.getTime() + 320),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/message",
      method: "GET",
      groupId: "group-ghost-1",
      egressKey: "proxy-b",
    },
    responseShape: {
      returnedItems: 2,
      done: true,
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lanaTransactionsRun.id,
    pageId: input.lanaPageId,
    stream: "transactions",
    operation: "earnings_transactions",
    attemptNumber: 2,
    startedAt: lanaRetryAt,
    finishedAt: new Date(lanaRetryAt.getTime() + 650),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Rate limited",
    requestShape: {
      endpointTemplate: "/account/wallets/earnings/transactions",
      method: "GET",
      rateLimitWaitMs: 2_500,
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lanaFollowersRun.id,
    pageId: input.lanaPageId,
    stream: "followers",
    operation: "followers",
    startedAt: lanaFailedAt,
    finishedAt: new Date(lanaFailedAt.getTime() + 900),
    state: "failed",
    httpStatus: 500,
    failureKind: "http",
    errorMessage: "Provider error",
    requestShape: {
      endpointTemplate: "/account/:accountId/followersnew",
      method: "GET",
      egressKey: "proxy-c",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyOldRun.id,
    pageId: input.lilyPageId,
    stream: "light",
    operation: "account_me",
    startedAt: oldAttemptAt,
    finishedAt: new Date(oldAttemptAt.getTime() + 180),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/account/me",
      method: "GET",
      egressKey: "proxy-old",
    },
  });

  return {
    now,
    lanaStartedAt,
    lilySharedAt,
    lilyGhostAt,
    lanaRetryAt,
    lanaFailedAt,
    oldAttemptAt,
  };
}

describe("api integration", () => {
  let testDb: StartedTestDatabase | null = null;
  let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let fixture: Awaited<ReturnType<typeof seedPhase2Fixture>> | null = null;
  let workerBoss: PgBoss | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);

    const appContext = createTestAppContext(testDb);
    fixture = await seedPhase2Fixture(testDb);
    await createUserAccount(appContext, {
      username: "dima",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "lead",
      role: "team_lead",
      password: "lead-secret",
    }, { source: "cli" });
    await assignPageToUser(appContext, {
      userId: await fixtureUserId(appContext, "lead"),
      pageLabel: "lana",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "anton",
      role: "chatter",
    }, { source: "cli" });

    if (server) {
      await server.close();
    }
    server = await buildApiServer(appContext);
    await server.ready();
  });

  afterEach(async () => {
    vi.useRealTimers();
    engineAnswer.answer = null;
    engineAnswer.asked.length = 0;

    if (workerBoss) {
      await workerBoss.stop();
      workerBoss = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("logs in with a cookie session and supports logout", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(setCookieHeaderFrom(login)).not.toContain("Secure");
    expect(login.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
        role: "owner",
      },
    });

    const cookie = sessionCookieFrom(login);
    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
      },
    });

    const badLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });
    expect(badLogin.statusCode).toBe(401);

    const logout = await server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie,
      },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rate limits repeated login attempts [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "dima",
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: "rate_limit_exceeded",
      message: "Too many login attempts",
      statusCode: 429,
    });
  });

  it("rate limits cross-account spraying per IP (audit B7) [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "10.1.1.1",
        payload: {
          username: `sprayed-user-${attempt}`,
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.1.1.1",
      payload: {
        username: "sprayed-user-final",
        password: "wrong",
      },
    });
    expect(limited.statusCode).toBe(429);

    // The spray bucket is per IP: another address is unaffected.
    const otherIp = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.1.1.2",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(otherIp.statusCode).toBe(200);
  });

  it("rejects expired sessions", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await testDb.pool.query(`
      update auth_sessions
      set expires_at = now() - interval '1 day'
    `);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);
  });

  it("revokes live sessions when a password is reset", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await setUserPassword(createTestAppContext(testDb), {
      userId: await fixtureUserId(createTestAppContext(testDb), "dima"),
      password: "owner-secret-2",
    }, { source: "cli" });

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);

    const oldPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret-2",
      },
    });
    expect(newPassword.statusCode).toBe(200);
  });

  it("marks the login cookie Secure for trusted https proxy requests", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb, {
      trustProxy: true,
    });
    await createUserAccount(appContext, {
      username: "proxy-owner",
      role: "owner",
      password: "proxy-secret",
    }, { source: "cli" });

    const proxyServer = await buildApiServer(appContext);
    await proxyServer.ready();

    try {
      const login = await proxyServer.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          "x-forwarded-proto": "https",
        },
        payload: {
          username: "proxy-owner",
          password: "proxy-secret",
        },
      });

      expect(login.statusCode).toBe(200);
      expect(setCookieHeaderFrom(login)).toContain("Secure");
    } finally {
      await proxyServer.close();
    }
  });

  it("dedupes repeated client event ids per chatter but keeps the same id separate across chatters", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    await createUser(appContext.db, {
      username: "boris",
      role: "chatter",
      passwordHash: null,
    });
    const antonKey = await issueChatterDeviceToken(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const borisKey = await issueChatterDeviceToken(appContext, {
      username: "boris",
      pageLabel: "lana",
    }, { source: "cli" });

    const payload = {
      events: [{
        clientEventId: "evt-shared",
        feature: "help-me",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        conversationId: "conversation-007",
        durationMs: 250,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: "2026-04-04T10:00:00.000Z",
      }],
    };

    const firstAnton = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload,
    });
    expect(firstAnton.statusCode).toBe(200);
    expect(firstAnton.json()).toEqual({
      receivedCount: 1,
      insertedCount: 1,
      invalidCount: 0,
      dedupedCount: 0,
    });

    const secondAnton = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload,
    });
    expect(secondAnton.statusCode).toBe(200);
    expect(secondAnton.json()).toEqual({
      receivedCount: 1,
      insertedCount: 0,
      invalidCount: 0,
      dedupedCount: 1,
    });

    const boris = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${borisKey.key}`,
      },
      payload,
    });
    expect(boris.statusCode).toBe(200);
    expect(boris.json()).toEqual({
      receivedCount: 1,
      insertedCount: 1,
      invalidCount: 0,
      dedupedCount: 0,
    });

    const grouped = await testDb.pool.query<{
      username: string;
      event_count: string;
    }>(`
      select u.username,
             count(*)::text as event_count
      from ai_usage_events e
      inner join users u on u.id = e.user_id
      group by u.id, u.username
      order by u.username asc, u.id asc
    `);

    expect(grouped.rows).toEqual([
      { username: "anton", event_count: "1" },
      { username: "boris", event_count: "1" },
    ]);
  });

  it("dual-writes operator observations at the audit choke point (Stage 7 producer 6) [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // The suite's beforeEach already created users and assigned a page —
    // every audited admin action must have produced an operator observation.
    const observations = await testDb.pool.query<{ kind: string; producer: string }>(
      "select kind, producer from observations where source = 'operator' order by id",
    );
    expect(observations.rows.length).toBeGreaterThanOrEqual(4);
    expect(observations.rows.every((row) => row.producer === "api:admin")).toBe(true);
    const kinds = new Set(observations.rows.map((row) => row.kind));
    expect(kinds).toContain("user.created");
    expect(kinds).toContain("user.page_assigned");

    // A fresh audited action adds a distinct observation with the actor.
    const appContext = createTestAppContext(testDb);
    const before = observations.rows.length;
    await assignPageToUser(appContext, { userId: await fixtureUserId(appContext, "anton"), pageLabel: "lana" }, { source: "cli" });
    const after = await testDb.pool.query<{ kind: string; producer: string }>(
      "select kind, producer from observations where source = 'operator' order by id",
    );
    expect(after.rows.length).toBe(before + 1);
    expect(after.rows.at(-1)).toMatchObject({
      kind: "user.page_assigned",
      producer: "api:admin",
    });
  });

  it("gates raw revenue routes to dashboard session roles (Stage 2 chatter-read-scope) [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const chatterKey = await issueChatterDeviceToken(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const gateServer = await buildApiServer(appContext);
    await gateServer.ready();

    const gatedUrls = [
      "/api/v1/pages/lana/revenue?period=7d",
      "/api/v1/pages/lana/transactions?limit=10&offset=0",
      "/api/v1/pages/lana/revenue/daily?period=30d",
      "/api/v1/pages/lana/fans/fan-001/transactions?limit=10&offset=0",
    ];

    try {
      // Bearer keys are refused with 403…
      for (const url of gatedUrls) {
        const response = await gateServer.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${chatterKey.key}` },
        });
        expect(response.statusCode, url).toBe(403);
      }

      // …while owner sessions keep working…
      const ownerCookie = await loginOwnerCookie(gateServer);
      for (const url of gatedUrls) {
        const response = await gateServer.inject({
          method: "GET",
          url,
          headers: { cookie: ownerCookie },
        });
        expect(response.statusCode, `${url} for owner session`).toBe(200);
      }

      // …and the chatter-facing spenders board stays reachable (do not over-gate).
      const spenders = await gateServer.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=0",
        headers: { authorization: `Bearer ${chatterKey.key}` },
      });
      expect(spenders.statusCode, spenders.body).toBe(200);
    } finally {
      await gateServer.close();
    }
  });

  it("matches page revenue service output with explicit revenue buckets", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-chargeback",
      rawType: 99901,
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: -1000n,
      sourceDestinationAmountMills: -1000n,
      creatorNetAmountMills: -1000n,
      occurredAt: new Date("2026-03-08T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-other",
      rawType: 18001,
      canonicalType: "other",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300n,
      sourceDestinationAmountMills: 300n,
      creatorNetAmountMills: 300n,
      occurredAt: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture.lanaPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getPageRevenueReport(createTestAppContext(testDb), "lana", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
    });
    expect(response.json().revenueMills).toBe(7000);
    expect(response.json().adjustmentMills).toBe(-1000);
    expect(response.json().unclassifiedMills).toBe(300);
    expect(response.json().netEarningsMills).toBe(6300);
    expect(response.json().totalNetMills).toBe(response.json().netEarningsMills);
    expect(response.json().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalType: "chargeback",
        bucket: "adjustment",
        netAmountMills: -1000,
      }),
      expect.objectContaining({
        canonicalType: "other",
        bucket: "unclassified",
        netAmountMills: 300,
      }),
    ]));
    expect(response.json().breakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
  });

  it("combines Fansly and OnlyFans revenue in model reports", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-acct-42",
      username: "lana_of",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 42,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "loading",
      grossAmountMills: 12000n,
      sourceDestinationAmountMills: 12000n,
      creatorNetAmountMills: 12000n,
      occurredAt: new Date("2026-03-05T15:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-cb-1",
      rawType: "Tip from",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -2000n,
      sourceDestinationAmountMills: -2000n,
      creatorNetAmountMills: -2000n,
      occurredAt: new Date("2026-03-06T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/models/lana-model/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getModelRevenueReport(createTestAppContext(testDb), "lana-model", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
      pages: expect.arrayContaining([
        expect.objectContaining({
          pageLabel: "lana",
          netEarningsMills: 7000,
          totalNetMills: 7000,
        }),
        expect.objectContaining({
          pageLabel: "lana-of",
          netEarningsMills: 10000,
          totalNetMills: 10000,
        }),
      ]),
    });
  });

  it("uses UTC day boundaries for OnlyFans 30d revenue and rollups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "utc-boundary-model",
      name: "UTC Boundary Model",
    });
    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "utc-boundary-of",
    });

    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-boundary-1",
      username: "utc_boundary",
      displayName: "UTC Boundary",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 404,
      },
      syncType: "light",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "before-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-02-06T23:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-0010",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-02-07T00:10:15.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-2059",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-02-07T20:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-2100",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 3000n,
      sourceDestinationAmountMills: 3000n,
      creatorNetAmountMills: 3000n,
      occurredAt: new Date("2026-02-07T21:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "after-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4000n,
      sourceDestinationAmountMills: 4000n,
      creatorNetAmountMills: 4000n,
      occurredAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const report = await getPageRevenueReport(createTestAppContext(testDb), onlyFansPage.label, {
      period: "30d",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    const rollupRows = await testDb.pool.query(`
      select business_date::text as business_date,
             creator_net_amount_mills as net_amount_mills
      from revenue_daily
      where platform_account_id = ${onlyFansPage.id}
      order by business_date asc
    `);

    expect(report.from).toBe("2026-02-07T00:00:00.000Z");
    expect(report.to).toBe("2026-03-10T00:00:00.000Z");
    expect(report.revenueMills).toBe(6000);
    expect(report.adjustmentMills).toBe(0);
    expect(report.unclassifiedMills).toBe(0);
    expect(report.netEarningsMills).toBe(6000);
    expect(report.totalNetMills).toBe(6000);
    expect(report.totalNetMills).toBe(report.netEarningsMills);
    expect(report.breakdown).toEqual([
      {
        canonicalType: "tip",
        bucket: "revenue",
        netAmountMills: 6000,
      },
    ]);
    expect(rollupRows.rows).toEqual([
      {
        business_date: "2026-02-06",
        net_amount_mills: 500n,
      },
      {
        business_date: "2026-02-07",
        net_amount_mills: 6000n,
      },
      {
        business_date: "2026-03-10",
        net_amount_mills: 4000n,
      },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const dailyResponse = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${onlyFansPage.label}/revenue/daily?period=30d`,
      headers: { cookie },
    });

    expect(dailyResponse.statusCode).toBe(200);
    expect(dailyResponse.json().series).toEqual([
      {
        businessDate: "2026-02-07",
        netAmountMills: 6000,
        transactionCount: 3,
      },
    ]);
  });

  it("uses occurred_at instead of transactions.created_at in revenue and page transaction reporting", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const createdAtPage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "created-at-check",
    });
    await updatePageMetadata(testDb.db, createdAtPage.id, {
      platformAccountIdValue: "acct-created-at-check",
      username: "created_at_check",
      displayName: "Created At Check",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-created-at",
      username: "created-at-fan",
      displayName: "Created At Fan",
    }]);
    assert(fan !== undefined, "Expected fan from the test fixture");
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: createdAtPage.id,
      isFollower: false,
      isSubscriber: false,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "tx-newer-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-05T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "tx-older-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-01-15T12:00:00.000Z"),
    });

    await testDb.pool.query(
      `
        update transactions
        set created_at = $1
        where platform_account_id = $2
      `,
      [new Date("2026-04-01T00:00:00.000Z"), createdAtPage.id],
    );

    await rebuildRevenueRollups(testDb.db, createdAtPage.id);
    await recalculateFanPageSpend(testDb.db, createdAtPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const revenue = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().totalNetMills).toBe(2000);
    expect(revenue.json().breakdown).toEqual([
      {
        bucket: "revenue",
        canonicalType: "tip",
        netAmountMills: 2000,
      },
    ]);

    const transactions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/transactions?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(transactions.statusCode).toBe(200);
    expect(transactions.json().items.map((row: { transactionId: string }) => row.transactionId)).toEqual([
      "tx-newer-occurred",
      "tx-older-occurred",
    ]);

    const fans = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/fans?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(fans.statusCode).toBe(200);
    expect(fans.json().items[0]).toMatchObject({
      platformUserId: "fan-created-at",
      totalCreatorNetMills: 3000,
      lastTransactionAt: "2026-03-05T12:00:00.000Z",
    });
  });

  it("limits cross-page fan visibility for team leads and exposes full scope for owners", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const leadFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(leadFan.statusCode).toBe(200);
    expect(leadFan.json()).toMatchObject({
      platformTotalSpendMills: 7000,
    });
    expect(leadFan.json().pages).toHaveLength(1);
    expect(leadFan.json().pages[0]?.pageLabel).toBe("lana");

    const deniedPage = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(deniedPage.statusCode).toBe(403);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const ownerFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: ownerCookie,
      },
    });
    expect(ownerFan.statusCode).toBe(200);
    expect(ownerFan.json().pages).toHaveLength(2);
  });

  it("lists v2 spenders with scoped diagnostics and no hidden-page leakage", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture!.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-unattributed-v2",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-03-06T18:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture!.lanaPage.id);
    await testDb.pool.query(`
      insert into revenue_daily (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state,
        transaction_count,
        gross_amount_mills,
        creator_net_amount_mills,
        updated_at
      )
      values (
        ${fixture!.lanaPage.id},
        '2026-03-06',
        'payout_reversal'::transaction_type,
        'posted'::transaction_state,
        1,
        2000,
        2000,
        now()
      )
    `);

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=agency&platform=fansly&period=30d&limit=10&offset=0",
      headers: {
        cookie: leadCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: {
        kind: "agency",
        platform: "fansly",
        pageCount: 1,
      },
      diagnostics: {
        totalGrossAmountMills: 7500,
        totalCreatorNetAmountMills: 7500,
        attributedGrossAmountMills: 7000,
        attributedCreatorNetAmountMills: 7000,
        unattributedGrossAmountMills: 500,
        unattributedCreatorNetAmountMills: 500,
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "buyer",
            displayName: "Buyer One",
          },
          metrics: {
            window: {
              grossAmountMills: 7000,
              creatorNetAmountMills: 7000,
              postedGrossAmountMills: 5000,
              pendingGrossAmountMills: 2000,
              unknownGrossAmountMills: 0,
              postedCreatorNetAmountMills: 5000,
              pendingCreatorNetAmountMills: 2000,
              unknownCreatorNetAmountMills: 0,
              transactionCount: 2,
            },
            lifetime: {
              scopeGrossAmountMills: 7000,
              scopeCreatorNetAmountMills: 7000,
              platformGrossAmountMills: 7000,
              platformCreatorNetAmountMills: 7000,
            },
          },
        },
      ],
      total: 1,
    });
    expect(response.json().period.timeZone).toBe("UTC");
    expect(response.json().period.asOf).toBeTruthy();
    expect(response.json().items[0].fan.fanId).toBeUndefined();
  });

  it("[sync-critical] refuses cross-page spender scope for an owner DEVICE TOKEN", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    // Regression pin. The guard used to read `authMethod === "api_key"`, so a
    // device token slipped past it — and device tokens authenticate any
    // session-capable role, owner included. `pageScopeFor` then hands an owner
    // principal `undefined` (unrestricted), which made an owner-role device
    // token an unbounded cross-page reader on every v2 spender route.
    // The old test WAS the bug: it only ever exercised api_key.
    const ownerDevice = await issueDeviceTokenForUserId(createTestAppContext(testDb), {
      userId: await fixtureUserId(createTestAppContext(testDb), "dima"),
      label: "dima-audit-laptop",
    }, { source: "test" });

    for (const url of [
      "/api/v2/spenders?scope=agency&platform=fansly&period=30d&limit=10&offset=0",
      "/api/v2/spenders?scope=model&modelSlug=lana-model&platform=fansly&period=30d&limit=10&offset=0",
    ]) {
      const denied = await server.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${ownerDevice.token}` },
      });
      expect({ url, statusCode: denied.statusCode }).toEqual({ url, statusCode: 403 });
    }

    // Page scope stays available to the same principal — the restriction is
    // about cross-page aggregates, not about device tokens as such.
    const allowed = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=0",
      headers: { authorization: `Bearer ${ownerDevice.token}` },
    });
    expect(allowed.statusCode).toBe(200);

    // ...and the BODY must be page-scoped too. Refusing the agency/model shapes
    // is not sufficient: the page branch used to widen the lifetime "platform"
    // rollup to every page an owner can see, so a page-scoped request still
    // answered with cross-page money. Asserting only the status code is exactly
    // how that would have shipped.
    //
    // The sibling test above pins the SESSION view of this same fan on this
    // same page: scope 7000, platform 10000 — the fan spent 3000 more on
    // another page. A bearer must see the platform rollup clamped to 7000.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));
    const bearerView = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&platform=fansly&period=30d&limit=10&offset=0",
      headers: { authorization: `Bearer ${ownerDevice.token}` },
    });
    vi.useRealTimers();
    expect(bearerView.statusCode).toBe(200);
    expect(bearerView.json().items[0]).toMatchObject({
      fan: { platformUserId: "fan-001" },
      metrics: {
        lifetime: {
          scopeGrossAmountMills: 7000,
          // Clamped to the requested page. Was 10000 before the fix — the
          // other page's money leaking through a page-scoped request.
          platformGrossAmountMills: 7000,
          platformCreatorNetAmountMills: 7000,
        },
      },
    });
  });

  it("[sync-critical] page fan detail gives a bearer the platform total for that page only", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    // Same leak class as the spender rollup, different route. `pageFanDetail`
    // is `{kind:"any", scope:"page"}` — reachable by a bearer — and handed
    // `pageScopeFor(principal)` straight to the platform-total query, which
    // treats `undefined` as "no page filter". An owner-role device token asking
    // about ONE page therefore read the fan's spend across every page.
    const ownerDevice = await issueDeviceTokenForUserId(createTestAppContext(testDb), {
      userId: await fixtureUserId(createTestAppContext(testDb), "dima"),
      label: "dima-fan-detail-laptop",
    }, { source: "test" });

    const bearerView = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001",
      headers: { authorization: `Bearer ${ownerDevice.token}` },
    });
    expect(bearerView.statusCode).toBe(200);
    // 7000 on this page; the same fan has 3000 more on another page of the
    // platform (seedPhase2Fixture). Before the fix this answered 10000.
    expect(bearerView.json().platformTotalSpendMills).toBe(7000);

    // A cookie session keeps the full platform view.
    const sessionView = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001",
      headers: { cookie: await loginOwnerCookie(server) },
    });
    expect(sessionView.statusCode).toBe(200);
    expect(sessionView.json().platformTotalSpendMills).toBe(10000);
  });

  it("supports alias-aware v2 fan search and page-scoped bearer batch lookups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
      username: "spender-renamed",
      displayName: "Renamed Fan",
    }]);

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterDeviceToken(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const search = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&query=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });

    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      scope: {
        kind: "page",
        platform: "fansly",
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "spender-renamed",
            displayName: "Renamed Fan",
          },
          matchKind: "alias",
          matchedValue: "buyer",
        },
      ],
    });
    expect(search.json().items[0].fan.fanId).toBeUndefined();
    expect(search.json().items[0].metrics).toBeUndefined();

    const legacySearch = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&q=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(legacySearch.statusCode).toBe(200);
    expect(legacySearch.json().items).toEqual(search.json().items);

    const spenderList = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(spenderList.statusCode).toBe(200);
    expect(spenderList.json().scope).toMatchObject({
      kind: "page",
      platform: "fansly",
    });

    const batch = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "page",
        pageLabel: "lana",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
          { platform: "fansly", platformUserId: "fan-missing" },
        ],
      },
    });

    expect(batch.statusCode).toBe(200);
    expect(batch.json().items).toEqual([
      expect.objectContaining({
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-001",
        },
        found: true,
        metrics: expect.objectContaining({
          window: expect.objectContaining({
            creatorNetAmountMills: 7000,
          }),
          lifetime: {
            scopeGrossAmountMills: 7000,
            scopeCreatorNetAmountMills: 7000,
            platformGrossAmountMills: 7000,
            platformCreatorNetAmountMills: 7000,
          },
        }),
        typeBreakdown: expect.arrayContaining([
          expect.objectContaining({
            canonicalType: expect.any(String),
            grossAmountMills: expect.any(Number),
            creatorNetAmountMills: expect.any(Number),
            transactionCount: expect.any(Number),
          }),
        ]),
        lifetimeLastTransactionAt: expect.any(String),
        subscription: {
          status: "active",
          expiresAt: "2026-03-20T12:00:00.000Z",
          autoRenew: true,
          autoRenewOffDetectedAt: null,
        },
      }),
      {
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-missing",
        },
        found: false,
        fan: null,
        metrics: null,
        typeBreakdown: null,
        lifetimeLastTransactionAt: null,
        subscription: null,
      },
    ]);

    const forbidden = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "agency",
        platform: "fansly",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
        ],
      },
    });

    expect(forbidden.statusCode).toBe(403);
  });

  it("returns typed conflicts and not-found errors for admin model CRUD", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "spare-model",
      name: "Spare Model",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const duplicateCreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/models",
      headers: { cookie },
      payload: {
        slug: "lana-model",
        name: "Duplicate Lana",
      },
    });

    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" already exists',
      statusCode: 409,
    });

    const missingUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/models/missing-model",
      headers: { cookie },
      payload: {
        name: "Nope",
      },
    });

    expect(missingUpdate.statusCode).toBe(404);
    expect(missingUpdate.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" not found',
      statusCode: 404,
    });

    const duplicateUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/models/spare-model",
      headers: { cookie },
      payload: {
        slug: "lana-model",
      },
    });

    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateUpdate.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" already exists',
      statusCode: 409,
    });

    const missingDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/models/missing-model",
      headers: { cookie },
    });

    expect(missingDelete.statusCode).toBe(404);
    expect(missingDelete.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" not found',
      statusCode: 404,
    });

    const nonEmptyDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/models/lana-model",
      headers: { cookie },
    });

    expect(nonEmptyDelete.statusCode).toBe(409);
    expect(nonEmptyDelete.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" cannot be deleted while it still has 1 page',
      statusCode: 409,
    });
  });

  it("rejects proxyless Fansly onboarding at the API boundary [sync-critical]", async (context) => {
    if (!server) {
      context.skip();
      return;
    }

    const cookie = await loginOwnerCookie(server);
    for (const [label, proxy] of [
      ["missing", undefined],
      ["null", null],
    ] as const) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/pages",
        headers: { cookie },
        payload: {
          platform: "fansly",
          modelSlug: "lana-model",
          label: `proxy-${label}-page`,
          session: {
            authorization: "token",
          },
          ...(proxy === undefined ? {} : { proxy }),
        },
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("queues the initial legacy sync after an OnlyFans page is created [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // A Fansly page is born live on the Fansly Sync Engine and queues no
    // legacy sync — its history walks are engine work queued at its birth
    // (step 4 S4-05, tests/sync-onboard-live.integration.test.ts); an
    // OnlyFans page still starts on the legacy executor.
    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      ofapi: createOnboardingOfapi({
        accountId: "acct_auto_sync",
        username: "auto_sync_user",
        displayName: "Auto Sync User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    workerBoss = new PgBoss({ connectionString: activeTestDb.connectionString });
    await workerBoss.start();
    await ensureSyncQueues(workerBoss);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "onlyfans",
        modelSlug: "lana-model",
        label: "auto-sync-page",
        username: "auto_sync_user",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      page: {
        label: "auto-sync-page",
        platform: "onlyfans",
        username: "auto_sync_user",
      },
      verified: true,
      syncQueued: true,
      syncWarning: null,
      syncRetry: null,
    });

    const requested = await activeTestDb.pool.query<{ stream: string; request_source: string | null }>(`
      select st.stream::text as stream, st.request_source::text as request_source
      from page_sync_states st
      join pages pa on pa.id = st.page_id
      where pa.label = 'auto-sync-page'
        and st.request_seq > st.applied_seq
      order by st.stream
    `);
    expect(requested.rows.length).toBeGreaterThan(0);
    expect(requested.rows.every((row) => row.request_source === "onboarding")).toBe(true);
  });

  it("returns page creation success with a retry path when the initial sync cannot be queued [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      ofapi: createOnboardingOfapi({
        accountId: "acct_enqueue_fail",
        username: "enqueue_fail_user",
        displayName: "Enqueue Fail User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await activeTestDb.pool.query("drop schema pgboss cascade");

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "onlyfans",
        modelSlug: "lana-model",
        label: "enqueue-fail-page",
        username: "enqueue_fail_user",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: {
        label: "enqueue-fail-page",
        platform: "onlyfans",
        username: "enqueue_fail_user",
      },
      verified: true,
      syncQueued: false,
      syncWarning: {
        code: "initial_sync_enqueue_failed",
        message: 'Page "enqueue-fail-page" was created, but initial sync was not queued. Retry by triggering an all sync for this page.',
      },
      syncRetry: {
        method: "POST",
        path: "/api/v1/admin/sync/trigger",
        body: {
          pageLabel: "enqueue-fail-page",
          scope: "all",
        },
      },
    });

    const pageRows = await activeTestDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pages
      where label = 'enqueue-fail-page'
    `);
    expect(pageRows.rows[0]?.count).toBe("1");

    const duplicateCreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "onlyfans",
        modelSlug: "lana-model",
        label: "enqueue-fail-page",
        username: "enqueue_fail_user",
      },
    });

    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: "conflict",
      message: 'Page "enqueue-fail-page" already exists',
      statusCode: 409,
    });

    const pageRowsAfterRetry = await activeTestDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pages
      where label = 'enqueue-fail-page'
    `);
    expect(pageRowsAfterRetry.rows[0]?.count).toBe("1");
  });

  it("uses the latest light sync run for connection health [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const latestLightRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, latestLightRun.id, {
      status: "success",
      stats: {},
    });

    const followerRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "followers",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, followerRun.id, {
      status: "failed",
      stats: {},
      errorSummary: "Follower sync failed",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "lana",
        connectionStatus: "active",
        lastSyncError: null,
        proxyUrl: null,
        proxyHasAuth: false,
        syncUx: expect.objectContaining({
          state: expect.any(String),
          headline: expect.any(String),
          requiresAction: expect.any(Boolean),
        }),
      }),
    ]));
  });

  it("serves public system health without auth and degrades when the database probe fails [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const healthy = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({
      status: "ok",
      contractHash: KERNEL_CONTRACT_HASH,
      capabilities: ["desktop-lifecycle-v2"],
      checks: {
        api: {
          status: "ok",
        },
        database: {
          status: "ok",
          error: null,
        },
      },
    });
    expect(typeof healthy.json().timestamp).toBe("string");
    expect(healthy.json().capabilities).toEqual(["desktop-lifecycle-v2"]);
    expect(typeof healthy.json().checks.database.latencyMs).toBe("number");

    const querySpy = vi
      .spyOn(testDb.pool, "query")
      .mockRejectedValueOnce(new Error("db probe failed"));

    const degraded = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    querySpy.mockRestore();

    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({
      status: "degraded",
      contractHash: KERNEL_CONTRACT_HASH,
      capabilities: ["desktop-lifecycle-v2"],
      checks: {
        api: {
          status: "ok",
        },
        database: {
          status: "error",
          error: "Database check failed",
        },
      },
    });
    expect(degraded.json().checks.database.error).not.toContain("db probe failed");
    expect(degraded.json().capabilities).toEqual(["desktop-lifecycle-v2"]);
    expect(typeof degraded.json().checks.database.latencyMs).toBe("number");
  });

  it("requires dashboard auth or a monitoring token for detailed sync health [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    // An OnlyFans page of the legacy executor in trouble, beside the fixture's
    // two Fansly pages that no engine runs.
    const onlyFansPage = await createOnlyFansPageOf(testDb, fixture.lanaModel, "lana-of");
    await seedSyncMonitorScenario(testDb, onlyFansPage.id, new Date());

    const anonymous = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
    });

    expect(anonymous.statusCode).toBe(401);
    expect(JSON.stringify(anonymous.json())).not.toContain("lana");

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();

    expect(body).toMatchObject({
      status: "degraded",
      overall: {
        pageCount: 3,
        unhealthyPageCount: 3,
      },
    });
    // The one threshold left: the follower-sync age went with the legacy
    // Fansly checks (step 4, S4-24).
    expect(body.thresholds).toEqual({ lightMaxAgeMinutes: 180 });
    expect(typeof body.timestamp).toBe("string");
    expect(body.overall.failedStreams).toBeGreaterThan(0);
    expect(body.overall.stalledStreams).toBeGreaterThan(0);
    expect(body.overall).toMatchObject({
      recentFailedRuns: 1,
      recent429s: 1,
      recent5xxs: 1,
    });

    expect(body.pages).toEqual(expect.arrayContaining([
      // The legacy checks are the legacy executor's pages'.
      expect.objectContaining({
        pageLabel: "lana-of",
        platform: "onlyfans",
        status: "degraded",
        issues: expect.arrayContaining([
          "failed_streams",
          "stalled_streams",
        ]),
      }),
      // A Fansly page no engine runs is read by nothing: one issue, and no
      // legacy check of it (no light-sync age, no follower-sync age).
      expect.objectContaining({
        pageLabel: "lana",
        platform: "fansly",
        status: "degraded",
        issues: ["engine:not_live"],
      }),
      expect.objectContaining({
        pageLabel: "lily1",
        platform: "fansly",
        status: "degraded",
        issues: ["engine:not_live"],
      }),
    ]));
    // No page carries a legacy Fansly issue (the follower-sync age, the DM coverage debt).
    for (const page of body.pages) {
      expect(page.issues.filter((issue: string) => /^(follower|coverage)_/.test(issue)), page.pageLabel).toEqual([]);
    }

    await server.close();
    const monitoredContext = createTestAppContext(testDb, {
      healthSyncMonitoringToken: "health-monitor-secret",
    });
    server = await buildApiServer(monitoredContext);
    await server.ready();

    const badToken = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: {
        "x-monitoring-token": "wrong-token",
      },
    });
    expect(badToken.statusCode).toBe(401);

    const monitored = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: {
        "x-monitoring-token": "health-monitor-secret",
      },
    });
    expect(monitored.statusCode).toBe(503);
    expect(monitored.json().pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pageLabel: "lana",
        platform: "fansly",
      }),
    ]));
  });

  it("reports whether a stored proxy is configured without exposing proxy secrets [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await saveProxy(createTestAppContext(testDb), fixture.lanaPage.id, {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const lanaConnection = response.json().find((connection: { label: string }) => connection.label === "lana");
    expect(lanaConnection).toEqual(expect.objectContaining({
      label: "lana",
      proxyUrl: "socks5://127.0.0.1:1080",
      proxyHasAuth: true,
    }));
    expect(JSON.stringify(lanaConnection)).not.toContain("proxy-user");
    expect(JSON.stringify(lanaConnection)).not.toContain("proxy-pass");
  });

  it("returns sync runs as a bare array for admin clients [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const run = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, run.id, {
      status: "success",
      stats: { synced: 1 },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/sync/runs?limit=1",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        runId: run.id,
        pageLabel: "lana",
        stream: "light",
      }),
    ]);
  });

  it("updates stored page credentials via PATCH for owners [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture!.lanaPage.id);
    await openLegacyPageLatches(activeTestDb, fixture!.lanaPage);
    engineAnswersFor({ accountId: "acct-lana", username: "lana_page" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      updated: true,
      verified: true,
      syncUnblocked: true,
    });
    // One identity check of the candidate through the page's actor.
    expect(engineAnswer.asked).toEqual(["account.identity"]);
    const stored = await resolvePageContext(createTestAppContext(activeTestDb), "lana");
    expect("session" in stored ? stored.session.authorization : null).toBe("updated-token");

    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `auth_blocked:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `proxy_failed:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
  });

  it("verifies a page through its engine actor and resolves its incidents when owners admin verify it [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture!.lanaPage.id);
    await openLegacyPageLatches(activeTestDb, fixture!.lanaPage);
    engineAnswersFor({ accountId: "acct-lana", username: "lana_page" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/lana/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      verified: true,
      username: "lana_page",
      platform: "fansly",
      syncUnblocked: true,
    });
    expect(engineAnswer.asked).toEqual(["account.verify"]);

    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `auth_blocked:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `proxy_failed:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
  });

  it("refuses the owner's verify and credentials change of a Fansly page the engine does not run [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // No legacy `/account/me` is left to fall back to (step 4, S4-19): a
    // Fansly page without a live engine row has no sender, so nothing is
    // checked, sent or stored, and its incidents stay as they are.
    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture!.lanaPage.id);
    await openLegacyPageLatches(activeTestDb, fixture!.lanaPage);
    engineAnswersFor({ accountId: "acct-lana", username: "lana_page" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    for (const mode of ["off", "shadow", null] as const) {
      if (mode === null) {
        await activeTestDb.pool.query("delete from sync_pages where page_id = $1", [fixture!.lanaPage.id]);
      } else {
        await setModeDirect(activeTestDb.pool, fixture!.lanaPage.id, mode);
      }
      const verify = await server.inject({
        method: "POST",
        url: "/api/v1/admin/pages/lana/verify",
        headers: { cookie },
      });
      expect(verify.statusCode, String(mode)).toBe(409);
      expect(verify.json()).toMatchObject({ error: "legacy_sync_retired", statusCode: 409 });

      const credentials = await server.inject({
        method: "PATCH",
        url: "/api/v1/admin/pages/lana/credentials",
        headers: { cookie },
        payload: {
          platform: "fansly",
          session: {
            authorization: "updated-token",
          },
        },
      });
      expect(credentials.statusCode, String(mode)).toBe(409);
      expect(credentials.json()).toMatchObject({ error: "legacy_sync_retired", statusCode: 409 });
    }

    expect(engineAnswer.asked).toEqual([]);
    const stored = await resolvePageContext(createTestAppContext(activeTestDb), "lana");
    expect("session" in stored ? stored.session.authorization : null).toBe("verify-token");
    for (const kind of ["auth_blocked", "proxy_failed"]) {
      expect(await getNotificationIncidentByKey(activeTestDb.db, `${kind}:${fixture!.lanaPage.id}`))
        .toEqual(expect.objectContaining({ status: "open" }));
    }
  });

  it("returns 404 when owners admin verify a missing page [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/missing/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "not_found",
      message: 'Page "missing" not found',
      statusCode: 404,
    });
  });

  it("returns 500 when owners admin verify hits an unexpected runtime failure [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture.lanaPage.id);
    engineAnswer.answer = () => {
      throw new Error("the engine's queue exploded");
    };

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/lana/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "internal_error",
      message: "Internal Server Error",
      statusCode: 500,
    });
  });

  it("normalizes inline proxy credentials when updating page credentials via PATCH [sync-critical]", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture!.lanaPage.id);
    engineAnswersFor({ accountId: "acct-lana", username: "lana_page" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
        proxy: {
          url: "socks5://proxy-user:proxy-pass@proxy.example:1080",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const proxyRows = await activeTestDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = (
        select id from pages where label = 'lana'
      )
    `);

    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://proxy.example:1080",
      has_encrypted_auth: true,
    });
  });

  it("rejects null proxy removal via credentials PATCH and preserves the stored route [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await makeEngineLive(activeTestDb, fixture.lanaPage.id);
    engineAnswersFor({ accountId: "acct-lana", username: "lana_page" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
        proxy: null,
      },
    });

    expect(response.statusCode).toBe(400);
    // Refused at the contract: nothing reached the page's actor.
    expect(engineAnswer.asked).toEqual([]);

    const proxyRows = await activeTestDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from egress_endpoints
      where platform_account_id = $1
    `, [fixture.lanaPage.id]);

    expect(proxyRows.rows[0]?.count).toBe(1);
  });

  it("returns scoped sync monitor snapshots with derived statuses and recent aggregates [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    // The monitor is the legacy page-sync executor's, and that executor serves
    // OnlyFans only (step 4): its pages are OnlyFans pages, its rows the
    // streams the executor runs. The fixture's Fansly pages are not in it.
    const { lanaOf } = await seedOnlyFansMonitorPages(testDb, fixture);
    const seeded = await seedSyncMonitorScenario(testDb, lanaOf.id, new Date());
    // A Fansly page's parked legacy rows are records, not monitor rows.
    await seedFormerFanslyRows(testDb.pool, present(fixture.lanaPage, "the fixture page lana").id, new Date());

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status",
      headers: { cookie: ownerCookie },
    });

    expect(ownerResponse.statusCode).toBe(200);
    const ownerBody = ownerResponse.json();
    expect(typeof ownerBody.generatedAt).toBe("string");
    expect(ownerBody.window.hours).toBe(24);
    expect(ownerBody.pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana-of", "lily-of"]);
    expect(ownerBody.pages.map((page: { platform: string }) => page.platform)).toEqual(["onlyfans", "onlyfans"]);
    expect(ownerBody.overall.pages).toBe(2);
    expect(ownerBody.overall.streams).toBe(14);
    expect(ownerBody.overall.syncUx).toMatchObject({
      state: "attention",
      requiresAction: true,
      headline: "Reconnect to resume sync",
    });
    expect(ownerBody.overall.recentRuns).toMatchObject({
      running: 1,
      success: 0,
      partial: 1,
      failed: 1,
      skipped: 0,
    });
    expect(ownerBody.overall.recentErrors).toMatchObject({
      total429s: 1,
      total5xxs: 1,
      failedRuns: 1,
      failedAttempts: 1,
      retryAttempts: 1,
      last429At: seeded.last429At.toISOString(),
      last5xxAt: seeded.last5xxAt.toISOString(),
    });
    expect(ownerBody.overall.providers).toEqual([
      expect.objectContaining({
        platform: "onlyfans",
        recent429s: 1,
        recent5xxs: 1,
        rateHealth: expect.objectContaining({
          state: "limited",
          nextAvailableAt: seeded.retryAt.toISOString(),
        }),
      }),
    ]);

    const lanaOfPage = ownerBody.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana-of");
    expect(lanaOfPage).toBeTruthy();
    expect(lanaOfPage.syncUx).toMatchObject({
      state: "attention",
      requiresAction: true,
      headline: "Reconnect to resume sync",
    });
    expect(lanaOfPage.summary).toMatchObject({
      runningStreams: 1,
      blockedStreams: 1,
      stalledStreams: 1,
      pendingStreams: 0,
      retryingStreams: 1,
    });
    expect(lanaOfPage.counts).toMatchObject({
      fans: 4,
      followers: 0,
      subscribers: 0,
      transactions: 0,
      conversations: 4,
      messages: 2,
    });

    const streams = new Map<string, Record<string, unknown>>(
      lanaOfPage.streams.map((stream: { stream: string }) => [stream.stream, stream]),
    );
    // One row per stream the executor runs, in its order, and no other: not
    // the retired `dm_messages`, not a Fansly lane.
    expect([...streams.keys()]).toEqual([
      "light", "transactions", "fan_identities", "top_spenders", "subscribers", "dm_conversations", "posts",
    ]);
    // The monitor derives no progress of its own.
    for (const stream of streams.values()) expect(stream.progress).toBeNull();

    expect(streams.get("light")).toMatchObject({
      status: "running",
      stalled: true,
      syncUx: expect.objectContaining({
        state: "attention",
        headline: "Sync needs attention",
      }),
      pending: false,
      activeRun: expect.objectContaining({
        startedAt: seeded.lightRunningStartedAt.toISOString(),
        lastActivityAt: seeded.lightRunningEventAt.toISOString(),
      }),
      recentRuns: expect.objectContaining({
        running: 1,
        success: 0,
      }),
      rateHealth: expect.objectContaining({
        state: "limited",
      }),
    });
    expect(streams.get("transactions")).toMatchObject({
      status: "retrying",
      pending: false,
      retryAt: seeded.retryAt.toISOString(),
      syncUx: expect.objectContaining({
        state: "retrying",
        headline: "Retrying automatically",
      }),
      recentRuns: expect.objectContaining({
        partial: 1,
      }),
      recentErrors: expect.objectContaining({
        total429s: 1,
        total5xxs: 0,
      }),
      rateHealth: expect.objectContaining({
        state: "limited",
        last429At: seeded.last429At.toISOString(),
      }),
    });
    expect(streams.get("subscribers")).toMatchObject({
      status: "paused",
    });
    expect(streams.get("dm_conversations")).toMatchObject({
      status: "blocked",
      lastErrorSummary: "Session expired",
      syncUx: expect.objectContaining({
        state: "attention",
        headline: "Reconnect to resume sync",
        requiresAction: true,
      }),
    });
    expect(streams.get("top_spenders")).toMatchObject({
      status: "idle",
      failedAt: seeded.topSpendersFailedAt.toISOString(),
      lastErrorSummary: "Top spenders sync failed",
      recentErrors: expect.objectContaining({
        total5xxs: 1,
        failedRuns: 1,
        failedAttempts: 1,
      }),
    });
    const topSpendersStream = streams.get("top_spenders") as
      | { lastCompletion?: { durationMs?: number | null } }
      | undefined;
    expect(typeof topSpendersStream?.lastCompletion?.durationMs).toBe("number");

    expect(ownerBody.recentEvents.map((event: { message: string }) => event.message)).toEqual([
      "Top spenders sync failed",
      "Light sync is active",
      "Transactions backfill slowed by 429s",
    ]);

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status",
      headers: { cookie: leadCookie },
    });

    expect(leadResponse.statusCode).toBe(200);
    const leadBody = leadResponse.json();
    // The lead's pages are lana (Fansly: not in the monitor) and lana-of.
    expect(leadBody.pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana-of"]);
    expect(leadBody.overall.pages).toBe(1);
    // The 7 streams the legacy executor runs (`LEGACY_EXECUTOR_STREAMS`).
    expect(leadBody.overall.streams).toBe(7);
  }, 15_000);

  it("enforces sync monitor page scoping and missing-page handling [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const { lanaOf } = await seedOnlyFansMonitorPages(testDb, fixture);
    await seedSyncMonitorScenario(testDb, lanaOf.id, new Date());

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    for (const label of ["lily-of", "lily1"]) {
      const forbidden = await server.inject({
        method: "GET",
        url: `/api/v1/sync/status?pageLabel=${label}`,
        headers: { cookie: leadCookie },
      });
      expect(forbidden.statusCode, label).toBe(403);
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const missing = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=missing-page",
      headers: { cookie: ownerCookie },
    });
    expect(missing.statusCode).toBe(404);

    const filtered = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=lana-of",
      headers: { cookie: ownerCookie },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana-of"]);

    // A Fansly page exists and is in scope, and the monitor has no row of it.
    const fansly = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=lana",
      headers: { cookie: ownerCookie },
    });
    expect(fansly.statusCode).toBe(200);
    expect(fansly.json().pages).toEqual([]);
    expect(fansly.json().overall).toMatchObject({ pages: 0, streams: 0 });
  }, 15_000);

  it("returns sync block overview rows and keeps OnlyFans legacy history retired [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");
    // lana: a Fansly page the Fansly Sync Engine runs live. lily1: a Fansly
    // page no engine runs. lana-of-sync: an OnlyFans page of the legacy executor.
    await makeEngineLive(testDb, present(fixture.lanaPage, "the fixture page lana").id);

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-sync",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-sync-1",
      username: "lana_of_sync",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: onlyFansPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/sync/overview",
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const fanslyPage = body.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana");
    const unreadFanslyPage = body.pages.find((page: { pageLabel: string }) => page.pageLabel === "lily1");
    const onlyFansOverview = body.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana-of-sync");

    // A live Fansly page: every block is the engine's, with the cadence of the
    // engine's own polls (the registry's), not a legacy stream policy's.
    for (const block of Object.values(fanslyPage.blocks) as Array<{ state: string; engineMode: string }>) {
      expect(block).toMatchObject({ state: "engine", engineMode: "live", statusReason: { code: "fansly_sync_engine" } });
    }
    expect(fanslyPage.blocks.messages_live.intervals).toEqual([
      { stream: "dm_conversations", cadenceSeconds: 1800 },
    ]);
    // The history reads are triggered work, not a poll: no interval.
    expect(fanslyPage.blocks.messages_history.intervals).toEqual([]);
    expect(fanslyPage.blocks.audience.intervals).toEqual([
      { stream: "subscribers", cadenceSeconds: 3600 },
      { stream: "followers", cadenceSeconds: 3600 },
    ]);
    expect(fanslyPage.blocks.connection.connectionStatus).toBe("connected");
    // A Fansly page no engine runs: nothing reads it, and every block says so.
    for (const block of Object.values(unreadFanslyPage.blocks) as Array<Record<string, unknown>>) {
      expect(block).toMatchObject({
        state: "not_available",
        statusReason: { code: "fansly_sync_engine_off" },
        intervals: [],
        substreams: [],
      });
    }
    expect(onlyFansOverview.blocks.connection.connectionStatus).toBeDefined();
    expect(onlyFansOverview.blocks.audience.state).toBe("not_available");
    expect(onlyFansOverview.blocks.messages_live.state).not.toBe("not_available");
    expect(onlyFansOverview.blocks.messages_live.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_conversations", cadenceSeconds: 1800 }),
    ]));
    expect(onlyFansOverview.blocks.messages_history.state).toBe("not_available");
    expect(onlyFansOverview.blocks.messages_history.intervals).toEqual([]);
  }, 15_000);

  it("supports owner-only manual block controls for trigger, pause, resume, and reset [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    server = await buildApiServer(createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
    }));
    await server.ready();

    // Since step 4 (S4-10) the legacy executor serves OnlyFans pages only: a
    // Fansly page off the engine is refused (the engine's levers:
    // tests/sync-engine-levers.integration.test.ts).
    const onlyFansPage = await createOnlyFansPage(activeTestDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-blocks",
    });
    if (!onlyFansPage) throw new Error("Expected the OnlyFans page");
    const now = new Date("2026-03-24T12:00:00.000Z");
    await ensurePageSyncStates(activeTestDb.db, {
      pageId: onlyFansPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const fansly = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/trigger",
      headers: { cookie: ownerCookie },
      payload: { pageLabel: "lana", block: "financials" },
    });
    expect(fansly.statusCode).toBe(409);
    expect(fansly.json()).toMatchObject({ error: "legacy_sync_retired" });

    const trigger = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/trigger",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "financials",
      },
    });
    expect(trigger.statusCode).toBe(200);
    expect(trigger.json()).toMatchObject({
      accepted: true,
      action: "trigger",
      pageLabel: "lana-of-blocks",
      block: "financials",
    });

    const pause = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/pause",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "audience",
      },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({
      accepted: true,
      action: "pause",
      block: "audience",
    });

    const resume = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/resume",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "audience",
      },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      accepted: true,
      action: "resume",
      block: "audience",
    });

    // Stage 2 destruction-door guard: the messages_history reset would
    // hard-delete every stored DM for the page, so it refuses until the
    // message archive exists (Stage 10).
    const reset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "messages_history",
      },
    });
    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({ error: "conflict" });

    // Checkpoint and top-spender resets stay available.
    const audienceReset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "audience",
      },
    });
    expect(audienceReset.statusCode, audienceReset.body).toBe(200);
    expect(audienceReset.json()).toMatchObject({
      accepted: true,
      action: "reset",
      pageLabel: "lana-of-blocks",
      block: "audience",
    });

    const financialsReset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana-of-blocks",
        block: "financials",
      },
    });
    expect(financialsReset.statusCode, financialsReset.body).toBe(200);
    expect(financialsReset.json()).toMatchObject({
      accepted: true,
      action: "reset",
      pageLabel: "lana-of-blocks",
      block: "financials",
    });
  }, 15_000);

  it("gates archive reads to dashboard roles and scopes results (Stage 10)", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role, text_plain, occurred_at)
       values ($1, 'fansly', 'conv-arch-1', 'am-1', 'fan-arch', 'fan', 'archived hello world', now())`,
      [fixture.lanaPage.id],
    );

    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/archive/conversations/conv-arch-1/messages",
      headers: { cookie: ownerCookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).toMatchObject({
      messageRef: "am-1",
      platform: "fansly",
      textPlain: "archived hello world",
    });

    const searched = await server.inject({
      method: "GET",
      url: "/api/v1/archive/search?q=hello%20world",
      headers: { cookie: ownerCookie },
    });
    expect(searched.statusCode, searched.body).toBe(200);
    expect(searched.json()).toHaveLength(1);

    // Chatter bearer keys are not a dashboard surface — 403 on both.
    const appContext = createTestAppContext(testDb);
    const chatterKey = await issueChatterDeviceToken(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const chatterSearch = await server.inject({
      method: "GET",
      url: "/api/v1/archive/search?q=hello%20world",
      headers: { authorization: `Bearer ${chatterKey.key}` },
    });
    expect(chatterSearch.statusCode).toBe(403);
    const chatterList = await server.inject({
      method: "GET",
      url: "/api/v1/archive/conversations/conv-arch-1/messages",
      headers: { authorization: `Bearer ${chatterKey.key}` },
    });
    expect(chatterList.statusCode).toBe(403);
  });

  it("soft-deletes pages: tombstone keeps facts, RESTRICT blocks raw DELETE (Stage 13) [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    // A dedicated fact-bearing page (lana must stay live for later tests).
    const spareModel = await createModel(testDb.db, {
      slug: "stage13-model",
      name: "Stage 13 Model",
    });
    if (!spareModel) {
      throw new Error("model seed failed");
    }
    const factPage = await createFanslyPage(testDb.db, {
      modelId: spareModel.id,
      label: "stage13-facts",
    });
    if (!factPage) {
      throw new Error("page seed failed");
    }
    await upsertTransaction(testDb.db, {
      platformAccountId: factPage.id,
      source: "fansly:rest",
      transactionId: "stage13-tx-1",
      rawType: "2110",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "1",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 8_000n,
      creatorNetAmountMills: 8_000n,
      occurredAt: new Date("2026-06-01T00:00:00Z"),
    });
    // Rollups are what the revenue report reads (W7.2 assertions below).
    await rebuildRevenueRollups(testDb.db, factPage.id);

    // DELETE route on a fact-bearing page tombstones — no 409, no data loss.
    const softDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-facts",
      headers: { cookie: ownerCookie },
    });
    expect(softDelete.statusCode, softDelete.body).toBe(200);
    expect(softDelete.json()).toEqual({ deleted: true });

    const tombstoned = await testDb.pool.query<{ status: string; deleted_at: Date | null }>(
      "select status, deleted_at from pages where label = 'stage13-facts'",
    );
    expect(tombstoned.rows[0]?.status).toBe("deleted");
    expect(tombstoned.rows[0]?.deleted_at).not.toBeNull();
    const factsRemain = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from transactions where platform_account_id = $1",
      [factPage.id],
    );
    expect(factsRemain.rows[0]?.count).toBe("1");

    // The 38-FK cascade door is closed: a raw DELETE refuses at the FK level.
    await expect(
      testDb.pool.query("delete from pages where label = 'stage13-facts'"),
    ).rejects.toThrow(/violates foreign key constraint/);

    // A tombstoned page is gone from operational surfaces: repeat delete 404s,
    // admin list omits it.
    const repeatDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-facts",
      headers: { cookie: ownerCookie },
    });
    expect(repeatDelete.statusCode).toBe(404);
    const adminPages = await server.inject({
      method: "GET",
      url: "/api/v1/admin/pages",
      headers: { cookie: ownerCookie },
    });
    expect(adminPages.statusCode).toBe(200);
    expect(JSON.stringify(adminPages.json())).not.toContain("stage13-facts");

    // An empty page tombstones the same way (row remains, status flips).
    await createFanslyPage(testDb.db, {
      modelId: spareModel.id,
      label: "stage13-empty",
    });
    const emptyDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-empty",
      headers: { cookie: ownerCookie },
    });
    expect(emptyDelete.statusCode, emptyDelete.body).toBe(200);
    expect(emptyDelete.json()).toEqual({ deleted: true });
    const emptyRow = await testDb.pool.query<{ status: string }>(
      "select status from pages where label = 'stage13-empty'",
    );
    expect(emptyRow.rows[0]?.status).toBe("deleted");

    // Tombstoned pages leave the visible-model surface (review R2-3): both of
    // stage13-model's pages are deleted, so the model disappears from
    // GET /models instead of listing with a positive pageCount and no pages.
    const models = await server.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { cookie: ownerCookie },
    });
    expect(models.statusCode).toBe(200);
    const modelSlugs = (models.json() as Array<{ slug: string }>).map((m) => m.slug);
    expect(modelSlugs).not.toContain("stage13-model");
    // The admin/catalog surface deliberately still sees tombstoned pages
    // (model deletion stays refused while tombstones exist).
    const adminModels = await server.inject({
      method: "GET",
      url: "/api/v1/admin/models",
      headers: { cookie: ownerCookie },
    });
    expect(JSON.stringify(adminModels.json())).toContain("stage13-model");

    // W7.2 (A33, decision #131): revenue ROLLUPS keep the tombstoned page's
    // history — the facts never left `transactions`, so the totals must not
    // lie by the page's lifetime net.
    const overviewRevenue = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue?period=all",
      headers: { cookie: ownerCookie },
    });
    expect(overviewRevenue.statusCode, overviewRevenue.body).toBe(200);
    const revenueBody = overviewRevenue.json() as {
      pages: Array<{ pageLabel: string; netEarningsMills: number; status?: string }>;
      models: Array<{ modelSlug: string; netEarningsMills: number; status?: string }>;
    };
    const retiredPage = revenueBody.pages.find((row) => row.pageLabel === "stage13-facts");
    expect(retiredPage).toMatchObject({ netEarningsMills: 8_000, status: "deleted" });
    const retiredModel = revenueBody.models.find((row) => row.modelSlug === "stage13-model");
    expect(retiredModel).toMatchObject({ netEarningsMills: 8_000, status: "retired" });

    // The model revenue report stays reachable for a fully-retired model...
    const modelRevenue = await server.inject({
      method: "GET",
      url: "/api/v1/models/stage13-model/revenue?period=all",
      headers: { cookie: ownerCookie },
    });
    expect(modelRevenue.statusCode, modelRevenue.body).toBe(200);
    // ...while the PAGE-scoped detail route still 404s (retired pages stay
    // hidden as pages; only rollups keep history).
    const pageRevenue = await server.inject({
      method: "GET",
      url: "/api/v1/pages/stage13-facts/revenue?period=all",
      headers: { cookie: ownerCookie },
    });
    expect(pageRevenue.statusCode).toBe(404);
  });

  it("lists recent sync requests with field mapping, scope-aware proxy gaps, and since filtering [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const currentTestDb = testDb!;
    const currentFixture = fixture!;
    const now = new Date();
    const seeded = await seedSyncRequestsScenario(currentTestDb, {
      lanaPageId: currentFixture.lanaPage.id,
      lilyPageId: currentFixture.lilyPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: ownerCookie },
    });

    expect(ownerResponse.statusCode).toBe(200);
    const ownerBody = ownerResponse.json();
    expect(ownerBody).toHaveLength(5);
    expect(ownerBody.map((item: { timestamp: string }) => item.timestamp)).toEqual([
      seeded.lanaStartedAt.toISOString(),
      seeded.lilySharedAt.toISOString(),
      seeded.lilyGhostAt.toISOString(),
      seeded.lanaRetryAt.toISOString(),
      seeded.lanaFailedAt.toISOString(),
    ]);
    expect(ownerBody[0]).toMatchObject({
      timestamp: seeded.lanaStartedAt.toISOString(),
      pageLabel: "lana",
      platform: "fansly",
      stream: "dm_messages",
      operation: "messages",
      endpoint: "/message",
      method: "GET",
      attemptNumber: 1,
      status: "started",
      httpStatusCode: null,
      durationMs: null,
      rateLimitWaitMs: 1200,
      groupId: "group-live-1",
      partnerUsername: "fan_live",
      returnedItems: null,
      syncDone: null,
      proxyGapMs: null,
    });
    expect(ownerBody[1]).toMatchObject({
      timestamp: seeded.lilySharedAt.toISOString(),
      pageLabel: "lily1",
      platform: "fansly",
      stream: "followers",
      operation: "followers",
      endpoint: "/account/:accountId/followersnew",
      method: "GET",
      attemptNumber: 1,
      status: "success",
      httpStatusCode: 200,
      durationMs: 240,
      rateLimitWaitMs: null,
      groupId: null,
      proxyGapMs: 1000,
    });
    expect(ownerBody[2]).toMatchObject({
      timestamp: seeded.lilyGhostAt.toISOString(),
      pageLabel: "lily1",
      platform: "fansly",
      stream: "dm_messages",
      operation: "messages",
      endpoint: "/message",
      method: "GET",
      attemptNumber: 1,
      status: "success",
      httpStatusCode: 200,
      durationMs: 320,
      rateLimitWaitMs: null,
      groupId: "group-ghost-1",
      partnerUsername: null,
      returnedItems: 2,
      syncDone: true,
      proxyGapMs: null,
    });
    expect(ownerBody[3]).toMatchObject({
      timestamp: seeded.lanaRetryAt.toISOString(),
      pageLabel: "lana",
      platform: "fansly",
      stream: "transactions",
      operation: "earnings_transactions",
      endpoint: "/account/wallets/earnings/transactions",
      method: "GET",
      attemptNumber: 2,
      status: "retry",
      httpStatusCode: 429,
      durationMs: 650,
      rateLimitWaitMs: 2500,
      groupId: null,
      proxyGapMs: 4000,
    });
    expect(ownerBody[4]).toMatchObject({
      timestamp: seeded.lanaFailedAt.toISOString(),
      pageLabel: "lana",
      stream: "followers",
      status: "failed",
      httpStatusCode: 500,
      durationMs: 900,
      proxyGapMs: null,
    });

    const withOlderSince = await server.inject({
      method: "GET",
      url: `/api/v1/sync/requests?since=${encodeURIComponent(new Date(now.getTime() - 120_000).toISOString())}&limit=10`,
      headers: { cookie: ownerCookie },
    });
    expect(withOlderSince.statusCode).toBe(200);
    expect(withOlderSince.json()).toHaveLength(6);
    expect(withOlderSince.json().at(-1)).toMatchObject({
      timestamp: seeded.oldAttemptAt.toISOString(),
      endpoint: "/account/me",
      method: "GET",
      status: "success",
    });

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: leadCookie },
    });

    expect(leadResponse.statusCode).toBe(200);
    const leadBody = leadResponse.json();
    expect(leadBody.map((item: { pageLabel: string }) => item.pageLabel)).toEqual([
      "lana",
      "lana",
      "lana",
    ]);
    expect(leadBody[0]?.proxyGapMs).toBeNull();
    expect(leadBody[1]).toMatchObject({
      timestamp: seeded.lanaRetryAt.toISOString(),
      proxyGapMs: 5000,
    });

    await unassignPageFromUser(createTestAppContext(currentTestDb), {
      userId: await fixtureUserId(createTestAppContext(currentTestDb), "lead"),
      pageLabel: "lana",
    }, { source: "cli" });

    const noScopeResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: leadCookie },
    });
    expect(noScopeResponse.statusCode).toBe(200);
    expect(noScopeResponse.json()).toEqual([]);
  }, 15_000);

  it("clamps sync request limits to 500 rows [sync-critical]", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const currentTestDb = testDb!;
    const currentFixture = fixture!;
    const now = new Date();
    const bulkRun = await seedMonitorRunningRun(currentTestDb, {
      pageId: currentFixture.lanaPage.id,
      stream: "light",
      startedAt: new Date(now.getTime() - 10_000),
    });

    await Promise.all(
      Array.from({ length: 510 }, (_, index) => seedMonitorAttempt(currentTestDb, {
        runId: bulkRun.id,
        pageId: currentFixture.lanaPage.id,
        stream: "light",
        operation: "account_me",
        startedAt: new Date(now.getTime() - index),
        state: "started",
        requestShape: {
          endpointTemplate: "/account/me",
          method: "GET",
          egressKey: "bulk-proxy",
        },
      })),
    );

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/sync/requests?since=${encodeURIComponent(new Date(now.getTime() - 120_000).toISOString())}&limit=999`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(500);
    expect(body[0]).toMatchObject({
      timestamp: now.toISOString(),
      endpoint: "/account/me",
    });
    expect(body.at(-1)?.timestamp).toBe(new Date(now.getTime() - 499).toISOString());
  }, 30_000);
});
