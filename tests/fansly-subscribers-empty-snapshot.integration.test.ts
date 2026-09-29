import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePageSyncStates, getCheckpoint, getPageSyncState, openNotificationIncidentWithRecoveryGuard,
  retireLapsedPageSubscriptionsForEmptySnapshot, upsertCheckpointProgress, upsertFanPages, upsertFans,
  upsertPageSubscription,
} from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import {
  resolvePageContextById, saveProxy, type ResolvedFanslyPageContext,
} from "../apps/runtime/src/services/page-context.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { refreshPageMetadata } from "../apps/runtime/src/services/sync/shared.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Production lilly-1 on 2026-09-28: one current subscription that lapsed at
// 15:47:35 with auto-renew off, then every /subscribers?status=3,4 answer was
// an accepted contract with zero rows and totalActive=0.
const REQUEST_SEQ = 4123;
const LILLY_ENDS_AT = "2026-09-28T15:47:35.000Z";
const LILLY_LAST_SEEN_AT = "2026-09-28T14:54:27.297Z";
const LILLY_HISTORY_BACKFILLED_AT = "2026-07-31T20:54:48.947Z";
const LEGACY_CURSOR = {
  mode: "active", offset: 0, revision: REQUEST_SEQ, pageCount: 0, generation: 4122,
  observedCount: 0, historyBackfilledAt: LILLY_HISTORY_BACKFILLED_AT, providerReportedTotal: null,
};
const REFUSAL = "Subscriber sync returned zero rows; refusing destructive finalization";

type SeededSubscription = {
  id: string;
  endsAt: string | null;
  autoRenew: boolean | null;
  lastSeenAt?: string;
};
type SubscribersPage = {
  total?: number | null | undefined; items: unknown[]; offset: number; done: boolean;
  contractAccepted?: boolean | undefined; raw: unknown;
};

const lapsed = (id: string): SeededSubscription => ({ id, endsAt: LILLY_ENDS_AT, autoRenew: false });
const renewing = (id: string): SeededSubscription => ({ id, endsAt: "2099-01-01T00:00:00.000Z", autoRenew: true });
// Production lilly-2 on 2026-09-29: row 197, set to renew on 2026-10-24. A
// failed renewal leaves Fansly stating zero over a row the lapsed rule cannot
// explain.
const LILLY_2_RENEWING: SeededSubscription = {
  id: "860004140804231169", endsAt: "2026-10-24T00:15:24.000Z", autoRenew: true,
};
// Every shape the lapsed rule refuses, one more than it retires on its own.
const UNEXPLAINED_SIX: SeededSubscription[] = [
  renewing("a"),
  renewing("b"),
  { id: "c", endsAt: "2099-01-01T00:00:00.000Z", autoRenew: false },
  { id: "d", endsAt: null, autoRenew: false },
  { id: "e", endsAt: LILLY_ENDS_AT, autoRenew: null },
  lapsed("f"),
];
const MINUTE_MS = 60_000;
const statedEmpty = (): SubscribersPage => ({
  total: 0, items: [], offset: 0, done: true, contractAccepted: true,
  raw: { stats: { totalActive: 0, totalExpired: 50, total: 50 }, subscriptions: [] },
});
const activeItem = (id: string) => ({
  id, subscriberId: `fan-${id}`, historyId: null, subscriptionTierId: null, subscriptionTierName: null,
  subscriptionTierColor: null, planId: null, status: 3, price: 5000, renewPrice: 5000, autoRenew: 1,
  billingCycle: 30, duration: 30, renewDate: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: null,
  endsAt: "2099-01-01T00:00:00.000Z",
});

describe("Fansly subscribers stated-empty snapshot", () => {
  let db: StartedTestDatabase;
  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

  async function fixture(input: {
    subscriptions: SeededSubscription[];
    cursor?: Record<string, unknown>;
    serve: (params: { offset?: number; status?: string }) => SubscribersPage | Promise<SubscribersPage>;
    /** The /account/me account the light and followers streams read. */
    accountMe?: Record<string, unknown>;
  }) {
    const getSubscribersPage = vi.fn(async (_context: unknown, params: { offset?: number; status?: string }) =>
      input.serve(params));
    const getAccountsByIdsPage = vi.fn(async (_context: unknown, ids: string[]) => ({
      parsed: ids.map((id) => ({ id, username: id, displayName: null, createdAt: 1_770_000_000_000 })),
      raw: {},
    }));
    const account = input.accountMe ?? {
      id: "acct-lilly-1", username: "lilly1", displayName: null, createdAt: 1_700_000_000_000,
      followCount: 10, subscriberCount: 0,
    };
    const getAccountMe = vi.fn(async () => ({ parsed: { account }, raw: { account } }));
    const app = createTestAppContext(db, {
      adapter: { getSubscribersPage, getAccountsByIdsPage, getAccountMe } as unknown as AppContext["adapter"],
      fanslyDefaultDelayMs: 0,
    });
    const { page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, "lilly-1");
    if (!page) throw new Error("test setup: page missing");
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    await ensurePageSyncStates(app.db, { pageId: page.id });
    await db.pool.query("update page_sync_states set status='paused' where page_id=$1 and stream <> 'subscribers'", [page.id]);
    await db.pool.query(`update page_sync_states
      set status='retrying', request_seq=$2::bigint, applied_seq=$2::bigint - 1, retry_kind='transient_network',
          retry_at=now() - interval '1 minute', consecutive_failures=15, last_error_summary=$3,
          succeeded_at=$4, progressed_at=$4
      where page_id=$1 and stream='subscribers'`, [page.id, REQUEST_SEQ, REFUSAL, LILLY_LAST_SEEN_AT]);
    await upsertCheckpointProgress(app.db, {
      platformAccountId: page.id, stream: "subscribers", state: input.cursor ?? LEGACY_CURSOR,
    });
    for (const subscription of input.subscriptions) {
      const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: `fan-${subscription.id}` }]);
      await upsertPageSubscription(app.db, {
        platformSubscriptionId: subscription.id, platformAccountId: page.id, fanId: fan!.id,
        rawStatus: 3, canonicalStatus: "active", priceMills: 5000n, renewPriceMills: 5000n,
        autoRenew: subscription.autoRenew,
        endsAt: subscription.endsAt === null ? null : new Date(subscription.endsAt),
        sourceCreatedAt: new Date("2026-08-29T15:47:35.000Z"),
        lastSeenGeneration: 4121,
      });
      await upsertFanPages(app.db, [{
        fanId: fan!.id, platformAccountId: page.id, isSubscriber: true,
        subscriptionExpiresAt: subscription.endsAt === null ? null : new Date(subscription.endsAt),
        autoRenew: subscription.autoRenew,
      }]);
      await db.pool.query(
        "update page_subscriptions set last_seen_at=$3 where platform_account_id=$1 and platform_subscription_id=$2",
        [page.id, subscription.id, subscription.lastSeenAt ?? LILLY_LAST_SEEN_AT],
      );
    }
    const key = incidentKey({ kind: "stream_failed_threshold", platformAccountId: page.id, stream: "subscribers" });
    await openNotificationIncidentWithRecoveryGuard(app.db, {
      incidentKey: key, kind: "stream_failed_threshold", platformAccountId: page.id, stream: "subscribers",
      occurredAt: new Date("2026-09-28T15:58:55.204Z"),
    });
    return { app, page, key, getSubscribersPage, getAccountsByIdsPage };
  }

  async function subscriptions(pageId: number) {
    return (await db.pool.query<{ platform_subscription_id: string; is_current: boolean; canonical_status: string }>(
      `select platform_subscription_id, is_current, canonical_status from page_subscriptions
       where platform_account_id=$1 order by platform_subscription_id`,
      [pageId],
    )).rows;
  }

  async function currentIds(pageId: number) {
    return (await subscriptions(pageId)).filter((row) => row.is_current).map((row) => row.platform_subscription_id);
  }

  async function anomalies(runId: number) {
    return (await db.pool.query<{ details: Record<string, unknown> }>(
      "select details from sync_run_events where sync_run_id=$1 and event_type='anomaly'",
      [runId],
    )).rows.map((row) => row.details);
  }

  async function incidentStatus(key: string) {
    return (await db.pool.query<{ status: string }>(
      "select status from notification_incidents where incident_key=$1",
      [key],
    )).rows[0]?.status;
  }

  async function emptySnapshotNotes(runId: number) {
    return (await db.pool.query<{ details: Record<string, unknown> }>(
      `select details from sync_run_events
       where sync_run_id=$1 and event_type='note' and details->>'code' like 'subscribers_empty_snapshot%'`,
      [runId],
    )).rows.map((row) => row.details);
  }

  /** Fansly's own /account/me subscriberCount, which the light and followers
   * streams write hourly together with last_verified_at. */
  async function setAccountCounter(pageId: number, subscriberCount: number | null, verifiedAt: Date | null) {
    await db.pool.query(
      "update pages set subscriber_count=$2, last_verified_at=$3 where id=$1",
      [pageId, subscriberCount, verifiedAt],
    );
    return verifiedAt;
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

  it("retires lilly-1's lapsed non-renewing subscription on a stated zero and recovers the stream", async () => {
    const f = await fixture({ subscriptions: [lapsed("889566")], serve: statedEmpty });

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalledTimes(1);
    expect(f.getSubscribersPage.mock.calls[0]?.[1]).toEqual({ limit: 100, offset: 0, status: "3,4" });
    expect(f.getAccountsByIdsPage).not.toHaveBeenCalled();
    // Membership is is_current; the last mapped provider status stays as observed.
    expect(await subscriptions(f.page.id)).toEqual([
      { platform_subscription_id: "889566", is_current: false, canonical_status: "active" },
    ]);
    const fanPage = await db.pool.query(
      "select is_subscriber, subscription_expires_at, auto_renew from page_fans where platform_account_id=$1",
      [f.page.id],
    );
    expect(fanPage.rows).toEqual([{ is_subscriber: false, subscription_expires_at: null, auto_renew: null }]);
    // Rollups were rebuilt from the retired membership (none existed before).
    const rollup = await db.pool.query<{ days: number }>(
      "select count(*)::int as days from daily_subscribers where platform_account_id=$1",
      [f.page.id],
    );
    expect(rollup.rows[0]?.days).toBeGreaterThan(0);

    const checkpoint = await getCheckpoint(f.app.db, f.page.id, "subscribers");
    expect(checkpoint?.cursorLastSucceededRunId).toBe(result.runId);
    expect(checkpoint?.state).toMatchObject({
      revision: REQUEST_SEQ, generation: 4122, mode: "active", pageCount: 1, providerReportedTotal: 0,
      historyBackfilledAt: LILLY_HISTORY_BACKFILLED_AT, walkStartedAt: expect.any(String),
    });
    expect(checkpoint?.state).not.toHaveProperty("destructiveFinalization");
    const state = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(state).toMatchObject({ consecutiveFailures: 0, lastErrorCode: null, lastErrorSummary: null, retryAt: null });
    expect(state?.appliedSeq).toBe(REQUEST_SEQ);
    expect(state?.succeededAt?.getTime()).toBeGreaterThan(Date.parse(LILLY_LAST_SEEN_AT));
    expect(await incidentStatus(f.key)).toBe("resolved");
    expect(await anomalies(result.runId!)).toEqual([]);
    const note = await db.pool.query(
      "select details from sync_run_events where sync_run_id=$1 and event_type='note' and details->>'code'=$2",
      [result.runId, "subscribers_empty_snapshot_certified"],
    );
    expect(note.rows).toEqual([{ details: expect.objectContaining({ retiredCount: 1, generation: 4122 }) }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("judges a retried first read by its own start, not the failed attempt's", async () => {
    // The revision's walk began at 15:40, before the last subscription lapsed
    // at 15:47:35, and its first read failed. The retry keeps the revision and
    // so the cursor, and meets a stated zero long after the expiry.
    const failedAttemptStartedAt = "2026-09-28T15:40:00.000Z";
    let reads = 0;
    const f = await fixture({
      subscriptions: [lapsed("889566")],
      cursor: {
        ...LEGACY_CURSOR, distinctObservedCount: 0, restartCount: 0, walkStartedAt: failedAttemptStartedAt,
      },
      serve: () => {
        reads += 1;
        if (reads === 1) throw new Error("Fansly proxy request timeout");
        return statedEmpty();
      },
    });

    const failed = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(failed.kind).not.toBe("success");
    expect(await currentIds(f.page.id)).toEqual(["889566"]);
    expect((await getCheckpoint(f.app.db, f.page.id, "subscribers"))?.state)
      .toMatchObject({ revision: REQUEST_SEQ, pageCount: 0, walkStartedAt: failedAttemptStartedAt });
    const retrying = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(retrying).toMatchObject({ status: "retrying", requestSeq: REQUEST_SEQ, consecutiveFailures: 16 });
    // Wait out the retry ladder; the retry stays on the same revision.
    await db.pool.query(
      "update page_sync_states set retry_at=now() - interval '1 second' where page_id=$1 and stream='subscribers'",
      [f.page.id],
    );

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalledTimes(2);
    expect(await currentIds(f.page.id)).toEqual([]);
    const checkpoint = await getCheckpoint(f.app.db, f.page.id, "subscribers");
    expect(checkpoint?.cursorLastSucceededRunId).toBe(result.runId);
    expect(checkpoint?.state).toMatchObject({ revision: REQUEST_SEQ, generation: 4122, pageCount: 1 });
    const walkStartedAt = (checkpoint?.state as { walkStartedAt?: string } | null)?.walkStartedAt;
    expect(Date.parse(walkStartedAt ?? "")).toBeGreaterThan(Date.parse(LILLY_ENDS_AT));
    const state = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(state).toMatchObject({ consecutiveFailures: 0, lastErrorSummary: null, retryAt: null });
    expect(state?.appliedSeq).toBe(REQUEST_SEQ);
    expect(await incidentStatus(f.key)).toBe("resolved");
    expect(await anomalies(result.runId!)).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps an already-empty page successfully empty", async () => {
    const f = await fixture({ subscriptions: [], serve: statedEmpty });

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(await subscriptions(f.page.id)).toEqual([]);
    expect((await getCheckpoint(f.app.db, f.page.id, "subscribers"))?.cursorLastSucceededRunId).toBe(result.runId);
    expect(await getPageSyncState(f.app.db, f.page.id, "subscribers")).toMatchObject({ consecutiveFailures: 0 });
    expect(await incidentStatus(f.key)).toBe("resolved");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each([
    {
      name: "more current subscriptions than a stated zero may retire on its own",
      subscriptions: ["a", "b", "c", "d", "e", "f"].map(lapsed),
      reason: "too_many_current",
    },
    {
      name: "a subscription that has not yet lapsed",
      subscriptions: [lapsed("lapsed"), { id: "future", endsAt: "2099-01-01T00:00:00.000Z", autoRenew: false }],
      reason: "not_known_lapsed",
    },
    {
      name: "a subscription with no known end",
      subscriptions: [{ id: "unknown-end", endsAt: null, autoRenew: false }],
      reason: "not_known_lapsed",
    },
    {
      name: "a lapsed subscription set to auto-renew",
      subscriptions: [{ id: "renewing", endsAt: LILLY_ENDS_AT, autoRenew: true }],
      reason: "not_known_lapsed",
    },
    {
      name: "a lapsed subscription with unknown auto-renew",
      subscriptions: [{ id: "renew-unknown", endsAt: LILLY_ENDS_AT, autoRenew: null }],
      reason: "not_known_lapsed",
    },
  ])("refuses a stated zero over $name", async ({ subscriptions: seeded, reason }) => {
    const f = await fixture({ subscriptions: seeded, serve: statedEmpty });
    const before = await currentIds(f.page.id);

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result.kind).not.toBe("success");
    expect(await currentIds(f.page.id)).toEqual(before);
    expect(await anomalies(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_first_page_guard", reason, existingCurrentSubscribers: seeded.length,
    })]);
    const state = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(state).toMatchObject({ consecutiveFailures: 16, lastErrorSummary: REFUSAL });
    expect(state?.appliedSeq).toBe(REQUEST_SEQ - 1);
    expect((await getCheckpoint(f.app.db, f.page.id, "subscribers"))?.cursorLastSucceededRunId).toBeNull();
    expect(await incidentStatus(f.key)).toBe("open");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each([
    { name: "no contract verdict", page: { ...statedEmpty(), contractAccepted: undefined }, error: REFUSAL },
    { name: "a positive total", page: { ...statedEmpty(), total: 1, done: true }, error: REFUSAL },
    { name: "no total", page: { ...statedEmpty(), total: null }, error: REFUSAL },
    {
      name: "a rejected contract",
      page: { ...statedEmpty(), total: null, contractAccepted: false },
      error: "Fansly subscribers response contract rejected; captured before refusal",
    },
  ])("keeps the guard on an empty page with $name, even with the account counter at zero", async ({ page, error }) => {
    const f = await fixture({ subscriptions: [lapsed("889566")], serve: () => page });
    // The counter only confirms a zero the provider states; it never stands in for one.
    await setAccountCounter(f.page.id, 0, minutesAgo(10));

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result.kind).not.toBe("success");
    expect(await currentIds(f.page.id)).toEqual(["889566"]);
    expect(await getPageSyncState(f.app.db, f.page.id, "subscribers"))
      .toMatchObject({ consecutiveFailures: 16, lastErrorSummary: error });
    if (error === REFUSAL) {
      expect(await anomalies(result.runId!)).toContainEqual(expect.objectContaining({
        code: "subscribers_empty_first_page_guard", reason: "zero_not_stated", existingCurrentSubscribers: 1,
      }));
    }
    expect(await incidentStatus(f.key)).toBe("open");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("retires every unseen current subscription when a fresh zero account counter confirms a stated zero", async () => {
    const f = await fixture({ subscriptions: UNEXPLAINED_SIX, serve: statedEmpty });
    const verifiedAt = await setAccountCounter(f.page.id, 0, minutesAgo(90));

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(f.getSubscribersPage).toHaveBeenCalledTimes(1);
    expect(await currentIds(f.page.id)).toEqual([]);
    const fanPages = await db.pool.query<{ is_subscriber: boolean }>(
      "select is_subscriber from page_fans where platform_account_id=$1",
      [f.page.id],
    );
    expect(fanPages.rows).toHaveLength(6);
    expect(fanPages.rows.every((row) => row.is_subscriber === false)).toBe(true);

    const checkpoint = await getCheckpoint(f.app.db, f.page.id, "subscribers");
    expect(checkpoint?.cursorLastSucceededRunId).toBe(result.runId);
    expect(checkpoint?.state).toMatchObject({
      revision: REQUEST_SEQ, generation: 4122, mode: "active", pageCount: 1, providerReportedTotal: 0,
      historyBackfilledAt: LILLY_HISTORY_BACKFILLED_AT,
    });
    expect(checkpoint?.state).not.toHaveProperty("destructiveFinalization");
    const state = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(state).toMatchObject({ consecutiveFailures: 0, lastErrorSummary: null, retryAt: null });
    expect(state?.appliedSeq).toBe(REQUEST_SEQ);
    expect(await incidentStatus(f.key)).toBe("resolved");
    expect(await anomalies(result.runId!)).toEqual([]);
    expect(await emptySnapshotNotes(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_snapshot_confirmed_by_counter",
      generation: 4122,
      retiredCount: 6,
      subscriberCount: 0,
      lastVerifiedAt: verifiedAt!.toISOString(),
    })]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("retires lilly-2's renewing subscription once its account counter reads zero", async () => {
    const f = await fixture({ subscriptions: [LILLY_2_RENEWING], serve: statedEmpty });
    await setAccountCounter(f.page.id, 0, minutesAgo(20));

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(await currentIds(f.page.id)).toEqual([]);
    expect(await getPageSyncState(f.app.db, f.page.id, "subscribers")).toMatchObject({ consecutiveFailures: 0 });
    expect(await incidentStatus(f.key)).toBe("resolved");
    expect(await emptySnapshotNotes(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_snapshot_confirmed_by_counter", retiredCount: 1, subscriberCount: 0,
    })]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.each([
    {
      name: "the account counter still reads one (lilly-2 until the counter catches up)",
      subscriptions: [LILLY_2_RENEWING], subscriberCount: 1, verifiedAt: () => minutesAgo(20),
      reason: "not_known_lapsed",
    },
    {
      name: "the zero counter was verified more than two hours before the walk",
      subscriptions: UNEXPLAINED_SIX, subscriberCount: 0, verifiedAt: () => minutesAgo(125),
      reason: "too_many_current",
    },
    {
      name: "the counter is null",
      subscriptions: UNEXPLAINED_SIX, subscriberCount: null, verifiedAt: () => minutesAgo(20),
      reason: "too_many_current",
    },
    {
      name: "the zero counter was never verified",
      subscriptions: [LILLY_2_RENEWING], subscriberCount: 0, verifiedAt: () => null,
      reason: "not_known_lapsed",
    },
  ])("refuses a stated zero when $name", async ({ subscriptions: seeded, subscriberCount, verifiedAt, reason }) => {
    const f = await fixture({ subscriptions: seeded, serve: statedEmpty });
    const counterVerifiedAt = await setAccountCounter(f.page.id, subscriberCount, verifiedAt());
    const before = await currentIds(f.page.id);

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result.kind).not.toBe("success");
    expect(await currentIds(f.page.id)).toEqual(before);
    expect(await anomalies(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_first_page_guard", reason, existingCurrentSubscribers: seeded.length,
      subscriberCount, lastVerifiedAt: counterVerifiedAt?.toISOString() ?? null,
    })]);
    expect(await emptySnapshotNotes(result.runId!)).toEqual([]);
    const state = await getPageSyncState(f.app.db, f.page.id, "subscribers");
    expect(state).toMatchObject({ consecutiveFailures: 16, lastErrorSummary: REFUSAL });
    expect(state?.appliedSeq).toBe(REQUEST_SEQ - 1);
    expect((await getCheckpoint(f.app.db, f.page.id, "subscribers"))?.cursorLastSucceededRunId).toBeNull();
    expect(await incidentStatus(f.key)).toBe("open");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // Review of #321: the rule reads the counter as fresh by last_verified_at,
  // which every /account/me refresh advances. Drizzle skips an undefined
  // column, so an /account/me without subscriberCount used to keep the last 0
  // looking fresh forever and confirm the next stated zero with no pause.
  it("refuses a stated zero after /account/me stops reporting the counter", async () => {
    const f = await fixture({
      subscriptions: [LILLY_2_RENEWING],
      serve: statedEmpty,
      accountMe: {
        id: "acct-lilly-1", username: "lilly1", displayName: null, createdAt: 1_700_000_000_000, followCount: 10,
      },
    });
    await setAccountCounter(f.page.id, 0, minutesAgo(180));
    const pageContext = await resolvePageContextById(f.app, f.page.id) as ResolvedFanslyPageContext;
    await refreshPageMetadata(f.app, pageContext, "light");
    const refreshed = await db.pool.query<{ subscriber_count: number | null; last_verified_at: Date | null }>(
      "select subscriber_count, last_verified_at from pages where id=$1",
      [f.page.id],
    );
    expect(refreshed.rows[0]?.subscriber_count).toBeNull();
    expect(refreshed.rows[0]?.last_verified_at?.getTime()).toBeGreaterThan(minutesAgo(5).getTime());

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result.kind).not.toBe("success");
    expect(await currentIds(f.page.id)).toEqual([LILLY_2_RENEWING.id]);
    expect(await anomalies(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_first_page_guard", reason: "not_known_lapsed", subscriberCount: null,
    })]);
    expect(await incidentStatus(f.key)).toBe("open");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("spares rows touched during a stated-empty walk the account counter confirms", async () => {
    let touchMidWalk: () => Promise<void> = async () => {};
    const f = await fixture({
      subscriptions: [renewing("stale"), renewing("touched")],
      serve: async () => {
        await touchMidWalk();
        return statedEmpty();
      },
    });
    await setAccountCounter(f.page.id, 0, minutesAgo(30));
    touchMidWalk = async () => {
      const [fan] = await upsertFans(f.app.db, [{ platform: "fansly", platformUserId: "fan-touched" }]);
      await upsertPageSubscription(f.app.db, {
        platformSubscriptionId: "touched", platformAccountId: f.page.id, fanId: fan!.id,
        rawStatus: 3, canonicalStatus: "active", priceMills: 5000n, renewPriceMills: 5000n,
        autoRenew: true, endsAt: new Date("2099-01-01T00:00:00.000Z"), lastSeenGeneration: 4121,
      });
    };

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(await currentIds(f.page.id)).toEqual(["touched"]);
    expect(await emptySnapshotNotes(result.runId!)).toEqual([expect.objectContaining({
      code: "subscribers_empty_snapshot_confirmed_by_counter", retiredCount: 1,
    })]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("spares rows a concurrent writer touches during a stated-empty walk", async () => {
    let touchMidWalk: () => Promise<void> = async () => {};
    const f = await fixture({
      subscriptions: [lapsed("stale"), lapsed("touched")],
      serve: async () => {
        await touchMidWalk();
        return statedEmpty();
      },
    });
    touchMidWalk = async () => {
      const [fan] = await upsertFans(f.app.db, [{ platform: "fansly", platformUserId: "fan-touched" }]);
      await upsertPageSubscription(f.app.db, {
        platformSubscriptionId: "touched", platformAccountId: f.page.id, fanId: fan!.id,
        rawStatus: 3, canonicalStatus: "active", priceMills: 5000n, renewPriceMills: 5000n,
        autoRenew: false, endsAt: new Date(LILLY_ENDS_AT), lastSeenGeneration: 4121,
      });
    };

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(await currentIds(f.page.id)).toEqual(["touched"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("spares rows refreshed or inserted during a non-empty walk at finalization", async () => {
    let touchMidWalk: () => Promise<void> = async () => {};
    const f = await fixture({
      subscriptions: [
        { id: "stale", endsAt: "2099-01-01T00:00:00.000Z", autoRenew: true },
        { id: "refreshed", endsAt: "2099-01-01T00:00:00.000Z", autoRenew: true },
      ],
      serve: async () => {
        await touchMidWalk();
        return { total: 1, items: [activeItem("served")], offset: 0, done: true, contractAccepted: true, raw: {} };
      },
    });
    touchMidWalk = async () => {
      for (const id of ["refreshed", "inserted"]) {
        const [fan] = await upsertFans(f.app.db, [{ platform: "fansly", platformUserId: `fan-${id}` }]);
        await upsertPageSubscription(f.app.db, {
          platformSubscriptionId: id, platformAccountId: f.page.id, fanId: fan!.id,
          rawStatus: 3, canonicalStatus: "active", priceMills: 5000n, renewPriceMills: 5000n,
          autoRenew: true, endsAt: new Date("2099-01-01T00:00:00.000Z"),
          lastSeenGeneration: id === "refreshed" ? 4121 : null,
        });
      }
    };

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    // Only the row neither served nor touched since the walk began retires.
    expect(await currentIds(f.page.id)).toEqual(["inserted", "refreshed", "served"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves an archive walk alone: no retirement, no guard, completion recorded", async () => {
    const f = await fixture({
      subscriptions: [{ id: "renewing", endsAt: "2099-01-01T00:00:00.000Z", autoRenew: true }],
      // A legacy cursor mid-archive: the walk-start fence is an active-walk concern.
      cursor: {
        mode: "expired", offset: 100, revision: REQUEST_SEQ, pageCount: 1, generation: 4122,
        observedCount: 100, historyBackfilledAt: null, providerReportedTotal: 100,
      },
      serve: () => ({ total: 100, items: [], offset: 100, done: true, contractAccepted: true, raw: {} }),
    });

    const result = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(result).toMatchObject({ kind: "success", stream: "subscribers" });
    expect(f.getSubscribersPage.mock.calls[0]?.[1]).toEqual({ limit: 100, offset: 100, status: "5" });
    expect(await currentIds(f.page.id)).toEqual(["renewing"]);
    expect(await anomalies(result.runId!)).toEqual([]);
    expect((await getCheckpoint(f.app.db, f.page.id, "subscribers"))?.state).toMatchObject({
      mode: "expired", historyBackfilledAt: expect.any(String),
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("assesses, locks and retires one exact candidate set", async () => {
    const f = await fixture({
      subscriptions: [
        lapsed("lapsed-a"),
        lapsed("lapsed-b"),
        { ...lapsed("touched"), lastSeenAt: "2026-09-29T12:00:00.000Z" },
        { ...lapsed("old-inactive") },
      ],
      serve: statedEmpty,
    });
    await db.pool.query(
      "update page_subscriptions set is_current=false where platform_account_id=$1 and platform_subscription_id='old-inactive'",
      [f.page.id],
    );
    const input = {
      platformAccountId: f.page.id, generation: 4122,
      walkStartedAt: new Date("2026-09-29T00:00:00.000Z"), maxRetirements: 5,
    };

    // Two candidates exceed a limit of one: nothing is written.
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, { ...input, maxRetirements: 1 }))
      .toEqual({ certified: false, reason: "too_many_current", currentCount: 3 });
    expect(await currentIds(f.page.id)).toEqual(["lapsed-a", "lapsed-b", "touched"]);

    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, input))
      .toEqual({ certified: true, retiredCount: 2, currentCount: 3 });
    expect(await currentIds(f.page.id)).toEqual(["touched"]);

    // A current row stamped by the walk's own generation contradicts the zero.
    await db.pool.query(
      "update page_subscriptions set last_seen_generation=4122 where platform_account_id=$1 and platform_subscription_id='touched'",
      [f.page.id],
    );
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, {
      ...input, walkStartedAt: new Date("2026-09-30T00:00:00.000Z"),
    })).toEqual({ certified: false, reason: "observed_by_walk", currentCount: 1 });
    expect(await currentIds(f.page.id)).toEqual(["touched"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lets only a fresh zero account counter retire the whole unexplained candidate set", async () => {
    const f = await fixture({
      subscriptions: [
        renewing("renewing-a"),
        renewing("renewing-b"),
        lapsed("lapsed"),
        { ...renewing("touched"), lastSeenAt: "2026-09-29T12:00:00.000Z" },
      ],
      serve: statedEmpty,
    });
    const lapsedRuleOnly = {
      platformAccountId: f.page.id, generation: 4122,
      walkStartedAt: new Date("2026-09-29T00:00:00.000Z"), maxRetirements: 5,
    };
    const input = { ...lapsedRuleOnly, counterVerifiedSince: new Date("2026-09-28T22:00:00.000Z") };
    const refused = { certified: false, reason: "not_known_lapsed", currentCount: 4 };

    // Without a counter bound the lapsed rule alone decides, as before.
    await setAccountCounter(f.page.id, 0, new Date("2026-09-28T23:00:00.000Z"));
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, lapsedRuleOnly)).toEqual(refused);

    await setAccountCounter(f.page.id, 1, new Date("2026-09-28T23:00:00.000Z"));
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, input)).toEqual({
      ...refused, counter: { subscriberCount: 1, lastVerifiedAt: new Date("2026-09-28T23:00:00.000Z") },
    });
    await setAccountCounter(f.page.id, 0, new Date("2026-09-28T21:59:59.999Z"));
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, input)).toEqual({
      ...refused, counter: { subscriberCount: 0, lastVerifiedAt: new Date("2026-09-28T21:59:59.999Z") },
    });
    expect(await currentIds(f.page.id)).toEqual(["lapsed", "renewing-a", "renewing-b", "touched"]);

    await setAccountCounter(f.page.id, 0, new Date("2026-09-28T22:00:00.000Z"));
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, input)).toEqual({
      certified: true, retiredCount: 3, currentCount: 4,
      counter: { subscriberCount: 0, lastVerifiedAt: new Date("2026-09-28T22:00:00.000Z") },
    });
    // The row touched since the walk began was never a candidate.
    expect(await currentIds(f.page.id)).toEqual(["touched"]);

    // The walk's own positive observation still refuses, counter or not.
    await db.pool.query(
      "update page_subscriptions set last_seen_generation=4122 where platform_account_id=$1 and platform_subscription_id='touched'",
      [f.page.id],
    );
    expect(await retireLapsedPageSubscriptionsForEmptySnapshot(f.app.db, {
      ...input, walkStartedAt: new Date("2026-09-30T00:00:00.000Z"),
    })).toEqual({ certified: false, reason: "observed_by_walk", currentCount: 1 });
    expect(await currentIds(f.page.id)).toEqual(["touched"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
