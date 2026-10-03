import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  acquireTargetedPageSyncLease,
  armPageSyncProviderHold,
  completePageSync,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getPageSyncState,
  listRunnablePageSync,
  requestPageSync,
  retryPageSync,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  resetIntegrationDatabase, seedFanslyPage, startIntegrationTestDatabase, type StartedTestDatabase,
} from "./helpers/db.ts";
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

  async function seedLease() {
    const stream = "light";
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

  // R04: a provider hold speaks for the page's session, not for one endpoint:
  // the page's other streams lease nothing inside the provider's window. (The
  // executor's own Fansly 429 path is unreachable since step 4 S4-10: the
  // legacy executor runs no Fansly stream.)
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

  const leaseAt = (pageId: number, now: Date) => acquirePageSyncLease(testDb!.db, {
    pageId, workerId: "next-worker", leaseToken: `next-${pageId}-${now.getTime()}`, leaseTtlMs: 60_000, now,
  });

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
});
