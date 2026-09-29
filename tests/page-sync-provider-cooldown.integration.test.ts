import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  acquireTargetedPageSyncLease,
  armPageSyncProviderHold,
  completePageSync,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getFanslyFastLanePageSyncGate,
  getPageSyncState,
  listRunnablePageSync,
  requestPageSync,
  retryPageSync,
  startSyncRun,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import {
  resetIntegrationDatabase, seedFanslyPage, startIntegrationTestDatabase, type StartedTestDatabase,
} from "./helpers/db.ts";
import { fakeTelemetry, groupsPage, PAGE_ACCOUNT_ID, sweepAdapter } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

describe("page sync provider cooldown", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });
  afterAll(async () => {
    await testDb?.stop();
  });
  beforeEach(async (context) => {
    if (!testDb) return context.skip();
    await resetIntegrationDatabase(testDb.pool);
  });

  async function seedLease(stream: "light" | "dm_messages" = "light") {
    const now = new Date();
    const model = await createModel(testDb!.db, { slug: "cooldown", name: "Cooldown" });
    if (!model) throw new Error("Expected to create cooldown model");
    const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "cooldown" });
    if (!page) throw new Error("Expected to create cooldown page");
    await ensurePageSyncStates(testDb!.db, { pageId: page.id, now });
    // Settle prerequisite history so the real dispatcher can select only this stream.
    await testDb!.pool.query(
      `update page_sync_states
       set applied_seq = request_seq, status = 'idle', succeeded_at = $3,
           blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null
       where page_id = $1 and stream <> $2`,
      [page.id, stream, now],
    );
    await requestPageSync(testDb!.db, {
      pageId: page.id, streams: [stream], source: "recovery", now,
      requestPayloadByStream: { [stream]: { reason: "older request" } },
    });
    const lease = await acquirePageSyncLease(testDb!.db, {
      pageId: page.id, workerId: "worker", leaseToken: "original", leaseTtlMs: 60_000, now,
    });
    if (!lease || lease.stream !== stream) throw new Error(`Expected ${stream} lease`);
    return { page, lease, now };
  }

  it.each([
    ["rate_limit", "before", "manual"],
    ["rate_limit", "after", "scheduled"],
    ["provider_5xx", "before", "scheduled"],
    ["provider_5xx", "after", "manual"],
  ] as const)("keeps %s cooldown when a request arrives %s the retry (%s)", async (retryKind, order, source) => {
    const { page, lease, now } = await seedLease();
    const retryAt = new Date(now.getTime() + 86_400_000);
    const requestedAt = new Date(now.getTime() + 2_000);
    const queueLatest = () => requestPageSync(testDb!.db, {
      pageId: page.id, streams: ["light"], source, now: requestedAt,
      requestPayloadByStream: { light: { reason: "latest request" } },
    });
    if (order === "before") await queueLatest();
    expect(await retryPageSync(testDb!.db, {
      pageId: page.id, stream: "light", requestSeq: lease.requestSeq, leaseToken: "original",
      retryKind, retryAt, errorCode: "provider_busy", errorSummary: "Provider cooldown",
      now: new Date(now.getTime() + (order === "before" ? 3_000 : 1_000)),
    })).toEqual({ updated: true, retried: true });
    if (order === "after") await queueLatest();

    const requestSeq = lease.requestSeq + 1;
    expect(await getPageSyncState(testDb!.db, page.id, "light")).toMatchObject({
      status: "retrying", requestSeq, appliedSeq: lease.appliedSeq,
      requestSource: source, dispatchSource: source, requestedAt,
      requestPayload: { reason: "latest request", revision: requestSeq },
      retryKind, retryAt, consecutiveFailures: 1, lastErrorCode: "provider_busy",
      leasedSeq: null, leaseToken: null,
    });
    const beforeDeadline = new Date(retryAt.getTime() - 1);
    expect(await listRunnablePageSync(testDb!.db, beforeDeadline)).toEqual([]);
    const acquire = (at: Date) => acquirePageSyncLease(testDb!.db, {
      pageId: page.id, workerId: "next-worker", leaseToken: "next", leaseTtlMs: 60_000, now: at,
    });
    expect(await acquire(beforeDeadline)).toBeNull();
    expect(await acquireTargetedPageSyncLease(testDb!.db, {
      pageId: page.id, stream: "light", workerId: "targeted", leaseToken: "targeted",
      leaseTtlMs: 60_000, now: beforeDeadline,
    })).toBeNull();
    expect(await acquire(retryAt)).toMatchObject({
      requestSeq, leasedSeq: requestSeq, requestSource: source, dispatchSource: source,
      requestPayload: { reason: "latest request", revision: requestSeq },
    });
    expect(await completePageSync(testDb!.db, {
      pageId: page.id, stream: "light", requestSeq, leaseToken: "next", now: retryAt,
    })).toBe(true);
    expect(await getPageSyncState(testDb!.db, page.id, "light")).toMatchObject({
      status: "idle", appliedSeq: requestSeq, retryKind: null, retryAt: null,
    });
  });

  it.each([
    ["transient_network", "before", 60_000],
    ["transient_network", "after", 60_000],
    ["rate_limit", "before", -1],
    ["provider_5xx", "after", -1],
  ] as const)("allows manual supersession of %s with request %s retry (delay %i)", async (retryKind, order, delay) => {
    const { page, lease, now } = await seedLease();
    const queueLatest = () => requestPageSync(testDb!.db, {
      pageId: page.id, streams: ["light"], source: "manual", now,
    });
    if (order === "before") await queueLatest();
    await retryPageSync(testDb!.db, {
      pageId: page.id, stream: "light", requestSeq: lease.requestSeq, leaseToken: "original",
      retryKind, retryAt: new Date(now.getTime() + delay),
      errorCode: "retry", errorSummary: "Retry", now,
    });
    if (order === "after") await queueLatest();
    expect(await getPageSyncState(testDb!.db, page.id, "light")).toMatchObject({
      status: "pending", requestSeq: lease.requestSeq + 1, requestSource: "manual",
      retryKind: null, retryAt: null,
    });
    expect(await acquirePageSyncLease(testDb!.db, {
      pageId: page.id, workerId: "next-worker", leaseToken: "next", leaseTtlMs: 60_000, now,
    })).toMatchObject({ leasedSeq: lease.requestSeq + 1 });
  });

  it("queues the actual DM sweep follow-up without waking dm_messages inside its cooldown", async () => {
    const { page, lease, now } = await seedLease("dm_messages");
    const retryAt = new Date(now.getTime() + 86_400_000);
    await retryPageSync(testDb!.db, {
      pageId: page.id, stream: "dm_messages", requestSeq: lease.requestSeq, leaseToken: "original",
      retryKind: "rate_limit", retryAt, errorCode: "http_429", errorSummary: "Rate limited", now,
    });
    const { adapter, calls } = sweepAdapter({
      pages: [groupsPage({ conversations: ["new-thread"], total: 1, offset: 0, done: true })],
    });
    const app = createTestAppContext(testDb!, { syncSharedRateLimitEnabled: true, adapter });
    const run = await startSyncRun(testDb!.db, {
      platformAccountId: page.id, stream: "dm_conversations", trigger: "manual",
    });
    if (!run) throw new Error("Expected to create DM sweep run");
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
    expect(await getPageSyncState(testDb!.db, page.id, "dm_messages")).toMatchObject({
      status: "retrying", requestSeq: lease.requestSeq + 1,
      requestSource: "scheduled", dispatchSource: "scheduled", requestPayload: {},
      retryKind: "rate_limit", retryAt,
    });
    expect(await acquirePageSyncLease(testDb!.db, {
      pageId: page.id, workerId: "follow-up", leaseToken: "follow-up", leaseTtlMs: 60_000, now: new Date(),
    })).toBeNull();
  });

  // R04: a Fansly 429 speaks for the page's session, not for one endpoint. The
  // real executor meets it on transactions; the page's other streams must not
  // reach Fansly inside the provider's window, and their rows stay untouched.
  async function seedHeldPage(input: { failure: () => FanslyApiError; transactionsStreak?: number }) {
    const getTransactionsPage = vi.fn(async () => {
      throw input.failure();
    });
    const getSubscribersPage = vi.fn(async () => ({
      total: 0, items: [], offset: 0, done: true, contractAccepted: true,
      raw: { stats: { totalActive: 0, totalExpired: 0, total: 0 }, subscriptions: [] },
    }));
    const app = createTestAppContext(testDb!, {
      adapter: { getTransactionsPage, getSubscribersPage } as unknown as AppContext["adapter"],
      fanslyDefaultDelayMs: 0,
    });
    const { model, page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, "held");
    if (!model || !page) throw new Error("Expected to seed the held page");
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    const neighbour = await createFanslyPage(app.db, { modelId: model.id, label: "neighbour" });
    if (!neighbour) throw new Error("Expected to create the neighbour page");
    for (const pageId of [page.id, neighbour.id]) await ensurePageSyncStates(app.db, { pageId });
    // Every stream settled and idle, so each case queues exactly what it names.
    await testDb!.pool.query(
      `update page_sync_states
       set applied_seq = request_seq, status = 'idle', succeeded_at = now(),
           blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null,
           consecutive_failures = case when page_id = $2 and stream = 'transactions' then $3 else 0 end
       where page_id = any($1::bigint[])`,
      [[page.id, neighbour.id], page.id, input.transactionsStreak ?? 0],
    );
    await requestPageSync(app.db, { pageId: page.id, streams: ["transactions"], source: "scheduled" });
    await requestPageSync(app.db, { pageId: neighbour.id, streams: ["subscribers"], source: "scheduled" });
    return { app, page, neighbour, getTransactionsPage, getSubscribersPage };
  }

  const rateLimited = (retryAfterAt: Date | null) => () =>
    new FanslyApiError("Fansly request failed (429)", 429, undefined, undefined, retryAfterAt);

  async function anomalyCodes(runId: number) {
    const result = await testDb!.pool.query<{ code: string }>(
      "select details->>'code' as code from sync_run_events where sync_run_id = $1 and event_type = 'anomaly'",
      [runId],
    );
    return result.rows.map((row) => row.code);
  }

  const leaseAt = (pageId: number, now: Date) => acquirePageSyncLease(testDb!.db, {
    pageId, workerId: "next-worker", leaseToken: `next-${pageId}-${now.getTime()}`, leaseTtlMs: 60_000, now,
  });

  async function holdUntil(pageId: number) {
    const result = await testDb!.pool.query<{ until: Date }>(
      "select hold_until as until from page_sync_provider_holds where page_id = $1",
      [pageId],
    );
    return result.rows[0]?.until ?? null;
  }

  const inSequence = (...failures: FanslyApiError[]) => () => {
    const failure = failures.shift();
    if (!failure) throw new Error("Unexpected extra Fansly request");
    return failure;
  };

  it("holds every stream of the page until a first 429's Retry-After, leaving their rows alone", async () => {
    const retryAfterAt = new Date(Date.now() + 600_000);
    const f = await seedHeldPage({ failure: rateLimited(retryAfterAt) });

    const failed = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(failed).toMatchObject({ kind: "failed", stream: "transactions", needsContinuation: false });
    expect(f.getTransactionsPage).toHaveBeenCalledTimes(1);
    // The failing stream keeps its own retry: the provider's deadline, as before.
    expect(await getPageSyncState(f.app.db, f.page.id, "transactions")).toMatchObject({
      status: "retrying", retryKind: "rate_limit", retryAt: retryAfterAt, consecutiveFailures: 1,
    });

    // "Sync now" on a sibling and a B1 wake of the idle DM stream both queue
    // as usual; neither may start inside the provider's window.
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["dm_messages"], source: "event" });
    for (const stream of ["subscribers", "dm_messages"] as const) {
      expect(await getPageSyncState(f.app.db, f.page.id, stream)).toMatchObject({
        status: "pending", retryKind: null, retryAt: null, consecutiveFailures: 0, lastErrorCode: null,
      });
    }
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "idle", stream: null });
    expect(f.getSubscribersPage).not.toHaveBeenCalled();

    const beforeDeadline = new Date(retryAfterAt.getTime() - 1);
    expect((await listRunnablePageSync(f.app.db, beforeDeadline)).map((row) => row.pageId))
      .toEqual([f.neighbour.id]);
    expect(await leaseAt(f.page.id, beforeDeadline)).toBeNull();
    expect(await acquireTargetedPageSyncLease(f.app.db, {
      pageId: f.page.id, stream: "dm_messages", workerId: "targeted", leaseToken: "targeted",
      leaseTtlMs: 60_000, now: beforeDeadline,
    })).toBeNull();
    // Another page of the same model is not held.
    expect(await leaseAt(f.neighbour.id, beforeDeadline)).toMatchObject({ stream: "subscribers" });
    expect(await anomalyCodes(failed.runId!)).toContain("page_provider_hold");

    // At the deadline the page is runnable again, the operator's sibling first.
    expect((await listRunnablePageSync(f.app.db, retryAfterAt)).map((row) => row.pageId)).toContain(f.page.id);
    expect(await leaseAt(f.page.id, retryAfterAt)).toMatchObject({ stream: "subscribers", requestSource: "manual" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds the siblings for the whole of a Retry-After beyond 30 minutes", async () => {
    const retryAfterAt = new Date(Date.now() + 3_600_000);
    const f = await seedHeldPage({ failure: rateLimited(retryAfterAt) });

    await executeNextSyncPageChunk(f.app, f.page.id);
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });

    // Never capped: the siblings wait exactly as long as the failing stream.
    expect(await getPageSyncState(f.app.db, f.page.id, "transactions")).toMatchObject({ retryAt: retryAfterAt });
    expect(await holdUntil(f.page.id)).toEqual(retryAfterAt);
    expect(await leaseAt(f.page.id, new Date(Date.now() + 30 * 60_000 + 1_000))).toBeNull();
    expect(await leaseAt(f.page.id, new Date(retryAfterAt.getTime() - 1))).toBeNull();
    expect(await leaseAt(f.page.id, retryAfterAt)).toMatchObject({ stream: "subscribers" });
    expect(f.getSubscribersPage).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each([
    ["a 5xx", () => new FanslyApiError("Fansly request failed (500)", 500)],
    ["an earlier 429 whose hold has passed", () => rateLimited(new Date(Date.now() + 600_000))()],
  ] as const)("holds the page until a later 429's Retry-After after %s in the same streak", async (_name, first) => {
    const retryAfterAt = new Date(Date.now() + 900_000);
    const f = await seedHeldPage({ failure: inSequence(first(), rateLimited(retryAfterAt)()) });
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "failed", stream: "transactions" });
    // The stream's own wait, and any earlier hold, pass before it runs again.
    await testDb!.pool.query(
      `update page_sync_states set retry_at = now() - interval '1 second'
       where page_id = $1 and stream = 'transactions'`,
      [f.page.id],
    );
    await testDb!.pool.query(
      "update page_sync_provider_holds set hold_until = now() - interval '1 second' where page_id = $1",
      [f.page.id],
    );

    const failed = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(failed).toMatchObject({ kind: "failed", stream: "transactions" });
    expect(f.getTransactionsPage).toHaveBeenCalledTimes(2);
    expect(await getPageSyncState(f.app.db, f.page.id, "transactions")).toMatchObject({
      status: "retrying", retryKind: "rate_limit", retryAt: retryAfterAt, consecutiveFailures: 2,
    });
    expect(await holdUntil(f.page.id)).toEqual(retryAfterAt);
    expect(await anomalyCodes(failed.runId!)).toContain("page_provider_hold");
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "idle" });
    expect(await leaseAt(f.page.id, new Date(retryAfterAt.getTime() - 1))).toBeNull();
    expect(await leaseAt(f.page.id, retryAfterAt)).toMatchObject({ stream: "subscribers" });
    expect(f.getSubscribersPage).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("runs the siblings through the executor once the hold has passed", async () => {
    const f = await seedHeldPage({ failure: rateLimited(null) });
    const failedAt = Date.now();
    await executeNextSyncPageChunk(f.app, f.page.id);
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "idle" });
    // No Retry-After: a fixed two-minute hold, longer than the stream's first rung.
    const hold = await holdUntil(f.page.id);
    expect(hold?.getTime()).toBeGreaterThanOrEqual(failedAt + 120_000);
    expect(hold?.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);

    await testDb!.pool.query(
      "update page_sync_provider_holds set hold_until = now() - interval '1 second' where page_id = $1",
      [f.page.id],
    );

    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not hold the page again for a later 429 without a Retry-After in the same failure streak", async () => {
    const f = await seedHeldPage({ failure: rateLimited(null), transactionsStreak: 1 });

    const failed = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(failed).toMatchObject({ kind: "failed", stream: "transactions" });
    expect(await getPageSyncState(f.app.db, f.page.id, "transactions")).toMatchObject({
      status: "retrying", retryKind: "rate_limit", consecutiveFailures: 2,
    });
    expect(await holdUntil(f.page.id)).toBeNull();
    expect(await anomalyCodes(failed.runId!)).not.toContain("page_provider_hold");
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not hold the page for a 5xx that names a Retry-After", async () => {
    const retryAfterAt = new Date(Date.now() + 600_000);
    const f = await seedHeldPage({
      failure: () => new FanslyApiError("Fansly request failed (503)", 503, undefined, undefined, retryAfterAt),
    });

    const failed = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(await getPageSyncState(f.app.db, f.page.id, "transactions")).toMatchObject({
      status: "retrying", retryKind: "provider_5xx", retryAt: retryAfterAt, consecutiveFailures: 1,
    });
    expect(await anomalyCodes(failed.runId!)).not.toContain("page_provider_hold");
    await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["subscribers"], source: "manual" });
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never shortens a hold already in force", async () => {
    const f = await seedHeldPage({ failure: rateLimited(null) });
    const now = new Date();
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
    const arm = (holdUntil: Date) => armPageSyncProviderHold(f.app.db, {
      pageId: f.page.id, stream: "transactions", syncRunId: null, reason: "rate_limit",
      holdUntil, retryAfterAt: null, now,
    });

    expect(await arm(at(600_000))).toEqual(at(600_000));
    expect(await arm(at(120_000))).toBeNull();
    expect(await leaseAt(f.page.id, at(300_000))).toBeNull();
    expect(await arm(at(900_000))).toEqual(at(900_000));
    expect(await leaseAt(f.page.id, at(899_999))).toBeNull();
    expect(await leaseAt(f.page.id, at(900_000))).toMatchObject({ stream: "transactions" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the fast lane off a held page even when the failing stream's own retry is cleared", async () => {
    const f = await seedHeldPage({ failure: rateLimited(new Date(Date.now() + 1_200_000)) });
    await executeNextSyncPageChunk(f.app, f.page.id);
    // An operator reset clears the stream's cooldown; the page hold is separate.
    await testDb!.pool.query(
      `update page_sync_states set status = 'pending', retry_kind = null, retry_at = null
       where page_id = $1 and stream = 'transactions'`,
      [f.page.id],
    );
    const now = new Date();
    expect(await getFanslyFastLanePageSyncGate(f.app.db, { pageId: f.page.id, now }))
      .toMatchObject({ cooldown: true });
    expect(await getFanslyFastLanePageSyncGate(f.app.db, {
      pageId: f.neighbour.id, peerPageIds: [f.page.id], now,
    })).toMatchObject({ cooldown: true });
    expect(await getFanslyFastLanePageSyncGate(f.app.db, { pageId: f.neighbour.id, now }))
      .toMatchObject({ cooldown: false });
    expect(await leaseAt(f.page.id, now)).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
