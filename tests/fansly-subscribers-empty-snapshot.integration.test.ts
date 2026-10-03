import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePageSyncStates, openNotificationIncidentWithRecoveryGuard,
  retireLapsedPageSubscriptionsForEmptySnapshot, upsertCheckpointProgress, upsertFanPages, upsertFans,
  upsertPageSubscription,
} from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
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
const statedEmpty = (): SubscribersPage => ({
  total: 0, items: [], offset: 0, done: true, contractAccepted: true,
  raw: { stats: { totalActive: 0, totalExpired: 50, total: 50 }, subscriptions: [] },
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

  /** Fansly's own /account/me subscriberCount, which the light and followers
   * streams write hourly together with last_verified_at. */
  async function setAccountCounter(pageId: number, subscriberCount: number | null, verifiedAt: Date | null) {
    await db.pool.query(
      "update pages set subscriber_count=$2, last_verified_at=$3 where id=$1",
      [pageId, subscriberCount, verifiedAt],
    );
    return verifiedAt;
  }

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
