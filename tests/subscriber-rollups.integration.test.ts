import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  deactivatePageSubscriptionsByGeneration,
  rebuildSubscriberRollups,
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
