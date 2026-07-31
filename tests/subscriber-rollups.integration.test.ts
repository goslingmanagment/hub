import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  deactivatePageSubscriptionsByGeneration,
  rebuildSubscriberRollups,
  upsertArchivedPageSubscriptions,
  upsertFans,
  upsertPageSubscription,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

const DAY_MS = 86_400_000;
const utcDate = (at: Date) => at.toISOString().slice(0, 10);

// Review finding (P2): rebuildSubscriberRollups recomputes the FULL history
// after every subscribers sweep, and gating the active window on
// is_current=true made each churned fan drop out of every PAST day too —
// historical daily actives decayed toward "never-churned subs only". Retired
// rows must count through their effective end: least(ends_at, last_seen_at),
// where last_seen_at is the retirement stamp (deactivate sets it; retired
// rows are never touched again).
//
// Known residual, inherent to the one-row-per-platform_subscription_id
// projection: a churn→re-subscribe on the SAME subscription id collapses to
// the latest window — that history is not recoverable from this table.
describe("subscriber rollups", () => {
  it("updates inactive archive rows without overwriting active subscriptions", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "archive-model",
        name: "Archive Model",
      });
      if (!model) {
        throw new Error("Expected the model to be created");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "archive-page",
      });
      if (!page) {
        throw new Error("Expected the page to be created");
      }
      const [activeFan, inactiveFan] = await upsertFans(testDb.db, [
        { platform: "fansly", platformUserId: "archive-active-fan" },
        { platform: "fansly", platformUserId: "archive-inactive-fan" },
      ]);
      if (!activeFan || !inactiveFan) {
        throw new Error("Expected both fans to be created");
      }

      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: "archive-active-sub",
        platformAccountId: page.id,
        fanId: activeFan.id,
        platformHistoryId: "active-history",
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 7000n,
        renewPriceMills: 7000n,
        autoRenew: true,
        lastSeenGeneration: 10,
      });
      await upsertArchivedPageSubscriptions(testDb.db, [{
        platformSubscriptionId: "archive-inactive-sub",
        platformAccountId: page.id,
        fanId: inactiveFan.id,
        platformHistoryId: "inactive-history-old",
        rawStatus: 5,
        canonicalStatus: "expired",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        autoRenew: false,
        lastSeenGeneration: 10,
      }]);

      await upsertArchivedPageSubscriptions(testDb.db, [
        {
          platformSubscriptionId: "archive-active-sub",
          platformAccountId: page.id,
          fanId: activeFan.id,
          platformHistoryId: "stale-expired-history",
          rawStatus: 5,
          canonicalStatus: "expired",
          priceMills: 9000n,
          renewPriceMills: 9000n,
          autoRenew: false,
          lastSeenGeneration: 12,
        },
        {
          platformSubscriptionId: "archive-inactive-sub",
          platformAccountId: page.id,
          fanId: inactiveFan.id,
          platformHistoryId: "inactive-history-new",
          rawStatus: 5,
          canonicalStatus: "expired",
          priceMills: 9000n,
          renewPriceMills: 9000n,
          autoRenew: false,
          lastSeenGeneration: 12,
        },
      ]);

      const rows = await testDb.pool.query<{
        platform_subscription_id: string;
        platform_history_id: string | null;
        raw_status: number;
        canonical_status: string;
        price_mills: string;
        is_current: boolean;
        last_seen_generation: string | null;
      }>(
        `select platform_subscription_id,
                platform_history_id,
                raw_status,
                canonical_status,
                price_mills::text,
                is_current,
                last_seen_generation::text
         from page_subscriptions
         where platform_account_id = $1
         order by platform_subscription_id`,
        [page.id],
      );

      expect(rows.rows).toEqual([
        {
          platform_subscription_id: "archive-active-sub",
          platform_history_id: "active-history",
          raw_status: 3,
          canonical_status: "active",
          price_mills: "7000",
          is_current: true,
          last_seen_generation: "10",
        },
        {
          platform_subscription_id: "archive-inactive-sub",
          platform_history_id: "inactive-history-new",
          raw_status: 5,
          canonical_status: "expired",
          price_mills: "9000",
          is_current: false,
          last_seen_generation: "12",
        },
      ]);
    } finally {
      await testDb.stop();
    }
  }, 60_000);

  it("keeps the original retirement boundary when archive metadata is refreshed", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "archive-retirement-model",
        name: "Archive Retirement Model",
      });
      if (!model) {
        throw new Error("Expected the model to be created");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "archive-retirement-page",
      });
      if (!page) {
        throw new Error("Expected the page to be created");
      }
      const [fan] = await upsertFans(testDb.db, [{
        platform: "fansly",
        platformUserId: "archive-retirement-fan",
      }]);
      if (!fan) {
        throw new Error("Expected the fan to be created");
      }

      const now = Date.now();
      const startedAt = new Date(now - 10 * DAY_MS);
      const retiredAt = new Date(now - 5 * DAY_MS);
      const futureEnd = new Date(now + 5 * DAY_MS);
      const input = {
        platformSubscriptionId: "archive-retirement-sub",
        platformAccountId: page.id,
        fanId: fan.id,
        rawStatus: 5,
        canonicalStatus: "expired",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        sourceCreatedAt: startedAt,
        endsAt: futureEnd,
        lastSeenGeneration: 1,
      };
      await upsertArchivedPageSubscriptions(testDb.db, [input]);
      await testDb.pool.query(
        `update page_subscriptions
         set last_seen_at = $2
         where platform_account_id = $1`,
        [page.id, retiredAt],
      );

      await upsertArchivedPageSubscriptions(testDb.db, [{
        ...input,
        priceMills: 9000n,
        lastSeenGeneration: 2,
      }]);
      await rebuildSubscriberRollups(testDb.db, page.id);

      const subscription = await testDb.pool.query<{
        last_seen_at: Date;
        price_mills: string;
      }>(
        `select last_seen_at, price_mills::text
         from page_subscriptions
         where platform_account_id = $1`,
        [page.id],
      );
      expect(subscription.rows[0]?.last_seen_at.toISOString())
        .toBe(retiredAt.toISOString());
      expect(subscription.rows[0]?.price_mills).toBe("9000");

      const dayAfterRetirement = new Date(retiredAt.getTime() + DAY_MS);
      const rollup = await testDb.pool.query<{ active_subscribers: number }>(
        `select active_subscribers::int as active_subscribers
         from daily_subscribers
         where platform_account_id = $1
           and business_date = $2::date`,
        [page.id, utcDate(dayAfterRetirement)],
      );
      expect(rollup.rows[0]?.active_subscribers).toBe(0);
    } finally {
      await testDb.stop();
    }
  }, 60_000);

  it("keeps historical active counts for retired subscriptions (no retroactive decay)", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "rollup-model",
        name: "Rollup Model",
      });
      if (!model) {
        throw new Error("Expected the model to be created");
      }
      const page = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "rollup-page",
      });
      if (!page) {
        throw new Error("Expected the page to be created");
      }
      const [fanA, fanB, fanC] = await upsertFans(testDb.db, [
        { platform: "fansly", platformUserId: "rollup-fan-a" },
        { platform: "fansly", platformUserId: "rollup-fan-b" },
        { platform: "fansly", platformUserId: "rollup-fan-c" },
      ]);
      if (!fanA || !fanB || !fanC) {
        throw new Error("Expected three fans to be created");
      }

      const now = Date.now();
      const start = new Date(now - 10 * DAY_MS);
      const naturalEnd = new Date(now - 5 * DAY_MS);
      const futureEnd = new Date(now + 5 * DAY_MS);

      // A: subscribed 10d ago, window naturally ended 5d ago, retired by a
      // later sweep (natural expiry — retirement lags ends_at).
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: "rollup-sub-a",
        platformAccountId: page.id,
        fanId: fanA.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        sourceCreatedAt: start,
        endsAt: naturalEnd,
        lastSeenGeneration: 1,
      });
      // B: subscribed 10d ago, ends_at still in the future, cancelled early
      // (retirement today is the truth, not ends_at).
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: "rollup-sub-b",
        platformAccountId: page.id,
        fanId: fanB.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        sourceCreatedAt: start,
        endsAt: futureEnd,
        lastSeenGeneration: 1,
      });
      // C: still current, open-ended (null ends_at) — counts start..today.
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: "rollup-sub-c",
        platformAccountId: page.id,
        fanId: fanC.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        sourceCreatedAt: start,
        lastSeenGeneration: 2,
      });

      // Sweep generation 2 retires A and B (is_current=false, last_seen_at=now()).
      await deactivatePageSubscriptionsByGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 2,
      });

      await rebuildSubscriberRollups(testDb.db, page.id);

      const rows = await testDb.pool.query(
        `select business_date::text as business_date,
                active_subscribers::int as active_subscribers,
                new_subscribers::int as new_subscribers
         from daily_subscribers
         where platform_account_id = $1
         order by business_date asc`,
        [page.id],
      );
      const byDate = new Map<string, { active_subscribers: number; new_subscribers: number }>(
        rows.rows.map((row) => [row.business_date as string, row]),
      );

      // Start day: all three subscribed — 3 new, 3 active. Before the fix the
      // two retired rows were excluded from EVERY day, so this read 1.
      expect(byDate.get(utcDate(start))).toMatchObject({
        active_subscribers: 3,
        new_subscribers: 3,
      });
      // A's last window day is still fully counted.
      expect(byDate.get(utcDate(naturalEnd))?.active_subscribers).toBe(3);
      // Day after A's window: A gone; B (not yet cancelled then) + C remain.
      expect(byDate.get(utcDate(new Date(naturalEnd.getTime() + DAY_MS)))?.active_subscribers).toBe(2);
      // Today: B counts through its retirement date (least of ends_at and
      // last_seen_at), C is current — early cancellation ends at the
      // retirement stamp, not at the still-future ends_at.
      expect(byDate.get(utcDate(new Date(now)))?.active_subscribers).toBe(2);
    } finally {
      await testDb.stop();
    }
  }, 60_000);
});
