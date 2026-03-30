import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listWorkboardActiveSpenders,
  listWorkboardInactiveSpenders,
  listWorkboardSnoozed,
  listWorkboardSubscribers,
  recalculateFanPageSpend,
  snoozeWorkboardFan,
  unsnoozeWorkboardFan,
  upsertFanPage,
  upsertFans,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createWorkboardPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

async function seedWorkboardScenario(testDb: StartedTestDatabase, pageId: number) {
  const [visibleSubscriber, snoozedSubscriber, activeSpender, inactiveSpender] = await upsertFans(testDb.db, [
    {
      platform: "fansly",
      platformUserId: "wb-subscriber-visible",
      username: "wb_subscriber_visible",
      displayName: "WB Subscriber Visible",
    },
    {
      platform: "fansly",
      platformUserId: "wb-subscriber-snoozed",
      username: "wb_subscriber_snoozed",
      displayName: "WB Subscriber Snoozed",
    },
    {
      platform: "fansly",
      platformUserId: "wb-active-spender",
      username: "wb_active_spender",
      displayName: "WB Active Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-inactive-spender",
      username: "wb_inactive_spender",
      displayName: "WB Inactive Spender",
    },
  ]);

  for (const [index, fan] of [visibleSubscriber, snoozedSubscriber].entries()) {
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: pageId,
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
      subscriptionExpiresAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      autoRenew: index === 0,
      pageAlias: index === 0 ? "Subscriber Visible Alias" : "Subscriber Snoozed Alias",
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: `wb-sub-${index + 1}`,
      platformAccountId: pageId,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: index === 0,
      sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
      endsAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      subscriptionTierName: "VIP",
    });
  }

  await upsertFanPage(testDb.db, {
    fanId: activeSpender.id,
    platformAccountId: pageId,
    pageAlias: "Active Spender Alias",
  });
  await upsertFanPage(testDb.db, {
    fanId: inactiveSpender.id,
    platformAccountId: pageId,
    pageAlias: "Inactive Spender Alias",
  });

  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    fanId: activeSpender.id,
    transactionId: "wb-active-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 125000n,
    sourceDestinationAmountMills: 125000n,
    creatorNetAmountMills: 125000n,
    occurredAt: new Date("2026-03-25T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    fanId: inactiveSpender.id,
    transactionId: "wb-inactive-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 140000n,
    sourceDestinationAmountMills: 140000n,
    creatorNetAmountMills: 140000n,
    occurredAt: new Date("2026-02-10T12:00:00.000Z"),
  });

  await recalculateFanPageSpend(testDb.db, pageId);

  return {
    visibleSubscriber,
    snoozedSubscriber,
    activeSpender,
    inactiveSpender,
  };
}

describe("workboard repository integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("keeps non-snoozed rows visible across all tabs when one fan is snoozed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-30T12:00:00.000Z");
    const page = await createWorkboardPage(testDb, "workboard-snooze-filter");
    const seeded = await seedWorkboardScenario(testDb, page.id);

    await snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
      days: 7,
    });

    const [subscribers, activeSpenders, inactiveSpenders, snoozed] = await Promise.all([
      listWorkboardSubscribers(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardActiveSpenders(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardInactiveSpenders(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardSnoozed(testDb.db, { platformAccountId: page.id }),
    ]);

    expect(subscribers.map((row) => row.fanId)).toEqual([seeded.visibleSubscriber.id]);
    expect(subscribers[0]?.subscriberSince?.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(subscribers[0]?.pageAlias).toBe("Subscriber Visible Alias");
    expect(activeSpenders.map((row) => row.fanId)).toEqual([seeded.activeSpender.id]);
    expect(activeSpenders[0]?.pageAlias).toBe("Active Spender Alias");
    expect(inactiveSpenders.map((row) => row.fanId)).toEqual([seeded.inactiveSpender.id]);
    expect(inactiveSpenders[0]?.pageAlias).toBe("Inactive Spender Alias");
    expect(snoozed.map((row) => row.fanId)).toEqual([seeded.snoozedSubscriber.id]);
    expect(snoozed[0]?.pageAlias).toBe("Subscriber Snoozed Alias");
  });

  it("restores the queue after unsnoozing a fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-30T12:00:00.000Z");
    const page = await createWorkboardPage(testDb, "workboard-unsnooze-roundtrip");
    const seeded = await seedWorkboardScenario(testDb, page.id);

    await snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
      days: 14,
    });
    await unsnoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
    });

    const [subscribers, snoozed] = await Promise.all([
      listWorkboardSubscribers(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardSnoozed(testDb.db, { platformAccountId: page.id }),
    ]);

    expect(subscribers.map((row) => row.fanId).sort((left, right) => left - right)).toEqual([
      seeded.visibleSubscriber.id,
      seeded.snoozedSubscriber.id,
    ].sort((left, right) => left - right));
    expect(snoozed).toHaveLength(0);
  });
});
