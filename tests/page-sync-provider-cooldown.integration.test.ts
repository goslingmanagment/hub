import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  completePageSync,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getPageSyncState,
  listRunnablePageSync,
  requestPageSync,
  retryPageSync,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase,
} from "./helpers/db.ts";

import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

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
    const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "cooldown" });
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
      platforms: EVERY_PLATFORM,
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
    expect(await listRunnablePageSync(testDb!.db, beforeDeadline, { platforms: EVERY_PLATFORM })).toEqual([]);
    const acquire = (at: Date) => acquirePageSyncLease(testDb!.db, {
      platforms: EVERY_PLATFORM,
      pageId: page.id, workerId: "next-worker", leaseToken: "next", leaseTtlMs: 60_000, now: at,
    });
    expect(await acquire(beforeDeadline)).toBeNull();
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
      platforms: EVERY_PLATFORM,
      pageId: page.id, workerId: "next-worker", leaseToken: "next", leaseTtlMs: 60_000, now,
    })).toMatchObject({ leasedSeq: lease.requestSeq + 1 });
  });

  // R04 held every stream of a page inside a Fansly 429's window
  // (`page_sync_provider_holds`). Only a Fansly answer armed it, and the legacy
  // executor serves no Fansly page (step 4), so nothing arms or obeys a hold
  // any more: a row an older build left in force keeps no stream from leasing.
  it("a provider hold row left in force holds nothing", async () => {
    const stream = "light";
    const now = new Date();
    const model = await createModel(testDb!.db, { slug: "held", name: "Held" });
    const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: "held" });
    await ensurePageSyncStates(testDb!.db, { pageId: page!.id, now });
    await testDb!.pool.query(
      `update page_sync_states
       set applied_seq = request_seq, status = 'idle', succeeded_at = $2,
           blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null
       where page_id = $1`,
      [page!.id, now],
    );
    await requestPageSync(testDb!.db, { pageId: page!.id, streams: [stream], source: "scheduled", now });
    await testDb!.pool.query(
      `insert into page_sync_provider_holds (page_id, hold_until, reason, stream, armed_at)
       values ($1, $2, 'rate_limit', 'transactions', $3)`,
      [page!.id, new Date(now.getTime() + 600_000), now],
    );

    expect((await listRunnablePageSync(testDb!.db, now, { platforms: EVERY_PLATFORM })).map((row) => row.pageId)).toEqual([page!.id]);
    expect(await acquirePageSyncLease(testDb!.db, {
      platforms: EVERY_PLATFORM,
      pageId: page!.id, workerId: "held", leaseToken: "held", leaseTtlMs: 60_000, now,
    })).toMatchObject({ stream });
    // The row stays as a record.
    expect((await testDb!.pool.query("select count(*)::int as n from page_sync_provider_holds")).rows[0].n).toBe(1);
  });
});
